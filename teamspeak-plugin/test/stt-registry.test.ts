/**
 * STT as a connector (#3790, TOOL-CATALOG.md §4.7).
 *
 * The claim under test is the one the issue asked for: a persona swaps its
 * transcriber by editing config, with no code change — and the $0 / hot-mic
 * promise that the old hardcoded `LOCAL_TRANSCRIPTION_PROVIDERS` array used to
 * make still holds, now as a slot rule rather than an allowlist.
 *
 * So the load-bearing assertions are: an unknown name refuses by name, a hosted
 * provider cannot become the primary by accident, a provider's own missing
 * pieces refuse with a reason instead of a broken transcriber, and the default
 * config still builds exactly what it built before.
 */
import { describe, expect, it } from "vitest";
import type { TeamSpeakAccountConfig } from "../src/config.js";
import {
  resolveTeamSpeakSecondaryTranscriptionConfig,
  resolveTeamSpeakTranscriptionConfig,
} from "../src/config.js";
import {
  MINIMAX_ASR_PROVIDER_ID,
  SttProviderRegistry,
  WHISPER_LOCAL_PROVIDER_ID,
  type SttProviderFactory,
} from "../src/voice/stt-provider.js";
import { createDefaultSttProviderRegistry } from "../src/voice/stt-registry.js";
import { sttSlotConfig } from "./stt-fixtures.js";

const primary = (config: Parameters<typeof sttSlotConfig>[0] = {}, env = {}) => ({
  slot: "primary" as const,
  config: sttSlotConfig(config),
  env,
});

const secondary = (config: Parameters<typeof sttSlotConfig>[0] = {}, env = {}) => ({
  slot: "secondary" as const,
  config: sttSlotConfig({ allowHosted: true, ...config }),
  env,
});

describe("the built-in registry", () => {
  it("registers whisper-local and minimax-asr, in that order", () => {
    const registry = createDefaultSttProviderRegistry();
    expect(registry.names()).toEqual([WHISPER_LOCAL_PROVIDER_ID, MINIMAX_ASR_PROVIDER_ID]);
    expect(registry.localNames()).toEqual([WHISPER_LOCAL_PROVIDER_ID]);
  });

  it("resolves names case-insensitively and through aliases", () => {
    const registry = createDefaultSttProviderRegistry();
    // "minimax" is the name the issue wrote; "minimax-asr" is what the wire
    // and the turn log call it. Both have to work or the config is a trap.
    expect(registry.get("minimax")?.id).toBe("minimax-asr");
    expect(registry.get("  WHISPER-Local ")?.id).toBe("whisper-local");
    expect(registry.get("whisper")?.id).toBe("whisper-local");
    expect(registry.get("deepgram")).toBeUndefined();
  });

  it("refuses to let two factories claim one name", () => {
    const registry = createDefaultSttProviderRegistry();
    const impostor: SttProviderFactory = {
      id: "something-else",
      kind: "local",
      aliases: ["whisper"],
      create: () => ({ ok: false, reason: "never called" }),
    };
    expect(() => registry.register(impostor)).toThrow(/already registered by "whisper-local"/);
  });
});

describe("choosing a provider by name", () => {
  it("builds whisper-local for the default config, pointed at the pool container", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(primary());
    expect(built.ok).toBe(true);
    expect(built.ok === true && built.provider.id).toBe("whisper-local");
    expect(built.ok === true && built.provider.kind).toBe("local");
  });

  it("names every registered provider when config asks for one that is not", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(primary({ provider: "deepgram" }));
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toMatch(/"deepgram" is not registered/);
    expect(built.ok === false && built.reason).toMatch(/whisper-local, minimax-asr/);
  });

  it("takes a fake provider registered by a caller, with no change to config or lane", () => {
    // This is the whole point: a new transcriber is a factory plus a register
    // call, and then it is selectable by name.
    const registry = createDefaultSttProviderRegistry().register({
      id: "acme-stt",
      kind: "local",
      create: () => ({
        ok: true,
        provider: {
          id: "acme-stt",
          kind: "local",
          transcribe: async () => ({ text: "acme heard it", provider: "acme-stt", ms: 5 }),
        },
      }),
    });
    const built = registry.create(primary({ provider: "acme-stt" }));
    expect(built.ok === true && built.provider.id).toBe("acme-stt");
  });
});

