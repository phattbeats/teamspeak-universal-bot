/**
 * TeamSpeak account config.
 *
 * The `voice` block deliberately uses the same key names and defaults as
 * Discord's (`src/config/types.discord.ts`: DiscordVoiceConfig /
 * DiscordVoiceRealtimeConfig) so an operator who has configured Discord voice
 * can copy the block across unchanged, and so upstreaming this plugin does not
 * introduce a second vocabulary for the same knobs.
 *
 * Keys Discord owns that have no TeamSpeak analogue (guild/channel ids, DAVE
 * encryption, autoJoin/followUsers by Discord user id) are replaced by their
 * TeamSpeak equivalents rather than carried over meaninglessly.
 */
import {
  MINIMAX_ASR_PROVIDER_ID,
  WHISPER_LOCAL_PROVIDER_ID,
  type ResolvedSttProviderConfig,
} from "./voice/stt-provider.js";

export type TeamSpeakVoiceMode = "stt-tts" | "agent-proxy" | "bidi";

export type TeamSpeakVoiceRealtimeToolPolicy = "safe-read-only" | "owner" | "none";

export type TeamSpeakVoiceRealtimeConsultPolicy = "auto" | "always";

export type TeamSpeakVoiceRealtimeBootstrapContextFile = "IDENTITY.md" | "USER.md" | "SOUL.md";

export type TeamSpeakVoiceAgentSessionConfig = {
  /** Which OpenClaw conversation should receive voice turns. Default: "voice". */
  mode?: "voice" | "target";
  /** TeamSpeak target used when mode is "target", for example "channel:1". */
  target?: string;
};

export type TeamSpeakVoiceRealtimeConfig = {
  /** Realtime voice provider id, for example "openai". */
  provider?: string;
  /** Provider realtime session model, for example "gpt-realtime-2.1". */
  model?: string;
  /** Provider realtime output voice name, for example "cedar". */
  speakerVoice?: string;
  /** Provider realtime output voice id. */
  speakerVoiceId?: string;
  /** System instructions passed to the realtime provider. */
  instructions?: string;
  /** Tool policy for realtime consult calls. */
  toolPolicy?: TeamSpeakVoiceRealtimeToolPolicy;
  /** Whether every substantive turn is forced through the OpenClaw agent brain. */
  consultPolicy?: TeamSpeakVoiceRealtimeConsultPolicy;
  /** Wake-name policy. Unset adapts to the room: off for one human, on for two or more. */
  requireWakeName?: boolean;
  /** Wake names that allow a response when the gate is active. Defaults to the routed agent name plus OpenClaw. */
  wakeNames?: string[];
  /** Exact hearings whisper is known to produce for the first wake name, accepted with no edit budget (PHA-3605). */
  wakeAliases?: string[];
  /** The other bot's wake names: a hearing at least as close to one of these as to ours is declined (PHA-3605). */
  excludeWakeNames?: string[];
  /** Agent profile bootstrap files to include in realtime instructions. Defaults to IDENTITY.md, USER.md, SOUL.md; set [] to disable. */
  bootstrapContextFiles?: TeamSpeakVoiceRealtimeBootstrapContextFile[];
  /**
   * Dead air allowed after our own speech before the conversation closes again,
   * during which a follow-up needs no wake name. Default 15000 (PHA-3783);
   * 0 makes the name the only way in (the pre-PHA-3783 behaviour).
   */
  followUpSilenceMs?: number;
  /** Allow `speaker_start` frames to interrupt active realtime playback. */
  bargeIn?: boolean;
  /** Minimum assistant playback duration before a barge-in truncates audio. Default: 250ms; 0 interrupts immediately. */
  minBargeInAudioEndMs?: number;
  /** Debounce window before buffered transcripts are sent to the OpenClaw agent. */
  debounceMs?: number;
  /** Provider-specific realtime voice config keyed by provider id. */
  providers?: Record<string, Record<string, unknown> | undefined>;
};

/**
 * `voice.streaming` — the stt-tts lane (PHA-3228).
 *
 * `voice-call` models `streaming` and `realtime` as mutually exclusive lanes
 * with a provider-keyed transcription block (`extensions/voice-call/src/config-migration.ts`);
 * this mirrors that shape rather than inventing a second vocabulary. Only one
 * of the two blocks is read, chosen by `voice.mode`.
 */
/**
 * One STT provider slot (PHA-3790).
 *
 * The same shape serves both slots and every registered provider, so choosing a
 * different transcriber is a config edit rather than a code change — see
 * `voice/stt-provider.ts` for the contract and `voice/stt-registry.ts` for the
 * names. Fields a given provider does not use are simply ignored by it: `url`
 * is whisper's, `baseUrl`/`apiKey` belong to a hosted provider, and each
 * provider applies its own defaults.
 */
