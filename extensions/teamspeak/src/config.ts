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
  /** Agent profile bootstrap files to include in realtime instructions. Defaults to IDENTITY.md, USER.md, SOUL.md; set [] to disable. */
  bootstrapContextFiles?: TeamSpeakVoiceRealtimeBootstrapContextFile[];
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
export type TeamSpeakVoiceStreamingTranscriptionConfig = {
  /**
   * Transcription provider id. Only local providers are accepted: the lane's
   * whole point is that the hot mic never leaves the house, and that promise is
   * made to the channel in the welcome notice, not just to the budget.
   */
  provider?: string;
  /** whisper.cpp server endpoint. Default: http://whisper:8080/inference. */
  url?: string;
  /** Model name passed through to the server, when it hosts more than one. */
  model?: string;
  /** ISO-639-1 language hint, or "auto". Default: "en". */
  language?: string;
  /** Per-segment transcription timeout. Default: 15000ms. */
  timeoutMs?: number;
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
   * Wake-name policy for the stt-tts lane. Unset adapts to the room: off for
   * one human, on for two or more. The realtime lane keeps reading these from
   * `voice.realtime`; both spellings resolve, `voice` wins.
   */
  requireWakeName?: boolean;
  /** Wake names that allow a response when the gate is active. */
  wakeNames?: string[];
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
  /** Enable `play_music` / `stop_music` / `set_volume` (default: true). */
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

export function isTeamSpeakMusicEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return areTeamSpeakToolsEnabled(config) && config?.tools?.music?.enabled !== false;
}

/** Log root for `what_did_i_miss`; env fallback so a container can set it once. */
export function resolveSextonLogDir(
  config: TeamSpeakAccountConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    config?.tools?.logDir?.trim() ||
    env.TEAMSPEAK_SEXTON_LOG_DIR?.trim() ||
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

/**
 * Transcription providers this lane will run.
 *
 * This list is the $0 ceiling and the privacy promise expressed as code. Every
 * transcription provider OpenClaw registers (deepgram, openai, elevenlabs,
 * mistral) is metered and hosted, so an unrecognized id is refused at startup
 * rather than silently costing money and shipping the channel's hot mic to a
 * third party. Adding an id here is a deliberate act.
 */
export const LOCAL_TRANSCRIPTION_PROVIDERS = ["whisper-local"] as const;

export type TeamSpeakLocalTranscriptionProvider =
  (typeof LOCAL_TRANSCRIPTION_PROVIDERS)[number];

export function isLocalTranscriptionProvider(
  provider: string | undefined,
): provider is TeamSpeakLocalTranscriptionProvider {
  return LOCAL_TRANSCRIPTION_PROVIDERS.includes(
    (provider ?? "").trim().toLowerCase() as TeamSpeakLocalTranscriptionProvider,
  );
}

export type ResolvedTeamSpeakTranscriptionConfig = {
  provider: TeamSpeakLocalTranscriptionProvider;
  url: string;
  model: string | undefined;
  language: string;
  timeoutMs: number;
};

/**
 * Resolve the transcription block, or explain why the lane cannot start.
 *
 * Returning a reason rather than throwing keeps the failure at the same place
 * every other unstartable account reports: a warning plus a runtime that never
 * opens, instead of an exception out of `startAccount`.
 */
export function resolveTeamSpeakTranscriptionConfig(
  config: TeamSpeakAccountConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: ResolvedTeamSpeakTranscriptionConfig } | { ok: false; reason: string } {
  const raw = config?.voice?.streaming?.transcription;
  const provider = raw?.provider?.trim() || LOCAL_TRANSCRIPTION_PROVIDERS[0];
  if (!isLocalTranscriptionProvider(provider)) {
    return {
      ok: false,
      reason:
        `voice.streaming.transcription.provider="${provider}" is not a local transcriber. ` +
        `voice.mode=stt-tts only runs local speech-to-text (${LOCAL_TRANSCRIPTION_PROVIDERS.join(", ")}); ` +
        "every registered OpenClaw transcription provider is metered and hosted.",
    };
  }
  return {
    ok: true,
    config: {
      provider,
      url: raw?.url?.trim() || env.TEAMSPEAK_WHISPER_URL?.trim() || DEFAULT_WHISPER_URL,
      model: raw?.model?.trim() || undefined,
      language: raw?.language?.trim() || DEFAULT_WHISPER_LANGUAGE,
      timeoutMs: positiveMs(raw?.timeoutMs, DEFAULT_TRANSCRIPTION_TIMEOUT_MS),
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
  const bargeIn = voice?.bargeIn ?? realtime?.bargeIn;
  return {
    ...(requireWakeName === undefined ? {} : { requireWakeName }),
    ...(wakeNames === undefined ? {} : { wakeNames }),
    ...(bargeIn === undefined ? {} : { bargeIn }),
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