describe("the hot-mic promise, as a slot rule", () => {
  it("refuses a hosted provider in the primary slot by default", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(primary({ provider: "minimax-asr", apiKey: "k" }));
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toMatch(/is hosted/);
    // The refusal has to say what to do about it, both ways.
    expect(built.ok === false && built.reason).toMatch(/whisper-local/);
    expect(built.ok === false && built.reason).toMatch(/allowHosted/);
  });

  it("allows it once the persona says so out loud", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(
      primary({ provider: "minimax-asr", apiKey: "k", allowHosted: true }),
    );
    expect(built.ok).toBe(true);
    expect(built.ok === true && built.provider.kind).toBe("hosted");
  });

  it("does not gate the secondary slot, where hosted is the point", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(secondary({ provider: "minimax-asr", apiKey: "k" }));
    expect(built.ok).toBe(true);
    expect(built.ok === true && built.provider.id).toBe("minimax-asr");
  });
});

describe("a provider refuses on its own missing pieces", () => {
  it("will not build minimax-asr without a key anywhere", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(secondary({ provider: "minimax-asr" }));
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toMatch(/needs an apiKey/);
    expect(built.ok === false && built.reason).toMatch(/MINIMAX_API_KEY/);
  });

  it("takes the key from the environment when the config block opted in", () => {
    const registry = createDefaultSttProviderRegistry();
    const built = registry.create(
      secondary({ provider: "minimax-asr" }, { MINIMAX_API_KEY: "sk-cp-live-key" }),
    );
    expect(built.ok).toBe(true);
  });

  it("refuses everything on an empty registry, rather than guessing a provider", () => {
    const built = new SttProviderRegistry().create(primary());
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toMatch(/not registered/);
  });
});

describe("the config side of the swap", () => {
  const withTranscription = (
    transcription: Record<string, unknown>,
  ): TeamSpeakAccountConfig => ({ voice: { streaming: { transcription } } }) as TeamSpeakAccountConfig;

  it("defaults to whisper-local with the settings the lane ran before #3790", () => {
    const resolved = resolveTeamSpeakTranscriptionConfig({});
    expect(resolved.provider).toBe("whisper-local");
    expect(resolved.language).toBe("en");
    expect(resolved.timeoutMs).toBe(15_000);
    // Both of the new knobs are off, so an existing openclaw.json behaves
    // exactly as it did: json responses, no decoder priming.
    expect(resolved.confidence).toBe(false);
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.allowHosted).toBe(false);
  });

  it("carries the whole slot through, including provider-specific extras", () => {
    const resolved = resolveTeamSpeakTranscriptionConfig(
      withTranscription({
        provider: "acme-stt",
        baseUrl: "https://acme.example/",
        apiKey: "sk-acme",
        model: "acme-1",
        language: "auto",
        prompt: "Sexton, Bexton",
        confidence: true,
        timeoutMs: 4_000,
        allowHosted: true,
        options: { beamSize: 5 },
      }),
    );
    expect(resolved).toMatchObject({
      provider: "acme-stt",
      baseUrl: "https://acme.example/",
      apiKey: "sk-acme",
      model: "acme-1",
      language: "auto",
      prompt: "Sexton, Bexton",
      confidence: true,
      timeoutMs: 4_000,
      allowHosted: true,
      options: { beamSize: 5 },
    });
  });

  it("keeps the secondary slot's escalation tuning next to its provider", () => {
    const resolved = resolveTeamSpeakSecondaryTranscriptionConfig({
      voice: { streaming: { secondaryTranscription: { longSegmentMs: 5_000, slowMs: 1_000 } } },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.routing.longSegmentMs).toBe(5_000);
    expect(resolved.ok === true && resolved.config.slowMs).toBe(1_000);
  });
});
