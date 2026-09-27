import {
  elapsedMs
} from "./stt-provider.js";
class RoutingTranscriber {
  constructor(params) {
    this.params = params;
    this.now = params.now ?? Date.now;
  }
  params;
  /** Per-speaker record of escalations that came back with nothing. */
  fruitless = /* @__PURE__ */ new Map();
  now;
  get id() {
    return `${this.params.primary.id}+${this.params.secondary.id}`;
  }
  /**
   * Hosted if *either* leg is: a composite that can send audio off the box is
   * not a local transcriber, whichever leg usually answers.
   */
  get kind() {
    return this.params.primary.kind === "hosted" || this.params.secondary.kind === "hosted" ? "hosted" : "local";
  }
  async transcribe(request) {
    const startedAt = this.now();
    const { primary, secondary, config } = this.params;
    const ms = () => elapsedMs(startedAt, this.now);
    if (request.prefer === "secondary" && !isBackedOff(secondary)) {
      const forced = await this.trySecondary(request);
      if (forced !== void 0) {
        return { ...forced, ms: ms(), escalated: true };
      }
    }
    const first = await primary.transcribe(request);
    if (!this.shouldEscalate({ text: first.text, request })) {
      return { ...first, ms: ms(), escalated: false };
    }
    if (isBackedOff(secondary)) {
      this.params.log?.(
        `teamspeak voice: stt escalation skipped, ${secondary.id} backed off for ${Math.round((secondary.backoffRemainingMs?.() ?? 0) / 1e3)}s more`
      );
      return { ...first, ms: ms(), escalated: false };
    }
    if (this.isFutile(request.label)) {
      return { ...first, ms: ms(), escalated: false };
    }
    const better = await this.trySecondary(request);
    if (better === void 0) {
      return { ...first, ms: ms(), escalated: true };
    }
    if (!better.text) {
      this.noteFruitless(request.label);
      return { ...better, text: "", ms: ms(), escalated: true };
    }
    this.fruitless.delete(request.label);
    return { ...better, ms: ms(), escalated: true };
  }
  /** True while this speaker is suppressed for producing nothing repeatedly. */
  isFutile(label) {
    const state = this.fruitless.get(label);
    if (!state) {
      return false;
    }
    if (state.suppressedUntil === 0 || this.now() >= state.suppressedUntil) {
      if (state.suppressedUntil !== 0) {
        this.fruitless.delete(label);
      }
      return false;
    }
    return true;
  }
  noteFruitless(label) {
    const state = this.fruitless.get(label) ?? { count: 0, suppressedUntil: 0 };
    state.count += 1;
    if (state.count >= this.params.config.maxFruitlessEscalations) {
      state.suppressedUntil = this.now() + this.params.config.fruitlessCooldownMs;
      state.count = 0;
      this.params.log?.(
        `teamspeak voice: stt escalation suppressed for ${label} for ${Math.round(this.params.config.fruitlessCooldownMs / 1e3)}s (${this.params.config.maxFruitlessEscalations} escalations in a row heard nothing)`
      );
    }
    this.fruitless.set(label, state);
  }
  /** Returns the secondary's result, or undefined when it failed outright. */
  async trySecondary(request) {
    try {
      return await this.params.secondary.transcribe(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.params.log?.(
        `teamspeak voice: stt secondary failed, keeping ${this.params.primary.id}: ${message}`
      );
      return void 0;
    }
  }
  shouldEscalate(input) {
    const durationMs = input.request.durationMs ?? 0;
    if (durationMs > this.params.config.longSegmentMs) {
      return true;
    }
    return !input.text && durationMs >= this.params.config.emptyEscalationMinMs;
  }
}
function isBackedOff(provider) {
  return provider.isBackedOff?.() ?? false;
}
export {
  RoutingTranscriber
};
