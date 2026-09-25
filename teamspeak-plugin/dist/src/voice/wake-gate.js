import {
  isRealtimeVoiceWakeNameRequired,
  resolveRealtimeVoiceBargeIn
} from "openclaw/plugin-sdk/realtime-voice";
class WakeGate {
  constructor(params) {
    this.params = params;
  }
  params;
  isWakeNameRequired(humanParticipantCount = this.params.humanParticipantCount()) {
    return isRealtimeVoiceWakeNameRequired(this.params.wakeNamePolicy(), humanParticipantCount);
  }
  /**
   * Barge-in is off while the wake gate is active. Discord makes the same call
   * in DiscordRealtimePlayback.isBargeInEnabled().
   */
  isBargeInEnabled() {
    if (this.isWakeNameRequired()) {
      return false;
    }
    const realtimeConfig = this.params.realtimeConfig();
    const providerId = this.params.providerId() ?? realtimeConfig?.provider ?? "openai";
    return resolveRealtimeVoiceBargeIn({
      configuredBargeIn: realtimeConfig?.bargeIn,
      interruptResponseOnInputAudio: realtimeConfig?.providers?.[providerId]?.interruptResponseOnInputAudio
    });
  }
}
export {
  WakeGate
};