export type TeamSpeakVoiceStreamingTranscriptionConfig = {
  /**
   * Registered transcription provider name. Default: "whisper-local".
   *
   * A `kind: "hosted"` provider is refused in this slot unless `allowHosted` is
   * also set: the lane's whole point is that the hot mic never leaves the house,
   * and that promise is made to the channel in the welcome notice, not just to
   * the budget.
   */
  provider?: string;
  /** whisper.cpp server endpoint. Default: http://whisper:8080/inference. */
  url?: string;
  /** API base for a hosted provider, without the /v1 suffix. */
  baseUrl?: string;
  /** API key for a hosted provider. */
  apiKey?: string;
  /** Model name passed through to the server, when it hosts more than one. */
  model?: string;
  /** ISO-639-1 language hint, or "auto". Default: "en". */
  language?: string;
  /**
   * Decoder priming text — names, jargon, the bot's own wake words. whisper.cpp
   * takes it as an initial prompt; MiniMax `asr-1.0` has no such parameter and
   * ignores it. Unset by default: priming changes what comes back, so it is an
   * operator's decision, not a default.
   */
  prompt?: string;
  /**
   * Ask the provider to score the transcript. Off by default because whisper
   * only scores under `response_format=verbose_json`, measured at about +1.8s
   * on every turn (the table is in `voice/whisper-local.ts`).
   */
  confidence?: boolean;
  /** Per-segment transcription timeout. Default: 15000ms. */
  timeoutMs?: number;
  /**
   * Permit a hosted provider in this slot, sending speaker audio to a metered
   * third party on every turn. Default: false.
   */
  allowHosted?: boolean;
  /** Provider-specific extras, passed through to the provider untouched. */
  options?: Record<string, unknown>;
};

export type TeamSpeakVoiceStreamingSpeechConfig = {
  /** Speech (TTS) provider id, for example "minimax". */
  provider?: string;
  /** Provider speech model, for example "speech-2.8-hd". */
  model?: string;
  /** Provider voice id. Free-form; MiniMax accepts any system voice id. */
  voiceId?: string;
  /** Synthesis timeout for one reply. Default: 20000ms. */
  timeoutMs?: number;
};

export type TeamSpeakVoiceStreamingSegmentationConfig = {
  /**
   * Silence tolerated after `speaker_stop` before the segment closes. The
   * bridge's stop frame is TeamSpeak's own voice-activity edge, so this is a
   * join window for mid-sentence pauses, not a VAD. Default: 600ms.
   */
  hangoverMs?: number;
  /** Segments shorter than this are discarded unheard. Default: 320ms. */
  minSegmentMs?: number;
  /** A segment is force-closed at this length so one monologue cannot stall the lane. Default: 20000ms. */
  maxSegmentMs?: number;
};

export type TeamSpeakVoiceStreamingConfig = {
  transcription?: TeamSpeakVoiceStreamingTranscriptionConfig;
  /** Optional hosted second opinion; absent by default. See PHA-3428 item 3. */
  secondaryTranscription?: TeamSpeakVoiceStreamingSecondaryTranscriptionConfig;
  speech?: TeamSpeakVoiceStreamingSpeechConfig;
  segmentation?: TeamSpeakVoiceStreamingSegmentationConfig;
};

export type TeamSpeakVoiceConfig = {
  /** Enable TeamSpeak voice conversations (default: true). */
  enabled?: boolean;
  /** Voice conversation mode. Default: agent-proxy. */
  mode?: TeamSpeakVoiceMode;
  /** Route voice turns through an existing OpenClaw TeamSpeak conversation. */
  agentSession?: TeamSpeakVoiceAgentSessionConfig;
  /** Optional LLM model override for TeamSpeak voice responses. */
  model?: string;
  /**
   * Thinking level forced on every stt-tts voice turn ("off"|"low"|"medium"|
   * "high"), passed straight through as `AgentCommandOpts.thinking`. Voice
   * has no channel for a visible thinking trace and pays for it in dead air
   * on the line, so the lane defaults this to "off" (PHA-3789) rather than
   * inheriting whatever the agent's `thinkingDefault` resolves to for other
   * channels. Set explicitly to override, including back to "inherit".
   */
  thinking?: string;
  /**
   * Stream the reply into TTS block by block as the model generates it
   * (PHA-3792), through the host's `dispatchReplyWithBufferedBlockDispatcher`.
   * Default true. `false` restores the whole-reply `runCommandFromIngress`
   * path: first audio waits for the complete answer, but the turn is one
   * ingress call with no per-turn config copy.
   */
  blockStreaming?: boolean;
  /**
   * Wake-name policy for the stt-tts lane. Unset adapts to the room: off for
   * one human, on for two or more. The realtime lane keeps reading these from
   * `voice.realtime`; both spellings resolve, `voice` wins.
   */
  requireWakeName?: boolean;
  /** Wake names that allow a response when the gate is active. */
  wakeNames?: string[];
  /** Exact hearings whisper is known to produce for the first wake name, accepted with no edit budget (PHA-3605). */
  wakeAliases?: string[];
  /** The other bot's wake names: a hearing at least as close to one of these as to ours is declined (PHA-3605). */
  excludeWakeNames?: string[];
  /** Dead air after our own speech during which a follow-up needs no wake name. Default 0 (off). */
  followUpSilenceMs?: number;
  /** Allow `speaker_start` frames to interrupt active playback. */
  bargeIn?: boolean;
  /** Streaming (stt-tts) lane settings. */
  streaming?: TeamSpeakVoiceStreamingConfig;
  /** Realtime provider settings for agent-proxy or bidi modes. */
  realtime?: TeamSpeakVoiceRealtimeConfig;
};

