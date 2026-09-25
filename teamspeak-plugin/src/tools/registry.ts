/**
 * The Sexton's realtime voice tools (PHA-3176).
 *
 * These are registered on the provider session as function tools and executed
 * here, in the plugin; the result goes back through `submitToolResult`, the
 * same path Discord uses for `openclaw_agent_consult`. Nothing in this file
 * talks to the provider directly.
 *
 * Two rules the descriptions encode:
 *  - Confirmations are short. The Plant's contempt for your taste in music is a
 *    persona matter (the agent's instructions), not a tool matter.
 *  - Every call is logged with its arguments, caller and duration, because when
 *    "Sexton, play some smooth jazz" does nothing the question is always which
 *    step was slow or silent.
 */
import type {
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import type { ChannelInfo, RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";
import {
  DEFAULT_CATCH_UP_LINES,
  DEFAULT_CATCH_UP_MAX_LINES,
  DEFAULT_SEXTON_LOG_DIR,
  type TeamSpeakToolsConfig,
} from "../config.js";
import type { TeamSpeakRealtimeToolRegistration } from "../voice/realtime-speaker-session.js";
import { readChannelLog, type ReadChannelLog } from "./catch-up.js";
import type { BandController } from "./band.js";
import { readSinger } from "./band-vibe.js";
import type { MusicController, MusicSourceKind } from "./music.js";

export const PLAY_MUSIC_TOOL = "play_music";
export const STOP_MUSIC_TOOL = "stop_music";
export const SET_VOLUME_TOOL = "set_volume";
export const WHAT_DID_I_MISS_TOOL = "what_did_i_miss";
export const WHO_IS_HERE_TOOL = "who_is_here";
export const POKE_TOOL = "poke";
export const LEAVE_VOICE_TOOL = "leave_voice";
export const JOIN_VOICE_TOOL = "join_voice";
export const COMPOSE_SONG_TOOL = "compose_song";
export const BAND_STATUS_TOOL = "band_status";
export const SONG_LYRICS_TOOL = "song_lyrics";
export const REPLAY_SONG_TOOL = "replay_song";
export const LIST_CHANNELS_TOOL = "list_channels";
export const MOVE_TO_CHANNEL_TOOL = "move_to_channel";
export const WHERE_IS_TOOL = "where_is";
export const SEND_TEXT_TOOL = "send_text";

// --- moderation (PHA-3786) --------------------------------------------------
export const KICK_CLIENT_TOOL = "kick_client";
export const BAN_CLIENT_TOOL = "ban_client";
export const UNBAN_CLIENT_TOOL = "unban_client";
export const LIST_BANS_TOOL = "list_bans";
export const MOVE_CLIENT_TOOL = "move_client";
export const MUTE_CLIENT_TOOL = "mute_client";
export const EDIT_CHANNEL_TOOL = "edit_channel";
export const CREATE_CHANNEL_TOOL = "create_channel";
export const DELETE_CHANNEL_TOOL = "delete_channel";
export const EDIT_SERVER_TOOL = "edit_server";
export const ADD_TO_SERVER_GROUP_TOOL = "add_to_server_group";

// --- music queue v2 (PHA-3785) ---------------------------------------------
export const NOW_PLAYING_TOOL = "now_playing";
export const SHOW_QUEUE_TOOL = "show_queue";
export const SKIP_TOOL = "skip";
export const REMOVE_FROM_QUEUE_TOOL = "remove_from_queue";
export const MOVE_IN_QUEUE_TOOL = "move_in_queue";
export const CLEAR_QUEUE_TOOL = "clear_queue";
export const SEARCH_MUSIC_TOOL = "search_music";
export const PLAY_SOURCE_TOOL = "play_source";
export const PAUSE_TOOL = "pause";
export const RESUME_TOOL = "resume";
export const SEEK_TOOL = "seek";

const MUSIC_SOURCE_KINDS: MusicSourceKind[] = [
  "youtube",
  "soundcloud",
  "bandcamp",
  "direct-url",
  "local",
  "band-library",
];

const MAX_CATCH_UP_MINUTES = 720;

export type TeamSpeakToolContext = {
  clientId: TeamSpeakClientId;
  nickname: string;
};

export type TeamSpeakToolDeps = {
  config: TeamSpeakToolsConfig | undefined;
  /** Undefined disables the music tools (no ffmpeg/yt-dlp in the image). */
  music: MusicController | undefined;
  /** Everyone the bridge currently sees in the channel, minus the bot itself. */
  roster: () => RosterEntry[];
  /** The channel the bridge is in; `what_did_i_miss` reads that channel's log. */
  channelName: () => string;
  poke: (clientId: TeamSpeakClientId, text: string) => void;
  /** Send a text message to the channel, the server, or one client. Also used for the moderation audit line (PHA-3786). */
  sendText: (target: "channel" | "server" | TeamSpeakClientId, text: string) => void;
  /**
   * Park/unpark the Sexton (PHA-3428, Brandon: "he can leave and join at will …
   * not everyone wants him sitting in all the time"). Parked means deaf and
   * mute: no listening, no speaking, no music. `!vc join`, `!vc leave` and the
   * two tools are the only things that still answer.
   */
  setParked: (parked: boolean, reason: string) => void;
  isParked: () => boolean;
  // --- moderation (PHA-3786) ------------------------------------------------
  kickClient: (clientId: TeamSpeakClientId, fromServer: boolean, reason?: string) => void;
  banClient: (clientId: TeamSpeakClientId, durationSecs?: number, reason?: string) => void;
  banDel: (banId: number) => void;
  banList: () => void;
  moveClient: (clientId: TeamSpeakClientId, channelId: number) => void;
  muteClient: (clientId: TeamSpeakClientId, muted: boolean) => void;
  editChannel: (channelId: number, name?: string, topic?: string) => void;
  createChannel: (name: string, parentId?: number) => void;
  deleteChannel: (channelId: number, force: boolean) => void;
  editServer: (name?: string, welcomeMessage?: string) => void;
  addToServerGroup: (serverGroupId: number, clientId: TeamSpeakClientId) => void;
  /**
   * The full channel tree — every channel with who is in it (PHA-3784).
   * Round-trips through the bridge (`ListChannels` / `ChannelTree`), so it is
   * async and can come back empty if the bridge does not answer in time.
   */
  listChannels: () => Promise<ChannelInfo[]>;
  /** Move the bot itself into a channel by name or numeric id. */
  moveToChannel: (channel: string) => void;
  /** The house band (PHA-3554). Undefined on an account that has not opted in. */
  band?: BandController | undefined;
  logDir: string;
  readLog?: ReadChannelLog | undefined;
  now?: (() => Date) | undefined;
  log?: ((message: string) => void) | undefined;
};

type ToolResult = Record<string, unknown> & { ok: boolean };

/**
 * Which moderation tool groups are actually usable (PHA-3786). Fails closed:
 * an empty/absent `allowGroups` disables every group regardless of the
 * per-action flags, since there would be nobody it is safe to run them for.
 */
function moderationOptions(config: TeamSpeakToolsConfig | undefined): {
  kick: boolean;
  ban: boolean;
  edit: boolean;
} {
  const moderation = config?.moderation;
  const hasAllowlist = (moderation?.allowGroups?.length ?? 0) > 0;
  return {
    kick: hasAllowlist && moderation?.kick === true,
    ban: hasAllowlist && moderation?.ban === true,
    edit: hasAllowlist && moderation?.edit === true,
  };
}

/** Build the `tools` list and the handler the speaker sessions register. */
export function createTeamSpeakToolRegistration(
  deps: TeamSpeakToolDeps,
): TeamSpeakRealtimeToolRegistration {
  return {
    tools: buildTeamSpeakTools({
      music: deps.music !== undefined,
      band: deps.band !== undefined,
      moderation: moderationOptions(deps.config),
    }),
    handle: (event, context) => runTeamSpeakTool(deps, event, context),
  };
}

export function buildTeamSpeakTools(options: {
  music: boolean;
  band?: boolean;
  moderation?: { kick: boolean; ban: boolean; edit: boolean };
}): RealtimeVoiceTool[] {
  const tools: RealtimeVoiceTool[] = [];
  if (options.music) {
    tools.push(
      {
        type: "function",
        name: PLAY_MUSIC_TOOL,
        description:
          "Play music into the TeamSpeak channel. Give either a search phrase or a direct URL. Music ducks automatically while anyone speaks. If something is already playing, this queues the request instead of interrupting it — the result tells you the queue position, so confirm with that (e.g. \"queued, you're third\") instead of announcing it as playing now. Confirm in a few words.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: 'What to play, as asked, for example "smooth jazz".',
            },
            url: {
              type: "string",
              description: "A direct http(s) link to play instead of searching.",
            },
          },
        },
      },
      {
        type: "function",
        name: STOP_MUSIC_TOOL,
        description:
          "Stop the music playing in the channel and clear anything queued behind it. Confirm in a few words.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SET_VOLUME_TOOL,
        description:
          "Set the music volume, 0 to 1, where 1 is full. This is the music lane only; it does not change your own speaking volume.",
        parameters: {
          type: "object",
          properties: {
            volume: { type: "number", description: "Volume between 0 and 1." },
          },
          required: ["volume"],
        },
      },
      {
        type: "function",
        name: NOW_PLAYING_TOOL,
        description: "What's currently playing: title, source, who requested it, and elapsed time.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SHOW_QUEUE_TOOL,
        description:
          "List what's queued up behind the current track, in order. Read-only — this never starts or changes playback. Read the list back as one summary, not one message per song.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SKIP_TOOL,
        description:
          "Skip the current track and move on to the next queued one, if any. Unlike stop_music, this does NOT clear the rest of the queue — it only advances past the current track. If nothing is queued, this just stops, same as stop_music.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: REMOVE_FROM_QUEUE_TOOL,
        description: "Remove one specific track from the queue by its id (from show_queue), without touching anything else queued or currently playing.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The track id, from show_queue." },
          },
          required: ["id"],
        },
      },
      {
        type: "function",
        name: MOVE_IN_QUEUE_TOOL,
        description: "Reorder one queued track to a new 1-based position in the queue.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The track id, from show_queue." },
            position: { type: "number", description: "New 1-based position in the queue." },
          },
          required: ["id", "position"],
        },
      },
      {
        type: "function",
        name: CLEAR_QUEUE_TOOL,
        description:
          "Empty the queue entirely, without stopping or skipping whatever is currently playing. Distinct from skip (which advances one track) and stop_music (which also stops playback).",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SEARCH_MUSIC_TOOL,
        description:
          "Search for music and get back a short list of candidates (title, id/url, duration, channel) to choose from. This NEVER plays anything by itself — follow up with play_source (or play_music) once a choice is made. Return the results as one structured list in your reply; do not narrate them as separate lines or read every result aloud.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            limit: { type: "number", description: "How many candidates to return, up to 10. Defaults to 5." },
          },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: PLAY_SOURCE_TOOL,
        description:
          "Play from an explicit source instead of a plain search. Sources: youtube, soundcloud, bandcamp, direct-url, local, band-library. bandcamp requires a direct url (no search). band-library may not be available on this Sexton. Queues behind what's already playing unless nothing is playing.",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: MUSIC_SOURCE_KINDS,
              description: "Which source to play from.",
            },
            query: { type: "string", description: "A search phrase, for sources that support search." },
            url: { type: "string", description: "A direct URL, for sources that need or accept one." },
            file: { type: "string", description: "A local file path, for the local source." },
          },
          required: ["source"],
        },
      },
      {
        type: "function",
        name: PAUSE_TOOL,
        description: "Pause the current track in place. Use resume to pick back up where it left off.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: RESUME_TOOL,
        description: "Resume a paused track from where it was paused.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SEEK_TOOL,
        description: "Jump to a specific timestamp in the current track.",
        parameters: {
          type: "object",
          properties: {
            seconds: { type: "number", description: "Timestamp to seek to, in seconds from the start." },
          },
          required: ["seconds"],
        },
      },
    );
  }
  tools.push(
    {
      type: "function",
      name: WHAT_DID_I_MISS_TOOL,
      description:
        "Read back the recent chat messages in this channel from the Sexton's log. Use it whenever someone asks what they missed or what was said. Read the messages out naturally; do not read timestamps unless asked.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description:
              "Only messages from the last N minutes. Omit for the most recent messages regardless of age.",
          },
        },
      },
    },
    {
      type: "function",
      name: WHO_IS_HERE_TOOL,
      description: "List who is currently in the TeamSpeak channel.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: POKE_TOOL,
      description:
        "Poke someone in the channel with a short text. A poke pops up on their screen, so keep it brief and only do it when asked.",
      parameters: {
        type: "object",
        properties: {
          nickname: { type: "string", description: "Who to poke, as their channel nickname." },
          text: { type: "string", description: "The short message to show them." },
        },
        required: ["nickname", "text"],
      },
    },
    {
      type: "function",
      name: LEAVE_VOICE_TOOL,
      description:
        "Leave voice and sit out. Use it when someone asks you to go, to shut up, to leave the channel, or to give them the room. You stop listening, stop speaking and stop any music until someone asks you back. Say one short goodbye before calling it; nothing you say after will be heard.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Who asked and why, in a few words. For the log only.",
          },
        },
      },
    },
    {
      type: "function",
      name: JOIN_VOICE_TOOL,
      description:
        "Come back into voice after sitting out. Use it when someone asks you to come back, rejoin, or start listening again. Confirm in a few words.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: LIST_CHANNELS_TOOL,
      description:
        "List every channel on the server and who is currently sitting in each one. Use this when someone asks what channels exist, who's around, or where people have gone — this sees the whole server, not just your own channel (that's who_is_here).",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: MOVE_TO_CHANNEL_TOOL,
      description:
        "Move yourself into a different channel. Give either `channel` (a name or numeric id) or `follow` (someone's nickname, to go wherever they currently are) — not both. Confirm in a few words once you're there.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "The channel to move into, by name or numeric id.",
          },
          follow: {
            type: "string",
            description: "Instead of `channel`: a nickname to follow into whatever channel they're in right now.",
          },
        },
      },
    },
    {
      type: "function",
      name: WHERE_IS_TOOL,
      description: "Find which channel a person is currently in, anywhere on the server.",
      parameters: {
        type: "object",
        properties: {
          nickname: { type: "string", description: "Who to look for, by their channel nickname." },
        },
        required: ["nickname"],
      },
    },
    {
      type: "function",
      name: SEND_TEXT_TOOL,
      description:
        "Send a text message instead of speaking it. Defaults to your own channel; set target to \"server\" for a server-wide message, or \"client\" with a nickname to message one person directly.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message to send." },
          target: {
            type: "string",
            enum: ["channel", "server", "client"],
            description: 'Where to send it. Defaults to "channel".',
          },
          nickname: {
            type: "string",
            description: 'Who to message. Required when target is "client".',
          },
        },
        required: ["text"],
      },
    },
  );
  if (options.band) {
    tools.push(
      {
        type: "function",
        name: COMPOSE_SONG_TOOL,
        description:
          "Start the house band on a new song. You are the composer: before calling this, settle the title, whether it has a singer, and — if it does — write the full lyrics yourself (verses, a chorus, a tag; name people in the room where it fits). If the request is too vague to compose from, ask ONE short question first instead of calling this. The band takes a minute or three to record: this returns immediately with the style it will play, and the band leader announces and starts the song on his own when it is ready. So after calling it, say one short line that the band is working on it and stop — do NOT announce the song yourself, do NOT read the style back, do NOT promise a time. One song at a time.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "The song's title, in your words." },
            brief: {
              type: "string",
              description:
                "What the room asked for and what the song is about, in one or two sentences. This is what the band's arrangement is read from.",
            },
            vocals: {
              type: "boolean",
              description: "true if it has a singer; false for an instrumental.",
            },
            singer: {
              type: "string",
              description:
                'Optional, only when vocals is true. "bexton" (default): you sing it, velvet baritone. "trixie": Trixie from the Velvet Vice takes the mic, female lead. Use trixie when the room asks for her, for a female voice, or when the song wants a woman\'s voice (a torch song, a waitress\'s side of the story, a duet answer).',
            },
            lyrics: {
              type: "string",
              description:
                "The full lyrics, required when vocals is true. Use [Verse], [Chorus], [Bridge], [Outro] section tags on their own lines.",
            },
            mood: {
              type: "string",
              description:
                "Optional. One of: mournful, celebration, menace, romance, drunk, jump, roast. Omit to let the band read it from the brief.",
            },
            dedicatedTo: {
              type: "string",
              description: "Optional. Who the song is for, if it is for someone in particular.",
            },
          },
          required: ["brief", "vocals"],
        },
      },
      {
        type: "function",
        name: BAND_STATUS_TOOL,
        description:
          "Where the band is: idle, still recording, what it last played, or why the last song failed. Use it when someone asks what is taking so long.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: SONG_LYRICS_TOOL,
        description:
          "Get the full lyrics of a song the band already played, so you can paste them into the chat or read them out verbatim. Defaults to the most recently played song; give a title, or part of one, to look up an older one. These are your own lyrics — when someone asks for them, use this tool and give back the complete text, not a summary or a paraphrase.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Optional. Which song, by title or part of the title. Omit for the last one played.",
            },
          },
        },
      },
      {
        type: "function",
        name: REPLAY_SONG_TOOL,
        description:
          "Play a song the band already recorded again, instead of writing a new one — for \"play that again\" or a request for something you played earlier tonight. Defaults to the most recently played song; give a title, or part of one, to bring back an older one. Refuses if the band is busy on something else or the recording is gone. After calling it, say one short line that you're bringing it back, then stop — the band leader announces and starts it himself.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Optional. Which song to bring back, by title or part of the title. Omit for the last one played.",
            },
          },
        },
      },
    );
  }
  if (options.moderation?.kick) {
    tools.push(
      {
        type: "function",
        name: KICK_CLIENT_TOOL,
        description:
          "Kick someone out of the channel or off the server entirely. Use sparingly — this is a moderation action, not a joke. Confirm in a few words once done.",
        parameters: {
          type: "object",
          properties: {
            nickname: { type: "string", description: "Who to kick." },
            fromServer: {
              type: "boolean",
              description: "true to remove them from the whole server, false (default) to just kick them from this channel.",
            },
            reason: { type: "string", description: "Optional reason shown to the kicked client." },
          },
          required: ["nickname"],
        },
      },
      {
        type: "function",
        name: MOVE_CLIENT_TOOL,
        description: "Move someone else into a different channel, against their will if need be. Confirm in a few words once done.",
        parameters: {
          type: "object",
          properties: {
            nickname: { type: "string", description: "Who to move." },
            channelId: {
              type: "number",
              description: "The numeric channel id to move them into. There is no channel-name lookup here yet — ask who_is_here or the roster for ids if you don't already have one.",
            },
          },
          required: ["nickname", "channelId"],
        },
      },
    );
  }
  if (options.moderation?.ban) {
    tools.push(
      {
        type: "function",
        name: BAN_CLIENT_TOOL,
        description: "Ban someone from the server. Confirm in a few words once done.",
        parameters: {
          type: "object",
          properties: {
            nickname: { type: "string", description: "Who to ban." },
            durationSecs: {
              type: "number",
              description: "Ban length in seconds. Omit for a permanent ban.",
            },
            reason: { type: "string", description: "Optional reason." },
          },
          required: ["nickname"],
        },
      },
      {
        type: "function",
        name: UNBAN_CLIENT_TOOL,
        description: "Remove one ban by its ban id (from list_bans).",
        parameters: {
          type: "object",
          properties: {
            banId: { type: "number", description: "The ban id to remove." },
          },
          required: ["banId"],
        },
      },
      {
        type: "function",
        name: LIST_BANS_TOOL,
        description:
          "Request the server's current ban list. Note: this asks the server for the list but the response is not parsed back into this conversation yet — say so if asked what came back.",
        parameters: { type: "object", properties: {} },
      },
    );
  }
  if (options.moderation?.edit) {
    tools.push(
      {
        type: "function",
        name: MUTE_CLIENT_TOOL,
        description:
          "Mute or unmute someone else's voice (via talk power, not a client-side mute — they will visibly lose/regain permission to talk). Confirm in a few words once done.",
        parameters: {
          type: "object",
          properties: {
            nickname: { type: "string", description: "Who to mute or unmute." },
            muted: { type: "boolean", description: "true to mute, false to unmute." },
          },
          required: ["nickname", "muted"],
        },
      },
      {
        type: "function",
        name: EDIT_CHANNEL_TOOL,
        description: "Rename a channel and/or change its topic.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "number", description: "The numeric id of the channel to edit." },
            name: { type: "string", description: "New name, if changing it." },
            topic: { type: "string", description: "New topic, if changing it." },
          },
          required: ["channelId"],
        },
      },
      {
        type: "function",
        name: CREATE_CHANNEL_TOOL,
        description: "Create a new channel.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the new channel." },
            parentId: { type: "number", description: "Optional numeric id of the parent channel." },
          },
          required: ["name"],
        },
      },
      {
        type: "function",
        name: DELETE_CHANNEL_TOOL,
        description: "Delete a channel.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "number", description: "The numeric id of the channel to delete." },
            force: {
              type: "boolean",
              description: "true to delete even if clients are still inside. Default false.",
            },
          },
          required: ["channelId"],
        },
      },
      {
        type: "function",
        name: EDIT_SERVER_TOOL,
        description: "Change the virtual server's name and/or welcome message.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "New server name, if changing it." },
            welcomeMessage: { type: "string", description: "New welcome message, if changing it." },
          },
        },
      },
      {
        type: "function",
        name: ADD_TO_SERVER_GROUP_TOOL,
        description: "Add someone to a server group, by the group's numeric id.",
        parameters: {
          type: "object",
          properties: {
            nickname: { type: "string", description: "Who to add." },
            serverGroupId: { type: "number", description: "The server group's numeric id." },
          },
          required: ["nickname", "serverGroupId"],
        },
      },
    );
  }
  return tools;
}

