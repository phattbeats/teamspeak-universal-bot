/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/tts-runtime`.
 *
 * Only the two functions `src/voice/speech.ts` imports for the lane's startup
 * TTS check. Reports every provider as configured so tests that do not care
 * about the check are unaffected; tests that do inject
 * `deps.isSpeechProviderConfigured` instead.
 */
export type ResolvedTtsConfig = Record<string, unknown>;

export function resolveTtsConfig(_cfg: unknown): ResolvedTtsConfig {
  return {};
}

export function isTtsProviderConfigured(
  _config: ResolvedTtsConfig,
  _provider: string,
  _cfg?: unknown,
): boolean {
  return true;
}