/**
 * `play_music` settings (PHA-3176).
 *
 * The pipeline is TS3AudioBot's, which is the one proven against a TeamSpeak
 * server: yt-dlp resolves a direct stream URL, ffmpeg decodes it to 48 kHz mono
 * PCM16, and the plugin paces that onto the bridge's music lane. Both binaries
 * live in the gateway image; the paths exist so a non-standard image can point
 * at them.
 */
export type TeamSpeakMusicConfig = {
  /** Enable `play_music` / `stop_music` / `set_volume` (default: false; PHA-3806 — fails closed for a foreign server). */
  enabled?: boolean;
  /** yt-dlp executable. Default: "yt-dlp". */
  ytdlpPath?: string;
  /** ffmpeg executable. Default: "ffmpeg". */
  ffmpegPath?: string;
  /**
   * Netscape cookie file for yt-dlp, from a throwaway account. YouTube
   * intermittently challenges datacenter IPs; the yt-dlp wiki's answer is this
   * plus the bgutil POT provider plugin, which is an image concern, not a
   * config one.
   */
  cookiesFile?: string;
  /** Extra yt-dlp arguments, inserted before the target. */
  ytdlpArgs?: string[];
  /** Music lane gain, 0..1, applied before the bridge's ducking. Default: 0.6. */
  defaultVolume?: number;
  /** Timeout for the yt-dlp resolve step. Default: 20000ms. */
  resolveTimeoutMs?: number;
  /**
   * Audio handed to the bridge ahead of realtime, in milliseconds. This is the
   * jitter buffer *and* the floor on how long `stop_music` takes to fall
   * silent, because the bridge's music queue is unbounded and cannot be
   * cleared. Default: 240ms.
   */
  prebufferMs?: number;
};

/**
 * The house band (PHA-3554): `compose_song` generates a track and plays it on
 * the music lane after the band leader announces it.
 *
 * Off by default. This is Bexton's lane, not the Sexton's, and generation
 * costs money on every provider that can actually do it, so an account has to
 * opt in. The generator is pluggable because, as of 2026-09-17, MiniMax's own
 * music endpoint refuses new accounts (status 2153), Suno has no official API,
 * and the open-source route (MiniMax-Music3, ACE-Step) is a self-hosted
 * process — three different shapes for one job.
 */
export type TeamSpeakBandProvider = "minimax" | "suno-api" | "command";

export type TeamSpeakBandConfig = {
  /** Register `compose_song` / `band_status` and run the generator (default: false). */
  enabled?: boolean;
  /** How the band is introduced. Default: "The Velvet Vice Lounge Band". */
  name?: string;
  /** Other billings, used in a minority of introductions. Default: "Sgt. Bexton and the Digital Heart Club Band". */
  aliases?: string[];
  /** Which generator. Default: "minimax". */
  provider?: TeamSpeakBandProvider;
  /** MiniMax `/v1/music_generation`. Key falls back to MINIMAX_API_KEY. */
  minimax?: { apiKey?: string; baseUrl?: string; model?: string };
  /**
   * A self-hosted gcui-art/suno-api (`POST /api/custom_generate`), or anything
   * that speaks that shape. Base URL falls back to SUNO_API_BASE_URL, key to
   * SUNO_API_KEY (sent as a bearer token when set).
   */
  sunoApi?: { baseUrl?: string; apiKey?: string };
  /**
   * Any executable: the song spec arrives as JSON on stdin and it prints JSON
   * with `audioPath` or `audioUrl` on stdout. The seam for a self-hosted model.
   */
  command?: { path?: string; args?: string[] };
  /** Where generated tracks are written. Default: <tmpdir>/teamspeak-band. */
  songsDir?: string;
  /** Generation timeout. Default: 360000ms — a real generator takes minutes (Suno v6: 1-3 of them). */
  generateTimeoutMs?: number;
  /** Speak the announcement before the song (default: true). */
  announce?: boolean;
  /** Silence between the end of the announcement and the downbeat. Default: 700ms. */
  introGapMs?: number;
  /** Generated files kept on disk; older ones are pruned. Default: 20. */
  keepSongs?: number;
};