/** Execute one tool call. Never throws: a tool result is always produced. */
export async function runTeamSpeakTool(
  deps: TeamSpeakToolDeps,
  event: RealtimeVoiceToolCallEvent,
  context: TeamSpeakToolContext,
): Promise<ToolResult> {
  const started = Date.now();
  const args = readArgs(event.args);
  let result: ToolResult;
  try {
    result = await dispatch(deps, event.name, args, context);
  } catch (error) {
    result = { ok: false, error: describe(error) };
  }
  const elapsed = Date.now() - started;
  deps.log?.(
    `teamspeak tool: ${event.name} caller=${context.nickname}#${context.clientId} args=${compactJson(args)} ok=${result.ok}${result.ok ? "" : ` error="${String(result.error ?? "")}"`} ${elapsed}ms`,
  );
  return result;
}

async function dispatch(
  deps: TeamSpeakToolDeps,
  name: string,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): Promise<ToolResult> {
  switch (name) {
    case PLAY_MUSIC_TOOL:
      return await playMusic(deps, args);
    case STOP_MUSIC_TOOL:
      return stopMusic(deps);
    case SET_VOLUME_TOOL:
      return setVolume(deps, args);
    case NOW_PLAYING_TOOL:
      return nowPlaying(deps);
    case SHOW_QUEUE_TOOL:
      return showQueue(deps);
    case SKIP_TOOL:
      return skipTrack(deps);
    case REMOVE_FROM_QUEUE_TOOL:
      return removeFromQueue(deps, args);
    case MOVE_IN_QUEUE_TOOL:
      return moveInQueue(deps, args);
    case CLEAR_QUEUE_TOOL:
      return clearQueue(deps);
    case SEARCH_MUSIC_TOOL:
      return await searchMusic(deps, args);
    case PLAY_SOURCE_TOOL:
      return await playSource(deps, args, context);
    case PAUSE_TOOL:
      return pauseMusic(deps);
    case RESUME_TOOL:
      return resumeMusic(deps);
    case SEEK_TOOL:
      return await seekMusic(deps, args);
    case WHAT_DID_I_MISS_TOOL:
      return await whatDidIMiss(deps, args);
    case WHO_IS_HERE_TOOL:
      return whoIsHere(deps, context);
    case POKE_TOOL:
      return poke(deps, args, context);
    case LEAVE_VOICE_TOOL:
      return leaveVoice(deps, args, context);
    case JOIN_VOICE_TOOL:
      return joinVoice(deps, context);
    case COMPOSE_SONG_TOOL:
      return composeSong(deps, args, context);
    case BAND_STATUS_TOOL:
      return bandStatus(deps);
    case SONG_LYRICS_TOOL:
      return songLyrics(deps, args);
    case REPLAY_SONG_TOOL:
      return replaySong(deps, args, context);
    case KICK_CLIENT_TOOL:
      return kickClientTool(deps, args, context);
    case MOVE_CLIENT_TOOL:
      return moveClientTool(deps, args, context);
    case BAN_CLIENT_TOOL:
      return banClientTool(deps, args, context);
    case UNBAN_CLIENT_TOOL:
      return unbanClientTool(deps, args, context);
    case LIST_BANS_TOOL:
      return listBansTool(deps, context);
    case MUTE_CLIENT_TOOL:
      return muteClientTool(deps, args, context);
    case EDIT_CHANNEL_TOOL:
      return editChannelTool(deps, args, context);
    case CREATE_CHANNEL_TOOL:
      return createChannelTool(deps, args, context);
    case DELETE_CHANNEL_TOOL:
      return deleteChannelTool(deps, args, context);
    case EDIT_SERVER_TOOL:
      return editServerTool(deps, args, context);
    case ADD_TO_SERVER_GROUP_TOOL:
      return addToServerGroupTool(deps, args, context);
    case LIST_CHANNELS_TOOL:
      return await listChannelsTool(deps);
    case MOVE_TO_CHANNEL_TOOL:
      return await moveToChannel(deps, args, context);
    case WHERE_IS_TOOL:
      return await whereIs(deps, args, context);
    case SEND_TEXT_TOOL:
      return sendText(deps, args, context);
    default:
      return { ok: false, error: `Unknown TeamSpeak tool "${name}".` };
  }
}

