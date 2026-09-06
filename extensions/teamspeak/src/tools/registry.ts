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
import type { RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";
import {
  DEFAULT_CATCH_UP_LINES,
  DEFAULT_CATCH_UP_MAX_LINES,
  DEFAULT_SEXTON_LOG_DIR,
  type TeamSpeakToolsConfig,
} from "../config.js";
import type { TeamSpeakRealtimeToolRegistration } from "../voice/realtime-speaker-session.js";
import { readChannelLog, type ReadChannelLog } from "./catch-up.js";
import type { MusicController } from "./music.js";

export const PLAY_MUSIC_TOOL = "play_music";
export const STOP_MUSIC_TOOL = "stop_music";
export const SET_VOLUME_TOOL = "set_volume";
export const WHAT_DID_I_MISS_TOOL = "what_did_i_miss";
export const WHO_IS_HERE_TOOL = "who_is_here";
export const POKE_TOOL = "poke";

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
  logDir: string;
  readLog?: ReadChannelLog | undefined;
  now?: (() => Date) | undefined;
  log?: ((message: string) => void) | undefined;
};

type ToolResult = Record<string, unknown> & { ok: boolean };

/** Build the `tools` list and the handler the speaker sessions register. */
export function createTeamSpeakToolRegistration(
  deps: TeamSpeakToolDeps,
): TeamSpeakRealtimeToolRegistration {
  return {
    tools: buildTeamSpeakTools({ music: deps.music !== undefined }),
    handle: (event, context) => runTeamSpeakTool(deps, event, context),
  };
}

export function buildTeamSpeakTools(options: { music: boolean }): RealtimeVoiceTool[] {
  const tools: RealtimeVoiceTool[] = [];
  if (options.music) {
    tools.push(
      {
        type: "function",
        name: PLAY_MUSIC_TOOL,
        description:
          "Play music into the TeamSpeak channel. Give either a search phrase or a direct URL. Music ducks automatically while anyone speaks. Confirm in a few words.",
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
        description: "Stop the music playing in the channel. Confirm in a few words.",
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
  );
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
    case WHAT_DID_I_MISS_TOOL:
      return await whatDidIMiss(deps, args);
    case WHO_IS_HERE_TOOL:
      return whoIsHere(deps, context);
    case POKE_TOOL:
      return poke(deps, args, context);
    default:
      return { ok: false, error: `Unknown TeamSpeak tool "${name}".` };
  }
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
  });
  return { ok: true, title: track.title, request: track.request, volume: music.volume };
}

function stopMusic(deps: TeamSpeakToolDeps): ToolResult {
  const music = deps.music;
  if (!music) {
    return { ok: false, error: "Music playback is not enabled on this Sexton." };
  }
  const wasPlaying = music.stop("stop_music");
  return { ok: true, stopped: wasPlaying, wasPlaying };
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