/**
 * Moderation tool gate (PHA-3786, TOOL-CATALOG.md §4.3): kick, ban, move
 * others, mute, channel/server edit. Fails closed — an empty/absent
 * `allowGroups` disables every moderation tool regardless of the per-action
 * flags below, since there is nobody it would be safe to run them for.
 */
export type TeamSpeakModerationConfig = {
  /** Register `kick_client`/`move_client` (default: false). */
  kick?: boolean;
  /** Register `ban_client`/`unban_client`/`list_bans` (default: false). */
  ban?: boolean;
  /**
   * Register `mute_client`/`edit_channel`/`create_channel`/`delete_channel`/
   * `edit_server`/`add_to_server_group` (default: false).
   */
  edit?: boolean;
  /**
   * TeamSpeak server group names allowed to invoke any moderation tool,
   * matched case-insensitively against the invoking client's
   * `RosterEntry.serverGroups`. Brandon/host prerequisite: the Sexton/Bexton
   * TS identity itself needs the underlying TS permissions granted via a
   * server group for these bridge commands to actually take effect — this
   * config only gates who may *ask* the bot to use them.
   */
  allowGroups?: string[];
};

/** Realtime voice tool settings (PHA-3176). */
export type TeamSpeakToolsConfig = {
  /** Register the TeamSpeak realtime tools at all (default: true). */
  enabled?: boolean;
  /**
   * Root of the Sexton's markdown logs, the same `--log-dir` the logger bot
   * runs with. `what_did_i_miss` reads `<logDir>/<channel>/YYYY-MM-DD.md`.
   * Default: TEAMSPEAK_SEXTON_LOG_DIR, else /mnt/user/appdata/sexton.
   */
  logDir?: string;
  /** Lines `what_did_i_miss` returns when no window is given. Default: 15. */
  catchUpDefaultLines?: number;
  /** Hard cap on lines returned in one catch-up. Default: 40. */
  catchUpMaxLines?: number;
  music?: TeamSpeakMusicConfig;
  band?: TeamSpeakBandConfig;
  moderation?: TeamSpeakModerationConfig;
  villain?: TeamSpeakVillainConfig;
};

/**
 * Lexton's villain tools (PHA-3820): `sentence`, `silence`, `summon`,
 * `dossier`. A separate switch from `moderation.edit`, which would also hand
 * the agent `edit_channel`/`delete_channel`/`edit_server`/group adds. These
 * run on the bot's own initiative, so there is no caller-group gate; the
 * exempt lists are what protect people.
 */
export type TeamSpeakVillainConfig = {
  /** Register the four tools (default: false). */
  enabled?: boolean;
  /** Nicknames nobody may jail/mute/summon (substring, case/punctuation-insensitive). Default: Emily, miss_shade, the bots. */
  exempt?: string[];
  /** Server groups that are exempt (the bots' group). Default: ["Sexton"]. */
  exemptGroups?: string[];
  /** Bot Jail's channel id. Default: 7. */
  jailChannelId?: number;
  /** Where the bot goes back to after a summon. Default: "General Shit". */
  homeChannel?: string;
  /** Default: "LexCorp Board Room". */
  boardRoomName?: string;
  /** Pending reverts, so they survive a gateway restart. Default: $OPENCLAW_STATE_DIR/teamspeak-villain-pending.json. */
  stateFile?: string;
  /** Transcript DB for `dossier`. Default: $OPENCLAW_STATE_DIR/agents/$SEXTON_AGENT_ID/agent/openclaw-agent.sqlite. */
  transcriptDb?: string;
};

export type TeamSpeakAccountConfig = {
  enabled?: boolean;
  /** WebSocket URL of the plnt-ts-bridge sidecar, e.g. ws://ts-bridge:9099. */
  bridgeUrl?: string;
  /** Channel the bridge should join on connect (name or numeric id as a string). */
  channel?: string;
  /** Prefix for in-channel chat commands. Default: "!". */
  commandPrefix?: string;
  /** TeamSpeak client ids allowed to issue `!vc` / `!sexton` commands. Unset allows anyone in the channel. */
  commandAllowFrom?: number[];
  voice?: TeamSpeakVoiceConfig;
  tools?: TeamSpeakToolsConfig;
};

