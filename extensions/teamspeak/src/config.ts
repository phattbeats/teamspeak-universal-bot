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

export type TeamSpeakVoiceConfig = {
  /** Enable TeamSpeak voice conversations (default: true). */
  enabled?: boolean;
  /** Voice conversation mode. Default: agent-proxy. */
  mode?: TeamSpeakVoiceMode;
  /** Route voice turns through an existing OpenClaw TeamSpeak conversation. */
  agentSession?: TeamSpeakVoiceAgentSessionConfig;
  /** Optional LLM model override for TeamSpeak voice responses. */
  model?: string;
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

export function resolveTeamSpeakVoiceMode(
  config: TeamSpeakAccountConfig | undefined,
): TeamSpeakVoiceMode {
  return config?.voice?.mode ?? DEFAULT_VOICE_MODE;
}
