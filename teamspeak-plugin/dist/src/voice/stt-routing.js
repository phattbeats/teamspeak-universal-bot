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
  async transcribe(request) {
    return (await this.transcribeDetailed(request)).text;
  }
  async transcribeDetailed(request) {
    const { primary, secondary, config } = this.params;
    if (request.prefer === "secondary" && !secondary.isBackedOff()) {
      const forced = await this.trySecondary(request);
      if (forced !== void 0) {
        return { text: forced, provider: secondary.id, escalated: true };
      }
    }
    const text = await primary.transcribe(request);
    if (!this.shouldEscalate({ text, request })) {
      return { text, provider: primary.id, escalated: false };
    }
    if (secondary.isBackedOff()) {
      this.params.log?.(
        `teamspeak voice: stt escalation skipped, ${secondary.id} backed off for ${Math.round(secondary.backoffRemainingMs() / 1e3)}s more`
      );
      return { text, provider: primary.id, escalated: false };
    }
    if (this.isFutile(request.label)) {
      return { text, provider: primary.id, escalated: false };
    }
    const better = await this.trySecondary(request);
    if (better === void 0) {
      return { text, provider: primary.id, escalated: true };
    }
    if (!better) {
      this.noteFruitless(request.label);
      return { text: "", provider: secondary.id, escalated: true };
    }
    this.fruitless.delete(request.label);
    return { text: better, provider: secondary.id, escalated: true };
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
  /** Returns the transcript, or undefined when the secondary failed outright. */
  async trySecondary(request) {
    try {
      return await this.params.secondary.transcribe(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.params.log?.(`teamspeak voice: stt secondary failed, keeping whisper: ${message}`);
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
export {
  RoutingTranscriber
};