export const DEFAULT_COMMAND_PREFIX = "!";
export const DEFAULT_VOICE_MODE: TeamSpeakVoiceMode = "agent-proxy";
export const DEFAULT_SEXTON_LOG_DIR = "/mnt/user/appdata/sexton";
export const DEFAULT_CATCH_UP_LINES = 15;
export const DEFAULT_CATCH_UP_MAX_LINES = 40;
export const DEFAULT_MUSIC_VOLUME = 0.6;
export const DEFAULT_MUSIC_PREBUFFER_MS = 240;
export const DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS = 20_000;

export function areTeamSpeakToolsEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return config?.tools?.enabled !== false;
}

/**
 * Fails closed (PHA-3806): music shells out to yt-dlp/ffmpeg and reaches the
 * open internet on a server the operator may not own, so an unconfigured
 * install must not do that by default. Sexton/Bexton's own deploy sets
 * `tools.music.enabled: true` explicitly (`image/gateway/openclaw.seed.json`)
 * and is unaffected by this default.
 */
export function isTeamSpeakMusicEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return areTeamSpeakToolsEnabled(config) && config?.tools?.music?.enabled === true;
}

// --- the house band (PHA-3554) -----------------------------------------------

export const DEFAULT_BAND_PROVIDER: TeamSpeakBandProvider = "minimax";
// suno-api: a 2Captcha Turnstile solve (~10 s) plus Suno v6 rendering a pair of
// clips (60-180 s observed 2026-09-18). MiniMax answered in well under a minute.
export const DEFAULT_BAND_GENERATE_TIMEOUT_MS = 360_000;
export const DEFAULT_BAND_INTRO_GAP_MS = 700;
export const DEFAULT_BAND_KEEP_SONGS = 20;
export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io";
/**
 * The music id MiniMax documents today (platform.minimax.io, 2026-09-18:
 * music-3.0 / music-3.0-free / music-2.6 / music-cover). Every id, old and
 * new, returns 2153 on an account MiniMax does not count as an existing
 * paying music customer, so this is not a workaround for that — it is just
 * the id that works once the account is allowed in.
 */
export const DEFAULT_MINIMAX_MUSIC_MODEL = "music-3.0";

/** The band needs the music lane: no ffmpeg, no song. */
export function isTeamSpeakBandEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return isTeamSpeakMusicEnabled(config) && config?.tools?.band?.enabled === true;
}

export type ResolvedTeamSpeakBandConfig = {
  name: string | undefined;
  /** Undefined means the built-in aliases; an empty array means none. */
  aliases: string[] | undefined;
  provider: TeamSpeakBandProvider;
  minimax: { apiKey: string | undefined; baseUrl: string; model: string };
  sunoApi: { baseUrl: string | undefined; apiKey: string | undefined };
  command: { path: string | undefined; args: string[] };
  songsDir: string | undefined;
  generateTimeoutMs: number;
  announce: boolean;
  introGapMs: number;
  keepSongs: number;
};

/**
 * Resolve the band block, or explain why the band cannot play.
 *
 * A value, not an exception, for the same reason the transcription resolver
 * is: a band that cannot start should look to an operator exactly like any
 * other unstartable lane — one warning at boot, no tools registered — and the
 * rest of the account (voice, chat, `play_music`) must still come up.
 */
export function resolveTeamSpeakBandConfig(
  config: TeamSpeakAccountConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: ResolvedTeamSpeakBandConfig } | { ok: false; reason: string } {
  const raw = config?.tools?.band;
  const provider = (raw?.provider?.trim() || DEFAULT_BAND_PROVIDER) as TeamSpeakBandProvider;
  const resolved: ResolvedTeamSpeakBandConfig = {
    name: raw?.name?.trim() || undefined,
    aliases: Array.isArray(raw?.aliases)
      ? raw.aliases.map((alias) => String(alias).trim()).filter(Boolean)
      : undefined,
    provider,
    minimax: {
      apiKey: raw?.minimax?.apiKey?.trim() || env.MINIMAX_API_KEY?.trim() || undefined,
      baseUrl: (raw?.minimax?.baseUrl?.trim() || DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/u, ""),
      model: raw?.minimax?.model?.trim() || DEFAULT_MINIMAX_MUSIC_MODEL,
    },
    sunoApi: {
      baseUrl: (raw?.sunoApi?.baseUrl?.trim() || env.SUNO_API_BASE_URL?.trim() || undefined)?.replace(
        /\/+$/u,
        "",
      ),
      apiKey: raw?.sunoApi?.apiKey?.trim() || env.SUNO_API_KEY?.trim() || undefined,
    },
    command: {
      path: raw?.command?.path?.trim() || undefined,
      args: raw?.command?.args ?? [],
    },
    songsDir: raw?.songsDir?.trim() || undefined,
    generateTimeoutMs: positiveMs(raw?.generateTimeoutMs, DEFAULT_BAND_GENERATE_TIMEOUT_MS),
    announce: raw?.announce !== false,
    introGapMs: nonNegativeMs(raw?.introGapMs, DEFAULT_BAND_INTRO_GAP_MS),
    keepSongs:
      typeof raw?.keepSongs === "number" && Number.isFinite(raw.keepSongs) && raw.keepSongs >= 1
        ? Math.floor(raw.keepSongs)
        : DEFAULT_BAND_KEEP_SONGS,
  };
  switch (provider) {
    case "minimax":
      if (!resolved.minimax.apiKey) {
        return {
          ok: false,
          reason: "tools.band.provider=minimax needs tools.band.minimax.apiKey or MINIMAX_API_KEY.",
        };
      }
      return { ok: true, config: resolved };
    case "suno-api":
      if (!resolved.sunoApi.baseUrl) {
        return {
          ok: false,
          reason: "tools.band.provider=suno-api needs tools.band.sunoApi.baseUrl or SUNO_API_BASE_URL.",
        };
      }
      return { ok: true, config: resolved };
    case "command":
      if (!resolved.command.path) {
        return { ok: false, reason: "tools.band.provider=command needs tools.band.command.path." };
      }
      return { ok: true, config: resolved };
    default:
      return {
        ok: false,
        reason: `tools.band.provider="${String(provider)}" is not one of minimax, suno-api, command.`,
      };
  }
}

