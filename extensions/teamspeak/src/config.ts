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
};

export const DEFAULT_COMMAND_PREFIX = "!";
export const DEFAULT_VOICE_MODE: TeamSpeakVoiceMode = "agent-proxy";

export function isTeamSpeakVoiceEnabled(config: TeamSpeakAccountConfig | undefined): boolean {
  return config?.voice?.enabled !== false;
}

export function resolveTeamSpeakVoiceMode(
  config: TeamSpeakAccountConfig | undefined,
): TeamSpeakVoiceMode {
  return config?.voice?.mode ?? DEFAULT_VOICE_MODE;
}