// --- the house band (PHA-3554) -------------------------------------------------

function composeSong(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  const band = deps.band;
  if (!band) {
    return { ok: false, error: "There is no house band on this account." };
  }
  const brief = readString(args.brief);
  if (!brief) {
    return { ok: false, error: "Say what the song is about (brief)." };
  }
  const outcome = band.compose({
    title: readString(args.title),
    brief,
    vocals: readBoolean(args.vocals) ?? false,
    singer: readSinger(readString(args.singer)),
    lyrics: readString(args.lyrics),
    mood: readString(args.mood),
    dedicatedTo: readString(args.dedicatedTo),
    requestedBy: context.nickname,
  });
  if (!outcome.ok) {
    return { ok: false, error: outcome.error, band: outcome.status };
  }
  return {
    ok: true,
    status: "composing",
    title: outcome.title,
    mood: outcome.mood,
    style: outcome.style,
    // What the agent should do next, restated in the result because the tool
    // description is not always in front of the model when it reads this.
    next: "Say one short line that the band is working on it, then stop. The band leader will announce and start the song himself when it is ready.",
  };
}

function bandStatus(deps: TeamSpeakToolDeps): ToolResult {
  const band = deps.band;
  if (!band) {
    return { ok: false, error: "There is no house band on this account." };
  }
  return { ok: true, ...band.status() };
}