/** Log root for `what_did_i_miss`; env fallback so a container can set it once. */
export function resolveSextonLogDir(
  config: TeamSpeakAccountConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    config?.tools?.logDir?.trim() ||
    env.TEAMSPEAK_SEXTON_LOG_DIR?.trim() ||
    env.SEXTON_LOG_DIR?.trim() ||
    DEFAULT_SEXTON_LOG_DIR
  );
}

export function isTeamSpeakVoiceEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return config?.voice?.enabled !== false;
}

// --- stt-tts lane (PHA-3228) -------------------------------------------------

export const DEFAULT_WHISPER_URL = "http://whisper:8080/inference";
export const DEFAULT_WHISPER_LANGUAGE = "en";
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15_000;
export const DEFAULT_SPEECH_TIMEOUT_MS = 20_000;
export const DEFAULT_SPEECH_PROVIDER = "minimax";
/**
 * MiniMax Coding Plan keys route by model *version*: `speech-2.8-hd` resolves
 * and `speech-2.6-hd` returns error 2056 (MiniMax-AI/MiniMax-MCP#80). Pinning
 * the new-version id here is what keeps the $0 ceiling from turning into a
 * confusing auth failure.
 */
export const DEFAULT_SPEECH_MODEL = "speech-2.8-hd";

export const DEFAULT_SEGMENT_HANGOVER_MS = 600;
export const DEFAULT_MIN_SEGMENT_MS = 320;
export const DEFAULT_MAX_SEGMENT_MS = 20_000;

/** Re-exported so a caller needs one import for a slot config and its resolver. */
export type { ResolvedSttProviderConfig };

/**
 * Resolve the transcription block into the generic provider-slot shape.
 *
 * Note what is NOT here any more: the old `LOCAL_TRANSCRIPTION_PROVIDERS` array
 * and its name check. Validating the provider name in this file is what made
 * `sttProvider` a label rather than a switch — the name was checked here and
 * then ignored at construction. Name resolution, the local/hosted refusal, and
 * each provider's own missing-pieces refusal all live at the seam that actually
 * builds the thing (`SttProviderRegistry`, wired in `stt-tts-lane.ts`), which is
 * also the only place that can enforce them. This function's job is now purely
 * to read config and apply the slot-level defaults — which is why it returns the
 * config plainly rather than the `{ ok }` union it used to: there is no longer
 * anything here that can fail, and a union with one arm only invites a caller to
 * write a branch that never runs.
 */
export function resolveTeamSpeakTranscriptionConfig(
  config: TeamSpeakAccountConfig | undefined,
): ResolvedSttProviderConfig {
  const raw = config?.voice?.streaming?.transcription;
  return {
    provider: raw?.provider?.trim() || WHISPER_LOCAL_PROVIDER_ID,
    url: raw?.url?.trim() || undefined,
    baseUrl: raw?.baseUrl?.trim() || undefined,
    apiKey: raw?.apiKey?.trim() || undefined,
    model: raw?.model?.trim() || undefined,
    language: raw?.language?.trim() || DEFAULT_WHISPER_LANGUAGE,
    prompt: raw?.prompt?.trim() || undefined,
    confidence: raw?.confidence === true,
    timeoutMs: positiveMs(raw?.timeoutMs, DEFAULT_TRANSCRIPTION_TIMEOUT_MS),
    // Hosted-provider health knobs. Harmless for a local provider, which ignores
    // them; the secondary slot lets config override both.
    slowMs: DEFAULT_SECONDARY_SLOW_MS,
    backoffMs: DEFAULT_SECONDARY_BACKOFF_MS,
    allowHosted: raw?.allowHosted === true,
    options: raw?.options ?? {},
  };
}

