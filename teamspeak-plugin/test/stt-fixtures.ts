/**
 * One place to build a resolved STT provider slot for a test (PHA-3790).
 *
 * The slot config is deliberately one wide shape for every provider, so a test
 * that cares about two fields should not have to spell out the other ten.
 */
import type { ResolvedSttProviderConfig, SttProvider, SttResult } from "../src/voice/stt-provider.js";

export function sttSlotConfig(
  overrides: Partial<ResolvedSttProviderConfig> = {},
): ResolvedSttProviderConfig {
  return {
    provider: "whisper-local",
    url: undefined,
    baseUrl: undefined,
    apiKey: undefined,
    model: undefined,
    language: "en",
    prompt: undefined,
    confidence: false,
    timeoutMs: 15_000,
    slowMs: 3_000,
    backoffMs: 600_000,
    allowHosted: false,
    options: {},
    ...overrides,
  };
}

/** A provider that always answers with the same text, for router tests. */
export function fixedProvider(params: {
  id: string;
  text: string;
  kind?: SttProvider["kind"];
  ms?: number;
  confidence?: number;
}): SttProvider {
  return {
    id: params.id,
    kind: params.kind ?? "local",
    transcribe: async (): Promise<SttResult> => ({
      text: params.text,
      provider: params.id,
      ms: params.ms ?? 1,
      ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
    }),
  };
}
