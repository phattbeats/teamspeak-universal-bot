/**
 * The STT connector contract (PHA-3790, TOOL-CATALOG.md §4.7).
 *
 * Before this file, `sttProvider` was a *label*: the config carried a provider
 * name, `LOCAL_TRANSCRIPTION_PROVIDERS` checked it against a hardcoded array,
 * and then `stt-tts-lane.ts` ignored it and built `LocalWhisperTranscriber` as
 * primary and `MiniMaxAsrTranscriber` as secondary regardless. Swapping either
 * one meant editing two files. The lane also had to *feature-detect* the richer
 * `transcribeDetailed` method, because only the router carried it.
 *
 * So the contract below is small on purpose and says everything a transcriber
 * has to say:
 *
 *     transcribe(request) -> { text, provider, ms, confidence?, escalated? }
 *
 * Every implementation returns that — the local one, the hosted one, the router
 * that puts one in front of the other, and the concurrency limiter that wraps
 * the lot. Nothing feature-detects anything.
 *
 * Providers are registered by name in `stt-registry.ts` and chosen by name in
 * `channels.teamspeak.voice.streaming.transcription` /
 * `.secondaryTranscription`, which is per-account config and therefore per
 * persona: sexton and bexton read their own `openclaw.json`. Adding a provider
 * is one factory plus one `register` call; swapping one is a config edit.
 *
 * ## The $0 / hot-mic promise survives the widening
 *
 * `LOCAL_TRANSCRIPTION_PROVIDERS` used to be that promise expressed as code —
 * an unrecognized primary was refused at startup so the channel's audio could
 * not quietly start going to a metered third party. Dropping it for an open
 * registry would drop the promise with it, so the promise moved rather than
 * left: every factory declares a `kind`, and the lane refuses a `"hosted"`
 * provider in the *primary* slot unless that account also sets
 * `transcription.allowHosted: true`. The default is still "local only, or the
 * lane does not start" — it is now one explicit config key instead of a code
 * change, which is exactly the swap the issue asked for.
 */
import type { Buffer } from "node:buffer";

/**
 * Where a provider's audio goes.
 *
 * `"local"` means the audio never leaves the Docker network — the whisper pool
 * container (PHA-3598/3607). `"hosted"` means a metered third party, which the
 * primary slot refuses without an explicit opt-in.
 */
export type SttProviderKind = "local" | "hosted";

/**
 * Canonical provider names.
 *
 * They live in this file, which imports nothing from `config.ts`, so that
 * `config.ts` can name a default provider without an import cycle back through
 * a provider module.
 */
export const WHISPER_LOCAL_PROVIDER_ID = "whisper-local";
export const MINIMAX_ASR_PROVIDER_ID = "minimax-asr";

export type SttRequest = {
  /** One closed utterance, in the bridge's native 48 kHz mono PCM16. */
  pcm48kMono: Buffer;
  /** Speaker label, for logs only; a transcriber is per-segment, not per-person. */
  label: string;
  /**
   * The TS6 roster clientId of the speaker, when known. TeamSpeak assigns this
   * per session on its own server, so sexton and bexton — two independent
   * bridge connections into the same channel — see the identical value for the
   * identical human. Sent as a header so the coalescing whisper front end
   * (PHA-3607) can recognize that two nearly-simultaneous requests are the same
   * utterance and decode it once instead of twice. Purely advisory.
   */
  clientId?: number | undefined;
  /**
   * Segment length. Optional because a plain transcriber has no use for it;
   * `RoutingTranscriber` reads it to decide whether a long segment, or an
   * unexpected empty, is worth a second opinion (PHA-3428 item 3).
   */
  durationMs?: number | undefined;
  /**
   * ISO-639-1 hint, or "auto", overriding the provider's configured language
   * for this segment only. The contract carries it because a per-utterance
   * override is the one thing a caller can know that config cannot.
   */
  lang?: string | undefined;
  /**
   * Decoder priming text — names, jargon, the bot's own wake words. Overrides
   * the configured `prompt` for this segment. Providers that cannot use one
   * ignore it rather than failing (MiniMax `asr-1.0` has no such parameter).
   */
  prompt?: string | undefined;
  /**
   * Ask for the hosted secondary directly, for callers that want the better
   * transcript and can afford the wait — the history tools. Ignored when no
   * secondary is configured, or when it is backed off.
   */
  prefer?: "secondary" | undefined;
};

export type SttResult = {
  /** The transcript, or an empty string when the segment held no speech. */
  text: string;
  /**
   * Provider whose text this is, for `sttProvider` in the turn log. A router
   * reports whichever provider actually answered, not its own composite id.
   */
  provider: string;
  /** Wall-clock ms this provider spent. Excludes any queue wait ahead of it. */
  ms: number;
  /**
   * 0..1, when the provider supplies one. Usually absent: whisper.cpp only
   * scores under `response_format=verbose_json` (+~1.8s/turn, measured — see
   * `whisper-local.ts`), and MiniMax `asr-1.0` returns no confidence at all.
   * Anything reading this must handle `undefined`, not treat it as zero.
   */
  confidence?: number | undefined;
  /** True when a router consulted its secondary, whatever came back. */
  escalated?: boolean | undefined;
};

/**
 * Optional self-parking, for a provider that can be down rather than merely
 * slow. A router skips a parked secondary instead of paying its timeout on
 * every escalation; a provider that cannot park simply omits these.
 */