/**
 * The SECONDARY transcriber (PHA-3428 item 3).
 *
 * Deliberately a separate block from `transcription` rather than a mode of it.
 * Escalation is a different decision from selection: the primary slot answers
 * "who transcribes", this one answers "who gets a second look, and when". Omit
 * the block and the lane behaves exactly as it did before it existed.
 */
export type TeamSpeakVoiceStreamingSecondaryTranscriptionConfig =
  TeamSpeakVoiceStreamingTranscriptionConfig & {
    /** A success slower than this parks the provider anyway. Default: 3000ms. */
    slowMs?: number;
    /** How long a failure parks the provider. Default: 600000ms (10 min). */
    backoffMs?: number;
    /** Segments longer than this always escalate. Default: 8000ms. */
    longSegmentMs?: number;
    /**
     * An empty primary transcript escalates only when the segment was at least
     * this long. Below it, an empty is room tone, not a miss. Default: 1500ms.
     */
    emptyEscalationMinMs?: number;
    /** Consecutive empty escalations before a speaker is suppressed. Default: 3. */
    maxFruitlessEscalations?: number;
    /** How long that suppression lasts. Default: 120000ms. */
    fruitlessCooldownMs?: number;
  };

export const DEFAULT_MINIMAX_ASR_BASE_URL = "https://api.minimax.io";
/** The API rejects every other id; probed 2026-09-13. */
export const DEFAULT_MINIMAX_ASR_MODEL = "asr-1.0";
export const DEFAULT_SECONDARY_TIMEOUT_MS = 8_000;
export const DEFAULT_SECONDARY_SLOW_MS = 3_000;
export const DEFAULT_SECONDARY_BACKOFF_MS = 600_000;
export const DEFAULT_LONG_SEGMENT_MS = 8_000;
export const DEFAULT_EMPTY_ESCALATION_MIN_MS = 1_500;
export const DEFAULT_MAX_FRUITLESS_ESCALATIONS = 3;
export const DEFAULT_FRUITLESS_COOLDOWN_MS = 120_000;

export type ResolvedTeamSpeakRoutingConfig = {
  longSegmentMs: number;
  emptyEscalationMinMs: number;
  maxFruitlessEscalations: number;
  fruitlessCooldownMs: number;
};

/**
 * Resolve the secondary block.
 *
 * Two results, not three: absent (the ordinary case) or configured. The old
 * third result — misconfigured, for an unimplemented provider name or a missing
 * key — is gone from here, because both of those are now the registry's and the
 * provider factory's answer to give at construction time. What stays here is the
 * one rule that is genuinely about config and nothing else: an absent block
 * means off.
 */
export function resolveTeamSpeakSecondaryTranscriptionConfig(
  config: TeamSpeakAccountConfig | undefined,
):
  | { ok: true; config: ResolvedSttProviderConfig; routing: ResolvedTeamSpeakRoutingConfig }
  | { ok: false; reason: string | undefined } {
  const raw = config?.voice?.streaming?.secondaryTranscription;
  if (!raw) {
    // Absent block means off, even when MINIMAX_API_KEY happens to be exported
    // for the TTS provider — which it is, on this very container. Sending the
    // channel's audio to a third party is the one behaviour here that must
    // never switch itself on because an unrelated credential was in scope; the
    // env var may supply the *key*, but only this block may grant the *intent*.
    return { ok: false, reason: undefined };
  }
  return {
    ok: true,
    config: {
      provider: raw.provider?.trim() || MINIMAX_ASR_PROVIDER_ID,
      url: raw.url?.trim() || undefined,
      baseUrl: raw.baseUrl?.trim() || undefined,
      apiKey: raw.apiKey?.trim() || undefined,
      model: raw.model?.trim() || undefined,
      language: raw.language?.trim() || DEFAULT_WHISPER_LANGUAGE,
      prompt: raw.prompt?.trim() || undefined,
      confidence: raw.confidence === true,
      timeoutMs: positiveMs(raw.timeoutMs, DEFAULT_SECONDARY_TIMEOUT_MS),
      slowMs: positiveMs(raw.slowMs, DEFAULT_SECONDARY_SLOW_MS),
      backoffMs: positiveMs(raw.backoffMs, DEFAULT_SECONDARY_BACKOFF_MS),
      // Meaningless in this slot: escalating to a hosted second opinion is the
      // point of the block, and the registry only gates the primary.
      allowHosted: true,
      options: raw.options ?? {},
    },
    routing: {
      longSegmentMs: positiveMs(raw.longSegmentMs, DEFAULT_LONG_SEGMENT_MS),
      emptyEscalationMinMs: positiveMs(raw.emptyEscalationMinMs, DEFAULT_EMPTY_ESCALATION_MIN_MS),
      maxFruitlessEscalations: positiveMs(
        raw.maxFruitlessEscalations,
        DEFAULT_MAX_FRUITLESS_ESCALATIONS,
      ),
      fruitlessCooldownMs: positiveMs(raw.fruitlessCooldownMs, DEFAULT_FRUITLESS_COOLDOWN_MS),
    },
  };
}

