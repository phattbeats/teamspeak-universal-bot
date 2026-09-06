/**
 * Wake-name gating for the room.
 *
 * The policy itself is SDK-owned and shared with Discord: `automatic` (the
 * default for agent-proxy) requires a wake name only once a second human is in
 * the channel, because with one human every utterance is unambiguously
 * addressed to the Sexton. Barge-in is disabled whenever the gate is active,
 * matching Discord — an ungated interrupt would let one person's crosstalk cut
 * off an answer that was addressed to someone else.
 */
import {
  isRealtimeVoiceWakeNameRequired,
  resolveRealtimeVoiceBargeIn,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import type { TeamSpeakVoiceRealtimeConfig } from "../config.js";

export type WakeGateParams = {
  wakeNamePolicy: () => RealtimeVoiceWakeNamePolicy;
  humanParticipantCount: () => number;
  realtimeConfig: () => TeamSpeakVoiceRealtimeConfig | undefined;
  providerId: () => string | undefined;
};

export class WakeGate {
  constructor(private readonly params: WakeGateParams) {}

  isWakeNameRequired(humanParticipantCount = this.params.humanParticipantCount()): boolean {
    return isRealtimeVoiceWakeNameRequired(this.params.wakeNamePolicy(), humanParticipantCount);
  }

  /**
   * Barge-in is off while the wake gate is active. Discord makes the same call
   * in DiscordRealtimePlayback.isBargeInEnabled().
   */
  isBargeInEnabled(): boolean {
    if (this.isWakeNameRequired()) {
      return false;
    }
    const realtimeConfig = this.params.realtimeConfig();
    const providerId = this.params.providerId() ?? realtimeConfig?.provider ?? "openai";
    return resolveRealtimeVoiceBargeIn({
      configuredBargeIn: realtimeConfig?.bargeIn,
      interruptResponseOnInputAudio:
        realtimeConfig?.providers?.[providerId]?.interruptResponseOnInputAudio,
    });
  }
}
