/**
 * Streaming text -> speech -> room playback (PHA-3792).
 *
 * Before this the stt-tts session waited for the WHOLE agent reply, split it
 * into sentences, and only then started the first T2A call. Now the reply
 * arrives in blocks while the model is still generating, and every block is
 * pushed here the moment it lands. The pipeline owns the part that must stay
 * ordered: each block is split into speakable chunks, chunks are synthesized
 * in push order with one call in flight ahead of playback (the PHA-3789
 * prefetch, unchanged), and the frames go on the room queue in that same
 * order. The first chunk's audio is on the wire while the model is still
 * writing the last sentence.
 *
 * `finish()` is the one signal the producer owes it: after that, no more text
 * comes, and the returned promise settles once every chunk has either played
 * or been abandoned. `isLive()` is the barge-in seam -- checked before every
 * enqueue so a turn retired mid-synthesis goes quiet without the pipeline
 * needing to know why.
 */
import { bridgePcmDurationMs, chunkBridgePcm } from "./audio.js";
import type { RoomPlaybackQueue } from "./room-playback.js";
import { splitIntoSpeechChunks, type SpeechSynthesizer } from "./speech.js";

export type SpeechPipelineParams = {
  synthesizer: SpeechSynthesizer;
  playback: RoomPlaybackQueue;
  ownerKey: string;
  /** False once the turn is retired (barge-in, close): nothing more is played. */
  isLive: () => boolean;
  /** Split incoming text into chunks; defaults to the sentence splitter. */
  split?: ((text: string) => string[]) | undefined;
  /** How many synthesis calls may run ahead of playback. Default 1. */
  prefetch?: number | undefined;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
};

export type SpeechPipelineResult = {
  /** Chunks whose audio reached the room queue. */
  spokenChunks: number;
  /** Chunks the producer pushed, spoken or not. */
  totalChunks: number;
  /** Synthesis time of the first chunk; the `ttsMs` of the turn log. */
  firstChunkTtsMs: number | undefined;
  /** `now()` when the first frame was enqueued; undefined if nothing played. */
  firstAudioAt: number | undefined;
  /** `now()` when the first chunk's synthesis started; undefined if no text came. */
  firstSynthesisAt: number | undefined;
  totalAudioMs: number;
  speechProvider: string | undefined;
  /** Set when a chunk failed before anything had played: the turn failed. */
  error: string | undefined;
};

type ChunkSynthesis = Promise<{
  outcome: Awaited<ReturnType<SpeechSynthesizer["synthesize"]>>;
  ttsMs: number;
}>;

export class SpeechPipeline {
  private readonly chunks: string[] = [];
  private readonly synthesis: Array<ChunkSynthesis | undefined> = [];
  private readonly now: () => number;
  private readonly split: (text: string) => string[];
  private readonly prefetch: number;
  private closed = false;
  private playIndex = 0;
  private wake: (() => void) | undefined;
  private readonly done: Promise<SpeechPipelineResult>;
  private firstSynthesisAt: number | undefined;

  constructor(private readonly params: SpeechPipelineParams) {
    this.now = params.now ?? (() => Date.now());
    this.split = params.split ?? splitIntoSpeechChunks;
    this.prefetch = Math.max(0, params.prefetch ?? 1);
    this.done = this.run();
  }

  /** More reply text. Safe to call from a callback; never throws. */
  push(text: string): void {
    if (this.closed) {
      return;
    }
    for (const chunk of this.split(text)) {
      this.chunks.push(chunk);
    }
    this.schedule();
    this.wake?.();
  }

  /** No more text is coming; resolves when playback of what came is queued. */
  finish(): Promise<SpeechPipelineResult> {
    this.closed = true;
    this.wake?.();
    return this.done;
  }

  /** Start synthesis for every chunk within the prefetch window. */
  private schedule(): void {
    const limit = Math.min(this.chunks.length, this.playIndex + 1 + this.prefetch);
    for (let index = 0; index < limit; index += 1) {
      if (this.synthesis[index]) {
        continue;
      }
      const startedAt = this.now();
      this.firstSynthesisAt ??= startedAt;
      const pending: ChunkSynthesis = this.params.synthesizer
        .synthesize(this.chunks[index] as string)
        .then((outcome) => ({ outcome, ttsMs: this.now() - startedAt }));
      // A prefetch that fails after the turn is retired must not surface as an
      // unhandled rejection; its outcome is only read if playback reaches it.
      pending.catch(() => undefined);
      this.synthesis[index] = pending;
    }
  }

  private async run(): Promise<SpeechPipelineResult> {
    const result: SpeechPipelineResult = {
      spokenChunks: 0,
      totalChunks: 0,
      firstChunkTtsMs: undefined,
      firstAudioAt: undefined,
      firstSynthesisAt: undefined,
      totalAudioMs: 0,
      speechProvider: undefined,
      error: undefined,
    };
    for (;;) {
      while (this.playIndex >= this.chunks.length && !this.closed) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
      if (this.playIndex >= this.chunks.length) {
        break;
      }
      if (!this.params.isLive()) {
        break;
      }
      this.schedule();
      const index = this.playIndex;
      const current = this.synthesis[index] as ChunkSynthesis;
      let chunk: Awaited<ChunkSynthesis>;
      try {
        chunk = await current;
      } catch (error) {
        chunk = {
          outcome: { status: "failed", error: error instanceof Error ? error.message : String(error) },
          ttsMs: 0,
        };
      }
      this.playIndex += 1;
      if (index === 0) {
        result.firstChunkTtsMs = chunk.ttsMs;
      }
      if (!this.params.isLive()) {
        break;
      }
      if (chunk.outcome.status === "empty") {
        continue;
      }
      if (chunk.outcome.status === "failed") {
        // The first chunk failing fails the turn, same as the old one-call
        // behavior. A later chunk failing does not retroactively fail a turn
        // that already spoke something -- stop here and keep what played.
        if (result.spokenChunks === 0) {
          result.error = chunk.outcome.error;
        } else {
          this.params.log?.(
            `teamspeak voice: speech chunk failed chunk=${index + 1}: ${chunk.outcome.error}`,
          );
        }
        break;
      }
      for (const frame of chunkBridgePcm(chunk.outcome.pcm48kMono)) {
        this.params.playback.enqueue(this.params.ownerKey, frame);
      }
      result.spokenChunks += 1;
      result.totalAudioMs += bridgePcmDurationMs(chunk.outcome.pcm48kMono);
      result.speechProvider ??= chunk.outcome.provider;
      // The real "first audio" instant: the bridge starts streaming these
      // frames out while later chunks (and the rest of the reply) are still
      // being produced, so this is stamped here, not at the end.
      result.firstAudioAt ??= this.now();
    }
    this.closed = true;
    result.totalChunks = this.chunks.length;
    result.firstSynthesisAt = this.firstSynthesisAt;
    return result;
  }
}
