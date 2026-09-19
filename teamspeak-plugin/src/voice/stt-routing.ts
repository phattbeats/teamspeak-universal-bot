/**
 * Primary/secondary transcription routing (PHA-3428 item 3).
 *
 * whisper.cpp stays primary on every turn. MiniMax `asr-1.0` is reached only on
 * escalation, so an ordinary turn costs exactly what it costs today and the
 * channel's "transcribed locally" promise stays true for the common case.
 *
 * ## Why "low whisper confidence" is not the trigger the issue asked for
 *
 * PHA-3428 names low whisper confidence as an escalation condition. whisper.cpp
 * will supply one — `avg_logprob` / `no_speech_prob` — but only under
 * `response_format=verbose_json`, and that format is not free. Measured on the
 * live container against one 3.29s clip, alternating formats:
 *
 *     json          1664ms   1939ms   2085ms
 *     verbose_json  3417ms   3727ms
 *
 * Roughly +1.8s on EVERY turn, paid to obtain a number that changes the outcome
 * on a small minority of them. Item 2 of the same issue spent this heartbeat's
 * predecessor getting sttMs down from 6-11s to ~1.7s; buying a confidence score
 * at that price would hand most of it straight back. So the score is not taken,
 * and the two conditions below are used instead. Both are free — they are read
 * off the segment and the transcript we already have.
 *
 *   1. `durationMs > longSegmentMs` (default 8s) — the issue's own second
 *      condition, and the case where whisper's quality actually degrades.
 *   2. whisper returned NOTHING for a segment long enough that it should have
 *      returned something. This is the honest proxy for low confidence: an
 *      empty transcript IS whisper reporting no confidence, just in the one
 *      form it will give up for free. It is also the exact symptom in the
 *      issue's own log excerpt (`empty transcript ... segmentMs=2120`).
 *
 * `prefer: "secondary"` remains for callers that want MiniMax regardless — the
 * history tools (`what_did_i_miss`) the issue lists third.
 *
 * ## Futile escalation
 *
 * Condition 2 assumes an empty transcript means whisper missed something. For
 * one speaker on the live channel it meant the opposite: a mic producing 1.6-1.9s
 * segments of nothing, over and over, each one escalating and each one coming
 * back empty from MiniMax too (observed 2026-09-13, clientId=32). The provider
 * backoff caught it only because those calls were also slow, which is luck, not
 * design — it is a provider-health guard, not a this-is-pointless guard.
 *
 * So escalation is also suppressed per speaker after `maxFruitlessEscalations`
 * in a row come back empty, until `fruitlessCooldownMs` passes. Any non-empty
 * result clears it immediately, so a speaker who was quiet and then talks is
 * not punished for the silence.
 *
 * If the trade is ever worth re-opening, the seam is `shouldEscalate`, and the
 * cost to re-measure is the table above.
 */
import type { ResolvedTeamSpeakRoutingConfig } from "../config.js";
import type { MiniMaxAsrTranscriber } from "./minimax-asr.js";
import type { SegmentTranscriber, TranscriptionRequest } from "./whisper-local.js";

export type TranscriptionOutcome = {
  text: string;
  /** Provider whose text this is, for `sttProvider` in the turn log. */
  provider: string;
  /** True when the secondary was consulted, whatever it returned. */
  escalated: boolean;
};

export type RoutingTranscriberParams = {
  primary: SegmentTranscriber;
  secondary: MiniMaxAsrTranscriber;
  config: ResolvedTeamSpeakRoutingConfig;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
};

export class RoutingTranscriber implements SegmentTranscriber {
  /** Per-speaker record of escalations that came back with nothing. */
  private readonly fruitless = new Map<string, { count: number; suppressedUntil: number }>();
  private readonly now: () => number;

  constructor(private readonly params: RoutingTranscriberParams) {
    this.now = params.now ?? Date.now;
  }

  get id(): string {
    return `${this.params.primary.id}+${this.params.secondary.id}`;
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    return (await this.transcribeDetailed(request)).text;
  }

  async transcribeDetailed(request: TranscriptionRequest): Promise<TranscriptionOutcome> {
    const { primary, secondary, config } = this.params;

    // The history tools want the better transcript and can afford the wait.
    if (request.prefer === "secondary" && !secondary.isBackedOff()) {
      const forced = await this.trySecondary(request);
      if (forced !== undefined) {
        return { text: forced, provider: secondary.id, escalated: true };
      }
    }

    const text = await primary.transcribe(request);
    if (!this.shouldEscalate({ text, request })) {
      return { text, provider: primary.id, escalated: false };
    }
    if (secondary.isBackedOff()) {
      this.params.log?.(
        `teamspeak voice: stt escalation skipped, ${secondary.id} backed off for ` +
          `${Math.round(secondary.backoffRemainingMs() / 1000)}s more`,
      );
      return { text, provider: primary.id, escalated: false };
    }
    if (this.isFutile(request.label)) {
      return { text, provider: primary.id, escalated: false };
    }

    const better = await this.trySecondary(request);
    if (better === undefined) {
      // The secondary failed and said why in its own log line. whisper's answer
      // is still the answer — an escalation is an upgrade attempt, never a
      // reason to lose the turn.
      return { text, provider: primary.id, escalated: true };
    }
    if (!better) {
      // Both heard silence. That is agreement, not a failure, and the segment
      // really was noise — but a speaker who is *only* ever noise should stop
      // costing us a round trip a second.
      this.noteFruitless(request.label);
      return { text: "", provider: secondary.id, escalated: true };
    }
    this.fruitless.delete(request.label);
    return { text: better, provider: secondary.id, escalated: true };
  }

  /** True while this speaker is suppressed for producing nothing repeatedly. */
  private isFutile(label: string): boolean {
    const state = this.fruitless.get(label);
    if (!state) {
      return false;
    }
    if (state.suppressedUntil === 0 || this.now() >= state.suppressedUntil) {
      if (state.suppressedUntil !== 0) {
        // Cooldown served; give the speaker a clean slate rather than letting
        // one stale streak suppress them forever.
        this.fruitless.delete(label);
      }
      return false;
    }
    return true;
  }

  private noteFruitless(label: string): void {
    const state = this.fruitless.get(label) ?? { count: 0, suppressedUntil: 0 };
    state.count += 1;
    if (state.count >= this.params.config.maxFruitlessEscalations) {
      state.suppressedUntil = this.now() + this.params.config.fruitlessCooldownMs;
      state.count = 0;
      this.params.log?.(
        `teamspeak voice: stt escalation suppressed for ${label} for ` +
          `${Math.round(this.params.config.fruitlessCooldownMs / 1000)}s ` +
          `(${this.params.config.maxFruitlessEscalations} escalations in a row heard nothing)`,
      );
    }
    this.fruitless.set(label, state);
  }

  /** Returns the transcript, or undefined when the secondary failed outright. */
  private async trySecondary(request: TranscriptionRequest): Promise<string | undefined> {
    try {
      return await this.params.secondary.transcribe(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.params.log?.(`teamspeak voice: stt secondary failed, keeping whisper: ${message}`);
      return undefined;
    }
  }

  private shouldEscalate(input: { text: string; request: TranscriptionRequest }): boolean {
    const durationMs = input.request.durationMs ?? 0;
    if (durationMs > this.params.config.longSegmentMs) {
      return true;
    }
    // Condition 2: see the file header. Short empties are room tone and are
    // exactly what item 2's pre-STT gate exists to throw away — escalating them
    // would put the cost right back on the noise floor.
    return !input.text && durationMs >= this.params.config.emptyEscalationMinMs;
  }
}
