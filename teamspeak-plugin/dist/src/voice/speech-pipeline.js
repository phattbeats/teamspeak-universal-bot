import { bridgePcmDurationMs, chunkBridgePcm } from "./audio.js";
import { splitIntoSpeechChunks } from "./speech.js";
class SpeechPipeline {
  constructor(params) {
    this.params = params;
    this.now = params.now ?? (() => Date.now());
    this.split = params.split ?? splitIntoSpeechChunks;
    this.prefetch = Math.max(0, params.prefetch ?? 1);
    this.done = this.run();
  }
  params;
  chunks = [];
  synthesis = [];
  now;
  split;
  prefetch;
  closed = false;
  playIndex = 0;
  wake;
  done;
  firstSynthesisAt;
  /** More reply text. Safe to call from a callback; never throws. */
  push(text) {
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
  finish() {
    this.closed = true;
    this.wake?.();
    return this.done;
  }
  /** Start synthesis for every chunk within the prefetch window. */
  schedule() {
    const limit = Math.min(this.chunks.length, this.playIndex + 1 + this.prefetch);
    for (let index = 0; index < limit; index += 1) {
      if (this.synthesis[index]) {
        continue;
      }
      const startedAt = this.now();
      this.firstSynthesisAt ??= startedAt;
      const pending = this.params.synthesizer.synthesize(this.chunks[index]).then((outcome) => ({ outcome, ttsMs: this.now() - startedAt }));
      pending.catch(() => void 0);
      this.synthesis[index] = pending;
    }
  }
  async run() {
    const result = {
      spokenChunks: 0,
      totalChunks: 0,
      firstChunkTtsMs: void 0,
      firstAudioAt: void 0,
      firstSynthesisAt: void 0,
      totalAudioMs: 0,
      speechProvider: void 0,
      error: void 0
    };
    for (; ; ) {
      while (this.playIndex >= this.chunks.length && !this.closed) {
        await new Promise((resolve) => {
          this.wake = resolve;
        });
        this.wake = void 0;
      }
      if (this.playIndex >= this.chunks.length) {
        break;
      }
      if (!this.params.isLive()) {
        break;
      }
      this.schedule();
      const index = this.playIndex;
      const current = this.synthesis[index];
      let chunk;
      try {
        chunk = await current;
      } catch (error) {
        chunk = {
          outcome: { status: "failed", error: error instanceof Error ? error.message : String(error) },
          ttsMs: 0
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
        if (result.spokenChunks === 0) {
          result.error = chunk.outcome.error;
        } else {
          this.params.log?.(
            `teamspeak voice: speech chunk failed chunk=${index + 1}: ${chunk.outcome.error}`
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
      result.firstAudioAt ??= this.now();
    }
    this.closed = true;
    result.totalChunks = this.chunks.length;
    result.firstSynthesisAt = this.firstSynthesisAt;
    return result;
  }
}
export {
  SpeechPipeline
};