function songLyrics(deps: TeamSpeakToolDeps, args: Record<string, unknown>): ToolResult {
  const band = deps.band;
  if (!band) {
    return { ok: false, error: "There is no house band on this account." };
  }
  const outcome = band.lyrics(readString(args.title));
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, title: outcome.title, singer: outcome.singer, lyrics: outcome.lyrics };
}

function replaySong(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  const band = deps.band;
  if (!band) {
    return { ok: false, error: "There is no house band on this account." };
  }
  const outcome = band.replay({ titleQuery: readString(args.title), requestedBy: context.nickname });
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return {
    ok: true,
    status: "announcing",
    title: outcome.title,
    next: "Say one short line that you're bringing it back, then stop. The band leader will announce and start it himself.",
  };
}

async function playMusic(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const query = readString(args.query);
  const url = readString(args.url);
  if (!query && !url) {
    return { ok: false, error: "Nothing to play: give a search phrase or a URL." };
  }
  const track = await music.play({
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    enqueue: true,
  });
  if (track.queuedPosition !== undefined) {
    return {
      ok: true,
      queued: true,
      position: track.queuedPosition,
      title: track.title,
      request: track.request,
      volume: music.volume,
    };
  }
  return { ok: true, title: track.title, request: track.request, volume: music.volume };
}