export type SttProviderHealth = {
  /** True when the last failure parked this provider and the park has not expired. */
  isBackedOff(): boolean;
  /** Remaining park time in ms, for the log and `!sexton status`. */
  backoffRemainingMs(): number;
};

export type SttProvider = Partial<SttProviderHealth> & {
  /** Provider id, surfaced in `!sexton status` and asserted on in tests. */
  readonly id: string;
  /** Where this provider's audio goes. See `SttProviderKind`. */
  readonly kind: SttProviderKind;
  transcribe(request: SttRequest): Promise<SttResult>;
};

/**
 * One provider slot's config, after resolution.
 *
 * Deliberately one type for both slots and every provider: the alternative is
 * a resolver per provider in `config.ts`, which is the code change this issue
 * exists to remove. Fields a given provider does not use are simply undefined
 * for it — `url` is whisper's, `baseUrl`/`apiKey` are a hosted provider's — and
 * each factory applies its own defaults and reports its own missing pieces.
 * `options` is the escape hatch that lets a provider added later take settings
 * without touching `config.ts` at all.
 */
export type ResolvedSttProviderConfig = {
  /** Provider name as written in config, before alias resolution. */
  provider: string;
  /** Endpoint for a provider that takes a full URL (whisper.cpp's `/inference`). */
  url: string | undefined;
  /** API base for a hosted provider, without the `/v1` suffix. */
  baseUrl: string | undefined;
  /** Credential for a hosted provider. */
  apiKey: string | undefined;
  /** Model id, when the provider has more than one. */
  model: string | undefined;
  /** ISO-639-1 hint, or "auto". */
  language: string;
  /** Default decoder priming text; `SttRequest.prompt` overrides per segment. */
  prompt: string | undefined;
  /** Ask the provider for a confidence score, where that costs extra. */
  confidence: boolean;
  /** Per-segment timeout. */
  timeoutMs: number;
  /** A success slower than this parks the provider anyway. */
  slowMs: number;
  /** How long a failure parks the provider. */
  backoffMs: number;
  /** Permit a `"hosted"` provider in the primary slot. Primary slot only. */
  allowHosted: boolean;
  /** Provider-specific extras, passed through untouched. */
  options: Record<string, unknown>;
};

export type SttProviderSlot = "primary" | "secondary";

export type SttProviderContext = {
  slot: SttProviderSlot;
  config: ResolvedSttProviderConfig;
  env: Record<string, string | undefined>;
  log?: ((message: string) => void) | undefined;
};

/**
 * A factory's failure is a value, not an exception, for the same reason the
 * config resolvers return one: an account that cannot build its transcriber
 * should report the same way a missing `bridgeUrl` does — a warning and a
 * runtime that never opens — rather than throwing out of `startAccount`.
 */
export type SttProviderCreateResult =
  | { ok: true; provider: SttProvider }
  | { ok: false; reason: string };

export type SttProviderFactory = {
  /** Canonical name, the one reported in logs and `!sexton status`. */
  readonly id: string;
  readonly kind: SttProviderKind;
  /** Extra names config may use for this provider, e.g. "minimax" for "minimax-asr". */
  readonly aliases?: readonly string[];
  create(context: SttProviderContext): SttProviderCreateResult;
};

/** Case-insensitive name → factory, with aliases. */
export class SttProviderRegistry {
  private readonly byName = new Map<string, SttProviderFactory>();
  private readonly canonical: string[] = [];

  register(factory: SttProviderFactory): this {
    for (const name of [factory.id, ...(factory.aliases ?? [])]) {
      const key = normalizeProviderName(name);
      const existing = this.byName.get(key);
      if (existing && existing.id !== factory.id) {
        throw new Error(
          `stt provider name "${name}" is already registered by "${existing.id}"`,
        );
      }
      this.byName.set(key, factory);
    }
    if (!this.canonical.includes(factory.id)) {
      this.canonical.push(factory.id);
    }
    return this;
  }

  get(name: string | undefined): SttProviderFactory | undefined {
    return this.byName.get(normalizeProviderName(name ?? ""));
  }

  /** Canonical ids only, in registration order — for the "not one of …" messages. */
  names(): string[] {
    return [...this.canonical];
  }

  /** Canonical ids whose audio stays on the Docker network. */
  localNames(): string[] {
    return this.canonical.filter((id) => this.get(id)?.kind === "local");
  }

  /**
   * Build the provider for one slot, or explain why not.
   *
   * Two refusals live here rather than in each factory, because both are
   * properties of the *slot*, not of the provider: an unknown name, and a
   * hosted provider asked to be primary without `allowHosted`.
   */
  create(context: SttProviderContext): SttProviderCreateResult {
    const factory = this.get(context.config.provider);
    if (!factory) {
      return {
        ok: false,
        reason:
          `stt provider "${context.config.provider}" is not registered ` +
          `(${this.names().join(", ")}).`,
      };
    }
    if (context.slot === "primary" && factory.kind === "hosted" && !context.config.allowHosted) {
      return {
        ok: false,
        reason:
          `stt provider "${factory.id}" is hosted, and voice.mode=stt-tts keeps the ` +
          "channel's audio on the Docker network by default. Either use a local " +
          `provider (${this.localNames().join(", ")}) or set ` +
          "voice.streaming.transcription.allowHosted: true to send speaker audio " +
          "to a metered third party on every turn.",
      };
    }
    return factory.create(context);
  }
}

export function normalizeProviderName(name: string): string {
  return name.trim().toLowerCase();
}

/** Shared by the providers so `ms` means the same thing in every result. */
export function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}
