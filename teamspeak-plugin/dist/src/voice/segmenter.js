import { bridgePcmDurationMs } from "./audio.js";
class SpeakerSegmenter {
  constructor(params) {
    this.params = params;
    this.now = params.now ?? (() => Date.now());
    this.setTimeoutFn = params.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = params.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }
  params;
  chunks = [];
  bufferedMs = 0;
  startedAt = 0;
  hangover;
  closed = false;
  now;
  setTimeoutFn;
  clearTimeoutFn;
  /** Audio buffered but not yet handed to a transcriber, in milliseconds. */
  get pendingMs() {
    return this.bufferedMs;
  }
  get isOpen() {
    return this.chunks.length > 0;
  }
  /**
   * The speaker started (or resumed) talking. Resuming inside the hangover
   * window cancels the close, which is the whole reason the window exists.
   */
  handleSpeakerStart() {
    if (this.closed) {
      return;
    }
    this.cancelHangover();
  }
  appendAudio(pcm48kMono) {
    if (this.closed || pcm48kMono.length === 0) {
      return;
    }
    this.cancelHangover();
    if (this.chunks.length === 0) {
      this.startedAt = this.now();
    }
    this.chunks.push(pcm48kMono);
    this.bufferedMs += bridgePcmDurationMs(pcm48kMono);
    if (this.bufferedMs >= this.params.maxSegmentMs) {
      this.emit("max-duration");
    }
  }
  /** The speaker stopped. Arm the hangover; a resume before it fires rejoins. */
  handleSpeakerStop() {
    if (this.closed || this.chunks.length === 0 || this.hangover !== void 0) {
      return;
    }
    if (this.params.hangoverMs <= 0) {
      this.emit("speaker-stop");
      return;
    }
    this.hangover = this.setTimeoutFn(() => {
      this.hangover = void 0;
      this.emit("speaker-stop");
    }, this.params.hangoverMs);
  }
  /** Close whatever is buffered now, e.g. because the session is ending. */
  flush() {
    if (this.closed) {
      return;
    }
    this.cancelHangover();
    this.emit("flush");
  }
  close() {
    this.closed = true;
    this.cancelHangover();
    this.chunks = [];
    this.bufferedMs = 0;
  }
  cancelHangover() {
    if (this.hangover === void 0) {
      return;
    }
    this.clearTimeoutFn(this.hangover);
    this.hangover = void 0;
  }
  emit(reason) {
    const chunks = this.chunks;
    const durationMs = this.bufferedMs;
    const startedAt = this.startedAt;
    this.chunks = [];
    this.bufferedMs = 0;
    if (chunks.length === 0) {
      return;
    }
    if (durationMs < this.params.minSegmentMs) {
      this.params.onDropped?.(durationMs);
      return;
    }
    this.params.onSegment({
      pcm48kMono: Buffer.concat(chunks),
      durationMs,
      reason,
      startedAt,
      closedAt: this.now()
    });
  }
}
export {
  SpeakerSegmenter
};