function stopMusic(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const queuedBefore = music.queueLength;
  const wasPlaying = music.stop("stop_music");
  return {
    ok: true,
    stopped: wasPlaying,
    wasPlaying,
    ...(queuedBefore > 0 ? { queueCleared: queuedBefore } : {}),
  };
}

function setVolume(deps: TeamSpeakToolDeps, args: Record<string, unknown>): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const requested = readNumber(args.volume);
  if (requested === undefined) {
    return { ok: false, error: "Give a volume between 0 and 1." };
  }
  // A percentage is the likelier reading of "set the volume to 40" than 40x.
  const normalized = requested > 1 && requested <= 100 ? requested / 100 : requested;
  return { ok: true, volume: music.setVolume(normalized) };
}

// --- music queue v2 (PHA-3785) ---------------------------------------------

function nowPlaying(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const info = music.nowPlayingInfo();
  if (!info) {
    return { ok: true, playing: false };
  }
  return {
    ok: true,
    playing: true,
    title: info.track.title,
    source: info.track.isFile ? "file" : "stream",
    requestedBy: info.track.requestedBy,
    elapsedMs: info.elapsedMs,
    paused: info.paused,
  };
}

function showQueue(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const queue = music.listQueue();
  return {
    ok: true,
    count: queue.length,
    queue: queue.map((track, index) => ({
      position: index + 1,
      id: track.id,
      title: track.title,
      requestedBy: track.requestedBy,
    })),
  };
}

function skipTrack(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  if (!music.isPlaying) {
    return { ok: false, error: "Nothing is playing to skip." };
  }
  const next = music.skip();
  return next
    ? { ok: true, skipped: true, nowPlaying: next.title, remaining: music.queueLength }
    : { ok: true, skipped: true, nowPlaying: undefined, remaining: 0 };
}

function removeFromQueue(deps: TeamSpeakToolDeps, args: Record<string, unknown>): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const id = readString(args.id);
  if (!id) {
    return { ok: false, error: "Say which track to remove (id, from show_queue)." };
  }
  const removed = music.removeFromQueue(id);
  if (!removed) {
    return { ok: false, error: `No queued track with id "${id}".` };
  }
  return { ok: true, removed: removed.title, remaining: music.queueLength };
}