export type ResolvedTeamSpeakSpeechConfig = {
  provider: string;
  model: string;
  voiceId: string | undefined;
  timeoutMs: number;
};

export function resolveTeamSpeakSpeechConfig(
  config: TeamSpeakAccountConfig | undefined,
): ResolvedTeamSpeakSpeechConfig {
  const raw = config?.voice?.streaming?.speech;
  return {
    provider: raw?.provider?.trim() || DEFAULT_SPEECH_PROVIDER,
    model: raw?.model?.trim() || DEFAULT_SPEECH_MODEL,
    voiceId: raw?.voiceId?.trim() || undefined,
    timeoutMs: positiveMs(raw?.timeoutMs, DEFAULT_SPEECH_TIMEOUT_MS),
  };
}

export type ResolvedTeamSpeakSegmentationConfig = {
  hangoverMs: number;
  minSegmentMs: number;
  maxSegmentMs: number;
};

export function resolveTeamSpeakSegmentationConfig(
  config: TeamSpeakAccountConfig | undefined,
): ResolvedTeamSpeakSegmentationConfig {
  const raw = config?.voice?.streaming?.segmentation;
  return {
    hangoverMs: nonNegativeMs(raw?.hangoverMs, DEFAULT_SEGMENT_HANGOVER_MS),
    minSegmentMs: nonNegativeMs(raw?.minSegmentMs, DEFAULT_MIN_SEGMENT_MS),
    maxSegmentMs: positiveMs(raw?.maxSegmentMs, DEFAULT_MAX_SEGMENT_MS),
  };
}

/**
 * The wake-gate knobs, read from `voice` first and `voice.realtime` second.
 *
 * PHA-3175 put these under `voice.realtime` because that was the only lane.
 * PHA-3228's config puts them at `voice` level, where they belong now that they
 * govern both. Both spellings resolve so an existing deployment keeps working.
 */
export function resolveTeamSpeakWakeConfig(
  config: TeamSpeakAccountConfig | undefined,
): TeamSpeakVoiceRealtimeConfig {
  const voice = config?.voice;
  const realtime = voice?.realtime;
  const requireWakeName = voice?.requireWakeName ?? realtime?.requireWakeName;
  const wakeNames = voice?.wakeNames ?? realtime?.wakeNames;
  const wakeAliases = voice?.wakeAliases ?? realtime?.wakeAliases;
  const excludeWakeNames = voice?.excludeWakeNames ?? realtime?.excludeWakeNames;
  const bargeIn = voice?.bargeIn ?? realtime?.bargeIn;
  const followUpSilenceMs = voice?.followUpSilenceMs ?? realtime?.followUpSilenceMs;
  return {
    ...(requireWakeName === undefined ? {} : { requireWakeName }),
    ...(wakeNames === undefined ? {} : { wakeNames }),
    ...(wakeAliases === undefined ? {} : { wakeAliases }),
    ...(excludeWakeNames === undefined ? {} : { excludeWakeNames }),
    ...(bargeIn === undefined ? {} : { bargeIn }),
    ...(followUpSilenceMs === undefined ? {} : { followUpSilenceMs }),
  };
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveTeamSpeakVoiceMode(
  config: TeamSpeakAccountConfig | undefined,
): TeamSpeakVoiceMode {
  return config?.voice?.mode ?? DEFAULT_VOICE_MODE;
}

/** Where the villain tools keep state and read the transcript (PHA-3820). */
export function resolveVillainPaths(
  config: TeamSpeakVillainConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { stateFile: string; transcriptDb: string } {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || "/config/openclaw";
  const agentId = env.SEXTON_AGENT_ID?.trim() || "sexton";
  return {
    stateFile: config?.stateFile?.trim() || `${stateDir}/teamspeak-villain-pending.json`,
    transcriptDb:
      config?.transcriptDb?.trim() || `${stateDir}/agents/${agentId}/agent/openclaw-agent.sqlite`,
  };
}
