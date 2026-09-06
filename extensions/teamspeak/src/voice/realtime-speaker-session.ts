/**
 * One realtime voice session per TeamSpeak client.
 *
 * This mirrors extensions/discord/src/voice/realtime-speaker-session.ts with
 * @discordjs/voice replaced by the plnt-ts-bridge WebSocket:
 *
 *   bridge `speaker_audio` (48k mono) -> resample 24k -> harness/provider input
 *   provider output (24k mono)        -> resample 48k -> room queue -> `voice_audio`
 *
 * Everything provider-facing (policy resolution, harness, bridge session,
 * tools) stays on the SDK seams Discord uses, so behavior tracks upstream.
 */
import {
  buildRealtimeVoiceSessionInstructions,
  canonicalizeRealtimeVoiceProviderId,
  createRealtimeVoiceSessionHarness,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceMinBargeInAudioEndMs,
  resolveRealtimeVoiceSessionPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceSessionHarness,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";
import type { TeamSpeakVoiceMode, TeamSpeakVoiceRealtimeConfig } from "../config.js";
import {
  convertBridgePcm48kMonoToRealtimePcm24k,
  convertRealtimePcm24kToBridgePcm48kMono,
} from "./audio.js";
import type { RoomPlaybackQueue } from "./room-playback.js";
import type { SpeakerSession } from "./speaker-sessions.js";
import { WakeGate } from "./wake-gate.js";

const teamspeakTalkPayload = () => ({});

/** Result of a realtime tool call, handed back through `submitToolResult`. */
export type TeamSpeakRealtimeToolHandler = (
  event: RealtimeVoiceToolCallEvent,
  context: { clientId: TeamSpeakClientId; nickname: string },
) => Promise<unknown> | unknown;

export type TeamSpeakRealtimeToolRegistration = {
  tools: RealtimeVoiceTool[];
  handle: TeamSpeakRealtimeToolHandler;
};

/**
 * SDK seams the session uses, injectable so the roster/queue/gating behavior
 * can be exercised without a live provider. Production leaves these unset.
 */
export type TeamSpeakRealtimeSessionDeps = {
  createHarness?: typeof createRealtimeVoiceSessionHarness;
  resolveProvider?: typeof resolveConfiguredRealtimeVoiceProvider;
};

export type TeamSpeakRealtimeSessionParams = {
  client: RosterEntry;
  sessionId: string;
  accountId: string;
  agentId: string;
  /** Host config, forwarded to the SDK unchanged; no field is read here. */
  cfg: OpenClawConfig;
  mode: Exclude<TeamSpeakVoiceMode, "stt-tts">;
  realtimeConfig: TeamSpeakVoiceRealtimeConfig | undefined;
  bootstrapContextInstructions?: string;
  playback: RoomPlaybackQueue;
  humanParticipantCount: () => number;
  /** Realtime tools registered on the provider session; PHA-3176 fills these in. */
  toolRegistration?: TeamSpeakRealtimeToolRegistration;
  isProviderAvailable?: (providerId: string) => boolean;
  onTerminalError: (error: Error) => void;
  log?: (message: string) => void;
  deps?: TeamSpeakRealtimeSessionDeps;
};

export class TeamSpeakRealtimeSpeakerSession implements SpeakerSession {
  readonly clientId: TeamSpeakClientId;
  private nickname: string;
  private harness: RealtimeVoiceSessionHarness | undefined;
  private bridgeSession: RealtimeVoiceBridgeSession | null = null;
  private status: "inactive" | "starting" | "active" | "stopped" = "inactive";
  private wakeNamePolicy: RealtimeVoiceWakeNamePolicy = "never";
  private wakeNames: string[] = [];
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private providerId: string | undefined;
  private minBargeInAudioEndMs = 250;
  private readonly gate: WakeGate;

  constructor(private readonly params: TeamSpeakRealtimeSessionParams) {
    this.clientId = params.client.clientId;
    this.nickname = params.client.nickname;
    this.gate = new WakeGate({
      wakeNamePolicy: () => this.wakeNamePolicy,
      humanParticipantCount: () => this.params.humanParticipantCount(),
      realtimeConfig: () => this.params.realtimeConfig,
      providerId: () => this.providerId,
    });
  }

  /** Room playback key: the clientId owns the lane, not the nickname. */
  get playbackOwnerKey(): string {
    return `client:${this.clientId}`;
  }

  get label(): string {
    return this.nickname;
  }

  get wakeNameRequired(): boolean {
    return this.gate.isWakeNameRequired();
  }

  get bargeInEnabled(): boolean {
    return this.gate.isBargeInEnabled();
  }

  relabel(nickname: string): void {
    this.nickname = nickname;
  }

  async connect(): Promise<void> {
    this.status = "starting";
    const createHarness = this.params.deps?.createHarness ?? createRealtimeVoiceSessionHarness;
    const resolveProvider = this.params.deps?.resolveProvider ?? resolveConfiguredRealtimeVoiceProvider;
    const realtimeConfig = this.params.realtimeConfig;
    const cfg = this.params.cfg;

    const resolved = resolveProvider({
      configuredProviderId: realtimeConfig?.provider,
      providerConfigs: buildProviderConfigs(realtimeConfig),
      providerConfigOverrides: buildProviderConfigOverrides(realtimeConfig),
      cfg,
      agentId: this.params.agentId,
      defaultModel: realtimeConfig?.model,
      ...(this.params.isProviderAvailable
        ? { isProviderAvailable: (provider: { id: string }) => this.params.isProviderAvailable?.(provider.id) === true }
        : {}),
      noRegisteredProviderMessage: "No configured realtime voice provider registered",
    });
    this.providerId = resolved.provider.id;

    const isAgentProxy = this.params.mode === "agent-proxy";
    const sessionPolicy = resolveRealtimeVoiceSessionPolicy({
      isAgentProxy,
      supportsActivationNameGating:
        resolved.provider.capabilities?.supportsActivationNameGating === true,
      configuredToolPolicy: realtimeConfig?.toolPolicy,
      configuredConsultPolicy: realtimeConfig?.consultPolicy,
      requireWakeName: realtimeConfig?.requireWakeName,
      configuredWakeNames: realtimeConfig?.wakeNames,
      cfg,
      agentId: this.params.agentId,
    });
    this.consultToolPolicy = sessionPolicy.toolPolicy;
    this.wakeNamePolicy = sessionPolicy.wakeNamePolicy;
    this.wakeNames = sessionPolicy.wakeNames;
    this.minBargeInAudioEndMs = resolveRealtimeVoiceMinBargeInAudioEndMs(
      realtimeConfig?.minBargeInAudioEndMs,
    );

    const instructions = buildRealtimeVoiceSessionInstructions({
      base:
        realtimeConfig?.instructions ??
        [
          "You are OpenClaw's TeamSpeak voice interface.",
          `You are speaking with ${this.nickname} in a TeamSpeak channel.`,
          "Keep spoken replies concise, natural, and suitable for a live voice channel.",
        ].join("\n"),
      isAgentProxy,
      bootstrapContextInstructions: this.params.bootstrapContextInstructions,
      toolPolicy: sessionPolicy.toolPolicy,
      consultPolicy: sessionPolicy.consultPolicy,
    });

    const harness = createHarness({
      talk: {
        sessionId: this.params.sessionId,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: teamspeakTalkPayload,
        turnEnded: teamspeakTalkPayload,
        inputAudioDelta: teamspeakTalkPayload,
        outputAudioStarted: teamspeakTalkPayload,
        outputAudioDelta: teamspeakTalkPayload,
        outputAudioDone: teamspeakTalkPayload,
      },
    });
    this.harness = harness;

    this.bridgeSession = harness.createBridge({
      provider: resolved.provider,
      cfg,
      agentId: this.params.agentId,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      autoRespondToAudio: sessionPolicy.autoRespondToAudio,
      interruptResponseOnInputAudio: this.wakeNamePolicy === "never",
      markStrategy: "transport",
      tools: this.params.toolRegistration?.tools ?? [],
      audioSink: {
        isOpen: () => !this.isStopped(),
        sendAudio: (audio: Buffer) => this.sendOutputAudio(audio),
        clearAudio: () => {
          // The provider retired its own audio; drop what the room still holds.
          harness.flushOutput(() => this.clearRoomOutput("provider-clear-audio"));
        },
      },
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onEvent: (event: RealtimeVoiceBridgeEvent) => this.handleBridgeEvent(event),
      onResponseDone: () => {
        // The utterance is complete; release the room lane for the next speaker.
        this.params.playback.release(this.playbackOwnerKey);
      },
      onError: (error: Error) => this.params.log?.(`teamspeak voice: realtime error: ${error.message}`),
      onClose: (reason: string) => {
        if (!this.isStopped()) {
          this.status = "stopped";
          this.params.onTerminalError(
            new Error(`Realtime provider closed unexpectedly: ${reason}`),
          );
        }
      },
    });

    if (this.isStopped()) {
      this.close("stopped-during-connect");
      return;
    }
    this.params.log?.(
      `teamspeak voice: realtime bridge starting clientId=${this.clientId} nickname=${this.nickname} mode=${this.params.mode} provider=${resolved.provider.id} wakeNamePolicy=${this.wakeNamePolicy} requireWakeName=${this.wakeNameRequired} humanParticipants=${this.params.humanParticipantCount()} wakeNames=${this.wakeNames.join(",") || "none"} bargeIn=${this.bargeInEnabled} minBargeInAudioEndMs=${this.minBargeInAudioEndMs}`,
    );
    await this.bridgeSession?.connect();
    if (this.isStopped()) {
      this.bridgeSession?.close();
      return;
    }
    this.status = "active";
  }

  /**
   * Bridge `speaker_audio` for this client -> provider input.
   * The bridge sends 48 kHz mono; the provider takes 24 kHz.
   */
  sendInputAudio(pcm48kMono: Buffer): void {
    if (this.isStopped() || !this.bridgeSession) {
      return;
    }
    const pcm24k = convertBridgePcm48kMonoToRealtimePcm24k(pcm48kMono);
    if (pcm24k.length === 0) {
      return;
    }
    if (this.harness?.recordInputAudio(pcm24k) === false) {
      // Harness echo suppression rejected this chunk; do not feed it forward.
      return;
    }
    this.bridgeSession.sendAudio(pcm24k);
  }

  /**
   * A human started talking. Interrupt this session's playback unless the wake
   * gate is active or the echo guard says the audio is too young to truncate.
   */
  handleSpeakerStart(reason = "speaker-start"): boolean {
    if (this.isStopped() || !this.bargeInEnabled) {
      return false;
    }
    if (this.params.playback.activeOwner !== this.playbackOwnerKey) {
      return false;
    }
    const interrupted = this.params.playback.handleBargeIn(reason);
    if (interrupted) {
      this.harness?.handleBargeIn({ audioPlaybackActive: true }, () => {
        this.bridgeSession?.handleBargeIn({ audioPlaybackActive: true });
      });
    }
    return interrupted;
  }

  close(reason: string): void {
    if (this.status === "stopped") {
      return;
    }
    this.status = "stopped";
    this.params.playback.release(this.playbackOwnerKey);
    this.harness?.close();
    this.bridgeSession?.close();
    this.bridgeSession = null;
    this.params.log?.(
      `teamspeak voice: speaker session closed clientId=${this.clientId} reason=${reason}`,
    );
  }

  private isStopped(): boolean {
    return this.status === "stopped";
  }

  private sendOutputAudio(pcm24kMono: Buffer): void {
    if (this.isStopped()) {
      return;
    }
    const pcm48k = convertRealtimePcm24kToBridgePcm48kMono(pcm24kMono);
    if (pcm48k.length === 0) {
      return;
    }
    this.harness?.recordOutputAudio(pcm24kMono);
    this.params.playback.enqueue(this.playbackOwnerKey, pcm48k);
  }

  private clearRoomOutput(reason: string): void {
    this.params.playback.handleBargeIn(reason, { force: true });
  }

  /**
   * Realtime tool calls take the same path Discord uses for
   * `openclaw_agent_consult`: run the handler, then hand the result back
   * through the session's `submitToolResult`. The tools themselves land in
   * PHA-3176; without a registration this reports the call as unsupported
   * rather than leaving the provider waiting on a result that never arrives.
   */
  private async handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): Promise<void> {
    if (this.isStopped()) {
      return;
    }
    const registration = this.params.toolRegistration;
    if (!registration) {
      await session.submitToolResult(event.callId, {
        ok: false,
        error: `No TeamSpeak realtime tool is registered for "${event.name}".`,
      });
      return;
    }
    try {
      const result = await registration.handle(event, {
        clientId: this.clientId,
        nickname: this.nickname,
      });
      await session.submitToolResult(event.callId, result);
    } catch (error) {
      // A thrown handler must still settle the call; the provider blocks its
      // turn until every outstanding tool result arrives.
      await session.submitToolResult(event.callId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleBridgeEvent(event: RealtimeVoiceBridgeEvent): void {
    if (event.direction === "server" && event.type === "response.created") {
      return;
    }
    this.params.log?.(`teamspeak voice: realtime ${event.direction}:${event.type}`);
  }
}

function buildProviderConfigs(
  realtimeConfig: TeamSpeakVoiceRealtimeConfig | undefined,
): Record<string, RealtimeVoiceProviderConfig | undefined> | undefined {
  const configs = realtimeConfig?.providers;
  return configs && Object.keys(configs).length > 0 ? { ...configs } : undefined;
}

function buildProviderConfigOverrides(
  realtimeConfig: TeamSpeakVoiceRealtimeConfig | undefined,
): RealtimeVoiceProviderConfig | undefined {
  const overrides = {
    ...(realtimeConfig?.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig?.speakerVoice
      ? { voice: realtimeConfig.speakerVoice }
      : realtimeConfig?.speakerVoiceId
        ? { voice: realtimeConfig.speakerVoiceId }
        : {}),
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export { canonicalizeRealtimeVoiceProviderId };