function moveInQueue(deps: TeamSpeakToolDeps, args: Record<string, unknown>): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const id = readString(args.id);
  const position = readNumber(args.position);
  if (!id || position === undefined) {
    return { ok: false, error: "Say which track (id) and the new position." };
  }
  try {
    const queue = music.moveInQueue(id, position);
    return {
      ok: true,
      queue: queue.map((track, index) => ({ position: index + 1, id: track.id, title: track.title })),
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function clearQueue(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const cleared = music.clearQueue();
  return { ok: true, cleared };
}

async function searchMusic(deps: TeamSpeakToolDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const query = readString(args.query);
  if (!query) {
    return { ok: false, error: "Say what to search for." };
  }
  const limit = readNumber(args.limit) ?? 5;
  try {
    const candidates = await music.search(query, limit);
    return {
      ok: true,
      count: candidates.length,
      candidates: candidates.map((candidate) => ({
        title: candidate.title,
        id: candidate.id,
        url: candidate.url,
        durationSeconds: candidate.durationSeconds,
        channel: candidate.channel,
      })),
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function playSource(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): Promise<ToolResult> {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const source = readString(args.source);
  if (!source) {
    return { ok: false, error: "Say which source: youtube, soundcloud, bandcamp, direct-url, local, or band-library." };
  }
  const query = readString(args.query);
  const url = readString(args.url);
  const file = readString(args.file);
  try {
    const track = await music.playSource({
      source: source as MusicSourceKind,
      ...(query ? { query } : {}),
      ...(url ? { url } : {}),
      ...(file ? { file } : {}),
      requestedBy: context.nickname,
      enqueue: true,
    });
    if (track.queuedPosition !== undefined) {
      return { ok: true, queued: true, position: track.queuedPosition, title: track.title, source };
    }
    return { ok: true, title: track.title, source };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function pauseMusic(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const paused = music.pause();
  return { ok: paused, paused, ...(paused ? {} : { error: "Nothing is playing, or it's already paused." }) };
}

function resumeMusic(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const resumed = music.resume();
  return { ok: resumed, resumed, ...(resumed ? {} : { error: "Nothing is paused." }) };
}

async function seekMusic(deps: TeamSpeakToolDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const seconds = readNumber(args.seconds);
  if (seconds === undefined) {
    return { ok: false, error: "Give a timestamp in seconds." };
  }
  try {
    const track = await music.seek(seconds);
    return { ok: true, title: track.title, seconds };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function whatDidIMiss(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const channelName = deps.channelName().trim();
  if (!channelName) {
    return { ok: false, error: "Not in a channel yet, so there is nothing logged." };
  }
  const config = deps.config;
  const maxLines = Math.max(1, config?.catchUpMaxLines ?? DEFAULT_CATCH_UP_MAX_LINES);
  const requestedMinutes = readNumber(args.minutes);
  const minutes =
    requestedMinutes === undefined || requestedMinutes <= 0
      ? undefined
      : Math.min(MAX_CATCH_UP_MINUTES, Math.round(requestedMinutes));
  const readLog = deps.readLog ?? readChannelLog;
  const result = await readLog({
    logDir: deps.logDir || DEFAULT_SEXTON_LOG_DIR,
    channelName,
    ...(minutes === undefined ? {} : { minutes }),
    limit: minutes === undefined ? Math.min(maxLines, config?.catchUpDefaultLines ?? DEFAULT_CATCH_UP_LINES) : maxLines,
    ...(deps.now ? { now: deps.now() } : {}),
  });
  if (result.entries.length === 0) {
    return {
      ok: true,
      channel: channelName,
      count: 0,
      messages: [],
      text: minutes === undefined
        ? `Nothing logged yet in ${channelName}.`
        : `Nothing said in ${channelName} in the last ${minutes} minutes.`,
      ...(minutes === undefined ? {} : { windowMinutes: minutes }),
    };
  }
  return {
    ok: true,
    channel: channelName,
    count: result.entries.length,
    messages: result.entries.map((entry) => ({
      time: entry.time,
      nickname: entry.nickname,
      text: entry.text,
    })),
    // The rendered lines are what the channel description shows, so what the
    // Sexton reads aloud and what a joiner sees are the same text.
    text: result.lines.join("\n"),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
  };
}

function whoIsHere(deps: TeamSpeakToolDeps, context: TeamSpeakToolContext): ToolResult {
  const roster = deps.roster();
  return {
    ok: true,
    channel: deps.channelName(),
    count: roster.length,
    people: roster.map((entry) => ({
      nickname: entry.nickname,
      muted: entry.muted,
      away: entry.away,
      isYou: entry.clientId === context.clientId,
    })),
  };
}

function poke(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  const nickname = readString(args.nickname);
  const text = readString(args.text);
  if (!nickname) {
    return { ok: false, error: "Who should I poke?" };
  }
  if (!text) {
    return { ok: false, error: "A poke needs some text." };
  }
  const roster = deps.roster();
  const match = matchNickname(roster, nickname, context);
  if (!match) {
    return {
      ok: false,
      error: `No one here is called "${nickname}".`,
      here: roster.map((entry) => entry.nickname),
    };
  }
  if (Array.isArray(match)) {
    return {
      ok: false,
      error: `"${nickname}" matches more than one person here.`,
      candidates: match,
    };
  }
  deps.poke(match.clientId, text);
  return { ok: true, nickname: match.nickname, clientId: match.clientId };
}

/**
 * Sit out.
 *
 * Parking does not mute the bridge: the agent's own goodbye is produced after
 * this tool returns, and muting here would swallow it. Deaf is enough — nothing
 * else will ever ask the Sexton to speak while it holds.
 */
function leaveVoice(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  const wasParked = deps.isParked();
  const reason = readString(args.reason);
  deps.setParked(true, `leave_voice:${context.nickname}${reason ? `:${reason}` : ""}`);
  return { ok: true, parked: true, wasParked, channel: deps.channelName() };
}

function joinVoice(deps: TeamSpeakToolDeps, context: TeamSpeakToolContext): ToolResult {
  const wasParked = deps.isParked();
  deps.setParked(false, `join_voice:${context.nickname}`);
  return { ok: true, parked: false, wasParked, channel: deps.channelName() };
}

// --- moderation (PHA-3786) --------------------------------------------------

/**
 * Is the invoking client in one of `allowGroups` (PHA-3786)? Case-insensitive
 * name match against `RosterEntry.serverGroups`, the Sexton's own report of
 * TeamSpeak server-group membership. Fails closed: no roster entry (caller
 * left the channel between the tool call and now, or an older bridge that
 * hasn't been rebuilt for PHA-3786 yet) or no configured `allowGroups` means
 * not authorized. This check runs again at dispatch time even though
 * `moderationOptions` already gates tool *registration* on `allowGroups`
 * being non-empty — registration only proves *some* group is configured, not
 * that *this* caller is in it.
 */
function isAuthorizedForModeration(deps: TeamSpeakToolDeps, context: TeamSpeakToolContext): boolean {
  const allowGroups = deps.config?.moderation?.allowGroups;
  if (!allowGroups || allowGroups.length === 0) {
    return false;
  }
  const caller = deps.roster().find((entry) => entry.clientId === context.clientId);
  if (!caller) {
    return false;
  }
  const wanted = new Set(allowGroups.map((g) => g.toLowerCase()));
  return (caller.serverGroups ?? []).some((g) => wanted.has(g.toLowerCase()));
}

const NOT_AUTHORIZED: ToolResult = { ok: false, error: "You don't have permission to do that." };

/** Audit line for a moderation action, sent to the channel so the external logger bot persists it (PHA-3786). */
function auditModeration(deps: TeamSpeakToolDeps, context: TeamSpeakToolContext, line: string): void {
  deps.sendText("channel", `[moderation] ${context.nickname}: ${line}`);
}

function resolveModerationTarget(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): RosterEntry | string[] | undefined {
  const nickname = readString(args.nickname);
  if (!nickname) {
    return undefined;
  }
  return matchNickname(deps.roster(), nickname, context);
}

function kickClientTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const target = resolveModerationTarget(deps, args, context);
  if (!target) {
    return { ok: false, error: "Who do you want to kick?" };
  }
  if (Array.isArray(target)) {
    return { ok: false, error: `That name matches more than one person.`, candidates: target };
  }
  const fromServer = readBoolean(args.fromServer) ?? false;
  const reason = readString(args.reason);
  deps.kickClient(target.clientId, fromServer, reason);
  auditModeration(
    deps,
    context,
    `kicked ${target.nickname} (${fromServer ? "server" : "channel"})${reason ? `: ${reason}` : ""}`,
  );
  return { ok: true, nickname: target.nickname, fromServer };
}

function moveClientTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const target = resolveModerationTarget(deps, args, context);
  if (!target) {
    return { ok: false, error: "Who do you want to move?" };
  }
  if (Array.isArray(target)) {
    return { ok: false, error: `That name matches more than one person.`, candidates: target };
  }
  const channelId = readNumber(args.channelId);
  if (channelId === undefined) {
    return { ok: false, error: "Give the numeric channel id to move them into." };
  }
  deps.moveClient(target.clientId, channelId);
  auditModeration(deps, context, `moved ${target.nickname} to channel ${channelId}`);
  return { ok: true, nickname: target.nickname, channelId };
}

function banClientTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const target = resolveModerationTarget(deps, args, context);
  if (!target) {
    return { ok: false, error: "Who do you want to ban?" };
  }
  if (Array.isArray(target)) {
    return { ok: false, error: `That name matches more than one person.`, candidates: target };
  }
  const durationSecs = readNumber(args.durationSecs);
  const reason = readString(args.reason);
  deps.banClient(target.clientId, durationSecs, reason);
  auditModeration(
    deps,
    context,
    `banned ${target.nickname}${durationSecs ? ` for ${durationSecs}s` : " (permanent)"}${reason ? `: ${reason}` : ""}`,
  );
  return { ok: true, nickname: target.nickname, durationSecs: durationSecs ?? null };
}

function unbanClientTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const banId = readNumber(args.banId);
  if (banId === undefined) {
    return { ok: false, error: "Give the ban id to remove (from list_bans)." };
  }
  deps.banDel(banId);
  auditModeration(deps, context, `removed ban ${banId}`);
  return { ok: true, banId };
}

function listBansTool(deps: TeamSpeakToolDeps, context: TeamSpeakToolContext): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  deps.banList();
  return {
    ok: true,
    note: "Requested the ban list from the server; the response is not parsed back into this conversation yet.",
  };
}

function muteClientTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const target = resolveModerationTarget(deps, args, context);
  if (!target) {
    return { ok: false, error: "Who do you want to mute or unmute?" };
  }
  if (Array.isArray(target)) {
    return { ok: false, error: `That name matches more than one person.`, candidates: target };
  }
  const muted = readBoolean(args.muted);
  if (muted === undefined) {
    return { ok: false, error: "Say whether to mute (true) or unmute (false)." };
  }
  deps.muteClient(target.clientId, muted);
  auditModeration(deps, context, `${muted ? "muted" : "unmuted"} ${target.nickname}`);
  return { ok: true, nickname: target.nickname, muted };
}

// --- channel and presence (PHA-3784) --------------------------------------

async function listChannelsTool(deps: TeamSpeakToolDeps): Promise<ToolResult> {
  const tree = await deps.listChannels();
  if (tree.length === 0) {
    return { ok: false, error: "Could not read the channel list right now." };
  }
  return {
    ok: true,
    count: tree.length,
    channels: tree.map((channel) => ({
      channelId: channel.channelId,
      name: channel.name,
      occupantCount: channel.occupants.length,
      occupants: channel.occupants.map((entry) => entry.nickname),
    })),
  };
}

async function moveToChannel(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): Promise<ToolResult> {
  const channelSpec = readString(args.channel);
  const follow = readString(args.follow);
  if (!channelSpec && !follow) {
    return { ok: false, error: "Give a channel (name or id) or someone to follow." };
  }
  const tree = await deps.listChannels();
  if (tree.length === 0) {
    return { ok: false, error: "Could not read the channel list right now." };
  }
  if (follow) {
    const match = matchNicknameAcrossTree(tree, follow, context);
    if (!match) {
      return { ok: false, error: `No one on the server is called "${follow}".` };
    }
    if (Array.isArray(match)) {
      return { ok: false, error: `"${follow}" matches more than one person.`, candidates: match };
    }
    deps.moveToChannel(String(match.channel.channelId));
    return {
      ok: true,
      channel: match.channel.name,
      channelId: match.channel.channelId,
      following: match.entry.nickname,
    };
  }
  const target = resolveChannelInTree(tree, channelSpec!);
  if (!target) {
    return {
      ok: false,
      error: `No channel named "${channelSpec}".`,
      channels: tree.map((channel) => channel.name),
    };
  }
  deps.moveToChannel(String(target.channelId));
  return { ok: true, channel: target.name, channelId: target.channelId };
}

async function whereIs(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): Promise<ToolResult> {
  const nickname = readString(args.nickname);
  if (!nickname) {
    return { ok: false, error: "Who do you want to find?" };
  }
  const tree = await deps.listChannels();
  if (tree.length === 0) {
    return { ok: false, error: "Could not read the channel list right now." };
  }
  const match = matchNicknameAcrossTree(tree, nickname, context);
  if (!match) {
    return { ok: false, error: `No one on the server is called "${nickname}".` };
  }
  if (Array.isArray(match)) {
    return { ok: false, error: `"${nickname}" matches more than one person.`, candidates: match };
  }
  return {
    ok: true,
    nickname: match.entry.nickname,
    channel: match.channel.name,
    channelId: match.channel.channelId,
  };
}

function editChannelTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const channelId = readNumber(args.channelId);
  if (channelId === undefined) {
    return { ok: false, error: "Give the numeric id of the channel to edit." };
  }
  const name = readString(args.name);
  const topic = readString(args.topic);
  if (!name && !topic) {
    return { ok: false, error: "Give a new name or topic to change." };
  }
  deps.editChannel(channelId, name, topic);
  auditModeration(deps, context, `edited channel ${channelId}`);
  return { ok: true, channelId, name: name ?? null, topic: topic ?? null };
}

function createChannelTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const name = readString(args.name);
  if (!name) {
    return { ok: false, error: "Give a name for the new channel." };
  }
  const parentId = readNumber(args.parentId);
  deps.createChannel(name, parentId);
  auditModeration(deps, context, `created channel ${JSON.stringify(name)}`);
  return { ok: true, name, parentId: parentId ?? null };
}

function deleteChannelTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const channelId = readNumber(args.channelId);
  if (channelId === undefined) {
    return { ok: false, error: "Give the numeric id of the channel to delete." };
  }
  const force = readBoolean(args.force) ?? false;
  deps.deleteChannel(channelId, force);
  auditModeration(deps, context, `deleted channel ${channelId}`);
  return { ok: true, channelId, force };
}

function editServerTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const name = readString(args.name);
  const welcomeMessage = readString(args.welcomeMessage);
  if (!name && !welcomeMessage) {
    return { ok: false, error: "Give a new name or welcome message to change." };
  }
  deps.editServer(name, welcomeMessage);
  auditModeration(deps, context, "edited server settings");
  return { ok: true, name: name ?? null, welcomeMessage: welcomeMessage ?? null };
}

function addToServerGroupTool(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  if (!isAuthorizedForModeration(deps, context)) {
    return NOT_AUTHORIZED;
  }
  const target = resolveModerationTarget(deps, args, context);
  if (!target) {
    return { ok: false, error: "Who do you want to add?" };
  }
  if (Array.isArray(target)) {
    return { ok: false, error: `That name matches more than one person.`, candidates: target };
  }
  const serverGroupId = readNumber(args.serverGroupId);
  if (serverGroupId === undefined) {
    return { ok: false, error: "Give the numeric server group id." };
  }
  deps.addToServerGroup(serverGroupId, target.clientId);
  auditModeration(deps, context, `added ${target.nickname} to server group ${serverGroupId}`);
  return { ok: true, nickname: target.nickname, serverGroupId };
}

function sendText(
  deps: TeamSpeakToolDeps,
  args: Record<string, unknown>,
  context: TeamSpeakToolContext,
): ToolResult {
  const text = readString(args.text);
  if (!text) {
    return { ok: false, error: "A text message needs some text." };
  }
  const target = readString(args.target) ?? "channel";
  if (target === "channel" || target === "server") {
    deps.sendText(target, text);
    return { ok: true, target };
  }
  if (target === "client") {
    const nickname = readString(args.nickname);
    if (!nickname) {
      return { ok: false, error: 'Say who to message (nickname) when target is "client".' };
    }
    const roster = deps.roster();
    const match = matchNickname(roster, nickname, context);
    if (!match) {
      return { ok: false, error: `No one here is called "${nickname}".` };
    }
    if (Array.isArray(match)) {
      return { ok: false, error: `"${nickname}" matches more than one person here.`, candidates: match };
    }
    deps.sendText(match.clientId, text);
    return { ok: true, target: "client", nickname: match.nickname };
  }
  return { ok: false, error: `Unknown target "${target}". Use "channel", "server", or "client".` };
}

