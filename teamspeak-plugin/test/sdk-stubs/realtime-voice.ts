/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/realtime-voice`.
 *
 * This file exists so the plugin's own logic can be tested outside an OpenClaw
 * checkout (see vitest.standalone.config.ts, which aliases the SDK subpath
 * here). Inside a real checkout the alias is absent and the genuine SDK is
 * used; nothing under src/ imports this file.
 *
 * Two classes of export, and the difference matters when reading a test result:
 *
 *  - **Faithful.** `resamplePcm` re-exports the vendored copy of the real
 *    implementation, and the three policy helpers are line-for-line copies of
 *    src/talk/realtime-session-policy.ts @ fc1877d7. Assertions against these
 *    are assertions against real SDK behavior.
 *  - **Inert.** The provider/harness entry points below are minimal fakes.
 *    Tests that touch them are testing this plugin's wiring, not the provider
 *    stack; a live provider is only exercised on a real gateway.
 */

export { resamplePcm } from "./vendor/audio-codec.js";
export {
  REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
  isSupportedRealtimeVoiceActivationName,
  matchRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
  normalizeSupportedRealtimeVoiceActivationName,
  realtimeVoiceActivationNameWordCount,
  sortRealtimeVoiceActivationNames,
  type RealtimeVoiceActivationNameEdge,
  type RealtimeVoiceActivationNameMatchKind,
  type RealtimeVoiceActivationNameTranscriptResult,
} from "./vendor/activation-name.js";

export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ = "pcm16_24khz";

export type RealtimeVoiceWakeNamePolicy = "always" | "automatic" | "never";
export type RealtimeVoiceAgentConsultToolPolicy = "safe-read-only" | "owner" | "none";
export type RealtimeVoiceProviderConfig = Record<string, unknown>;
export type RealtimeVoiceBridgeEvent = { direction: "client" | "server"; type: string };
export type RealtimeVoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};
export type RealtimeVoiceToolCallEvent = {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
};
export type RealtimeVoiceBridgeSession = {
  connect(): Promise<void>;
  close(): void;
  sendAudio(audio: Buffer): void;
  handleBargeIn(options?: { audioPlaybackActive?: boolean; force?: boolean }): void;
  submitToolResult(callId: string, result: unknown): void | Promise<void>;
};
/**
 * Mirrors the shape of RealtimeVoiceBridgeSessionParams that this plugin
 * actually passes. Kept in step with the real SDK signature so `tsc` against
 * this stub still catches a wiring mistake.
 */
export type RealtimeVoiceBridgeSessionParams = {
  provider: { id: string; capabilities?: { supportsActivationNameGating?: boolean } };
  cfg?: unknown;
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: string;
  instructions?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  markStrategy?: "transport" | "ack-immediately" | "ignore";
  tools?: RealtimeVoiceTool[];
  audioSink: {
    isOpen?: () => boolean;
    sendAudio: (audio: Buffer, metadata?: unknown) => void;
    clearAudio?: () => void;
  };
  onToolCall?: (
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ) => void | Promise<void>;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onResponseDone?: (outcome: { status: string }) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: string) => void;
};

export type RealtimeVoiceSessionHarness = {
  close(): void;
  createBridge(params: RealtimeVoiceBridgeSessionParams): RealtimeVoiceBridgeSession;
  flushOutput(flush: () => void): void;
  handleBargeIn(
    options: { audioPlaybackActive?: boolean; force?: boolean },
    flushOutput: () => void,
  ): void;
  recordInputAudio(audio: Buffer): boolean;
  recordOutputAudio(audio: Buffer): void;
};

// --- faithful copies of src/talk/realtime-session-policy.ts @ fc1877d7 -------

export function isRealtimeVoiceWakeNameRequired(
  policy: RealtimeVoiceWakeNamePolicy,
  humanParticipantCount: number,
): boolean {
  return policy === "always" || (policy === "automatic" && humanParticipantCount > 1);
}

export function resolveRealtimeVoiceInterruptResponseOnInputAudio(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

export function resolveRealtimeVoiceBargeIn(params: {
  configuredBargeIn: boolean | undefined;
  interruptResponseOnInputAudio: unknown;
}): boolean {
  if (typeof params.configuredBargeIn === "boolean") {
    return params.configuredBargeIn;
  }
  return resolveRealtimeVoiceInterruptResponseOnInputAudio(params.interruptResponseOnInputAudio);
}

export function resolveRealtimeVoiceMinBargeInAudioEndMs(configured: number | undefined): number {
  return typeof configured === "number" ? configured : 250;
}

/**
 * Wake-name *policy* selection, copied from resolveRealtimeVoiceWakeNamePolicy.
 * Name resolution (which reads agent config) is not reproduced; tests that need
 * specific wake names pass them explicitly.
 */
export function resolveRealtimeVoiceSessionPolicy(params: {
  isAgentProxy: boolean;
  supportsActivationNameGating: boolean;
  configuredToolPolicy: unknown;
  configuredConsultPolicy: "auto" | "always" | undefined;
  requireWakeName: boolean | undefined;
  configuredWakeNames: string[] | undefined;
  cfg?: unknown;
  agentId?: string;
}): {
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultToolsAllow: string[] | undefined;
  consultPolicy: "auto" | "always";
  wakeNamePolicy: RealtimeVoiceWakeNamePolicy;
  wakeNames: string[];
  autoRespondToAudio: boolean;
} {
  const toolPolicy = (typeof params.configuredToolPolicy === "string"
    ? params.configuredToolPolicy
    : params.isAgentProxy
      ? "owner"
      : "safe-read-only") as RealtimeVoiceAgentConsultToolPolicy;
  const consultPolicy = params.configuredConsultPolicy ?? (params.isAgentProxy ? "always" : "auto");
  const wakeNamePolicy: RealtimeVoiceWakeNamePolicy =
    !params.isAgentProxy || !params.supportsActivationNameGating
      ? "never"
      : params.requireWakeName === true
        ? "always"
        : params.requireWakeName === false
          ? "never"
          : "automatic";
  return {
    toolPolicy,
    consultToolsAllow: undefined,
    consultPolicy,
    wakeNamePolicy,
    wakeNames: wakeNamePolicy === "never" ? [] : (params.configuredWakeNames ?? ["sexton"]),
    autoRespondToAudio:
      wakeNamePolicy === "never" && (!params.isAgentProxy || consultPolicy !== "always"),
  };
}

// --- inert stand-ins --------------------------------------------------------

export function buildRealtimeVoiceSessionInstructions(params: {
  base: string;
  isAgentProxy?: boolean;
  bootstrapContextInstructions?: string | undefined;
  toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy?: "auto" | "always";
}): string {
  return params.bootstrapContextInstructions
    ? `${params.base}\n\n${params.bootstrapContextInstructions}`
    : params.base;
}

export function canonicalizeRealtimeVoiceProviderId(id: string, _cfg?: unknown): string {
  return id;
}

export function resolveConfiguredRealtimeVoiceProvider(params: {
  configuredProviderId?: string | undefined;
  providerConfigs?: Record<string, RealtimeVoiceProviderConfig | undefined> | undefined;
  providerConfigOverrides?: RealtimeVoiceProviderConfig | undefined;
  cfg?: unknown;
  agentId?: string;
  defaultModel?: string | undefined;
  isProviderAvailable?: (provider: { id: string }) => boolean;
  noRegisteredProviderMessage?: string;
}): {
  provider: { id: string; capabilities?: { supportsActivationNameGating?: boolean } };
  providerConfig: RealtimeVoiceProviderConfig;
} {
  return {
    provider: {
      id: params.configuredProviderId ?? "openai",
      capabilities: { supportsActivationNameGating: true },
    },
    providerConfig: { ...params.providerConfigOverrides },
  };
}

export function createRealtimeVoiceSessionHarness(_params: {
  talk: { sessionId: string; mode: string; transport: string; brain: string };
  talkPayloads: Record<string, () => unknown>;
}): RealtimeVoiceSessionHarness {
  throw new Error(
    "createRealtimeVoiceSessionHarness is not implemented in the standalone test stub; inject a fake harness via TeamSpeakRealtimeSessionParams.deps.createHarness",
  );
}
