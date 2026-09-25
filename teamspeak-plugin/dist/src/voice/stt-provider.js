const WHISPER_LOCAL_PROVIDER_ID = "whisper-local";
const MINIMAX_ASR_PROVIDER_ID = "minimax-asr";
class SttProviderRegistry {
  byName = /* @__PURE__ */ new Map();
  canonical = [];
  register(factory) {
    for (const name of [factory.id, ...factory.aliases ?? []]) {
      const key = normalizeProviderName(name);
      const existing = this.byName.get(key);
      if (existing && existing.id !== factory.id) {
        throw new Error(
          `stt provider name "${name}" is already registered by "${existing.id}"`
        );
      }
      this.byName.set(key, factory);
    }
    if (!this.canonical.includes(factory.id)) {
      this.canonical.push(factory.id);
    }
    return this;
  }
  get(name) {
    return this.byName.get(normalizeProviderName(name ?? ""));
  }
  /** Canonical ids only, in registration order — for the "not one of …" messages. */
  names() {
    return [...this.canonical];
  }
  /** Canonical ids whose audio stays on the Docker network. */
  localNames() {
    return this.canonical.filter((id) => this.get(id)?.kind === "local");
  }
  /**
   * Build the provider for one slot, or explain why not.
   *
   * Two refusals live here rather than in each factory, because both are
   * properties of the *slot*, not of the provider: an unknown name, and a
   * hosted provider asked to be primary without `allowHosted`.
   */
  create(context) {
    const factory = this.get(context.config.provider);
    if (!factory) {
      return {
        ok: false,
        reason: `stt provider "${context.config.provider}" is not registered (${this.names().join(", ")}).`
      };
    }
    if (context.slot === "primary" && factory.kind === "hosted" && !context.config.allowHosted) {
      return {
        ok: false,
        reason: `stt provider "${factory.id}" is hosted, and voice.mode=stt-tts keeps the channel's audio on the Docker network by default. Either use a local provider (${this.localNames().join(", ")}) or set voice.streaming.transcription.allowHosted: true to send speaker audio to a metered third party on every turn.`
      };
    }
    return factory.create(context);
  }
}
function normalizeProviderName(name) {
  return name.trim().toLowerCase();
}
function elapsedMs(startedAt, now) {
  return Math.max(0, now() - startedAt);
}
export {
  MINIMAX_ASR_PROVIDER_ID,
  SttProviderRegistry,
  WHISPER_LOCAL_PROVIDER_ID,
  elapsedMs,
  normalizeProviderName
};