/**
 * Resolve a `move_to_channel` spec the same way the Rust side's
 * `audio::resolve_channel_id` does: a bare number is tried as a channel id
 * first, then an exact case-insensitive name.
 */
function resolveChannelInTree(tree: ChannelInfo[], spec: string): ChannelInfo | undefined {
  const asId = Number(spec);
  if (Number.isInteger(asId) && String(asId) === spec.trim()) {
    const byId = tree.find((channel) => channel.channelId === asId);
    if (byId) {
      return byId;
    }
  }
  return tree.find((channel) => channel.name.toLowerCase() === spec.trim().toLowerCase());
}

/**
 * Same matching rules as `matchNickname`, but over every channel's occupants
 * instead of just the caller's own roster — `where_is` and `follow` need to
 * find someone who may not be anywhere near the bot.
 */
function matchNicknameAcrossTree(
  tree: ChannelInfo[],
  nickname: string,
  context: TeamSpeakToolContext,
): { entry: RosterEntry; channel: ChannelInfo } | string[] | undefined {
  const wanted = normalizeNickname(nickname);
  if (!wanted) {
    return undefined;
  }
  const all: Array<{ entry: RosterEntry; channel: ChannelInfo }> = tree.flatMap((channel) =>
    channel.occupants.map((entry) => ({ entry, channel })),
  );
  if (wanted === "me" || wanted === "myself") {
    const self = all.find((hit) => hit.entry.clientId === context.clientId);
    return self;
  }
  const exact = all.filter((hit) => normalizeNickname(hit.entry.nickname) === wanted);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return exact.map((hit) => hit.entry.nickname);
  }
  for (const test of [
    (candidate: string) => candidate.startsWith(wanted),
    (candidate: string) => candidate.includes(wanted),
  ]) {
    const hits = all.filter((hit) => test(normalizeNickname(hit.entry.nickname)));
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length > 1) {
      return hits.map((hit) => hit.entry.nickname);
    }
  }
  return undefined;
}

/**
 * Resolve a spoken nickname to a client. Exact (case-insensitive) first, then a
 * unique prefix, then a unique substring — transcripts drop clan tags and
 * punctuation, so "poke Brandon" has to find "[PHATT] Brandon_".
 * Returns the candidate list when the name is ambiguous rather than guessing.
 */
function matchNickname(
  roster: RosterEntry[],
  nickname: string,
  context: TeamSpeakToolContext,
): RosterEntry | string[] | undefined {
  const wanted = normalizeNickname(nickname);
  if (!wanted) {
    return undefined;
  }
  if (wanted === "me" || wanted === "myself") {
    return roster.find((entry) => entry.clientId === context.clientId);
  }
  const exact = roster.filter((entry) => normalizeNickname(entry.nickname) === wanted);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return exact.map((entry) => entry.nickname);
  }
  for (const test of [
    (candidate: string) => candidate.startsWith(wanted),
    (candidate: string) => candidate.includes(wanted),
  ]) {
    const hits = roster.filter((entry) => test(normalizeNickname(entry.nickname)));
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length > 1) {
      return hits.map((entry) => entry.nickname);
    }
  }
  return undefined;
}

function normalizeNickname(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** Providers hand tool arguments over as an object or as a JSON string. */
function readArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "unserializable";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
