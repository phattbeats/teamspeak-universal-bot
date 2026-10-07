/**
 * Per-speaker utterance segmentation for the stt-tts lane (#3228).
 *
 * The realtime lane needs none of this: the provider does its own endpointing
 * on a continuous stream. A batch transcriber needs a finished utterance, so
 * something has to decide where one ends.
 *
 * That decision is not a VAD here, because TeamSpeak already made it. The
 * server sends `speaker_start` / `speaker_stop` around every talk burst
 * (ts-bridge/PROTOCOL.md), which is the client's own voice activation — the
 * same signal the realtime lane uses for barge-in. So this class accumulates
 * audio between those edges and adds one thing the raw edges lack: a hangover
 * window, so that the pause between two words in a sentence does not become two
 * transcripts, two agent turns, and two answers talking over each other.
 *
 * One segmenter per `clientId`. Audio arrives already filtered to this speaker
 * by SpeakerSessionManager, so nothing here inspects who is talking.
 */
import { bridgePcmDurationMs } from "./audio.js";

export type SpeakerSegmentReason = "speaker-stop" | "max-duration" | "flush";

export type SpeakerSegment = {
  pcm48kMono: Buffer;
  durationMs: number;
  reason: SpeakerSegmentReason;
  /** Wall-clock at which the speaker started this burst. Measures dead air. */
  startedAt: number;
  /** Wall-clock at which the segment closed; the head of the latency budget. */
  closedAt: number;
};

export type SpeakerSegmenterParams = {
  onSegment: (segment: SpeakerSegment) => void;
  /** Silence after `speaker_stop` before the segment closes. */
  hangoverMs: number;
  /** Segments shorter than this are dropped: a click is not an utterance. */
  minSegmentMs: number;
  /** Hard cap, so one uninterrupted monologue cannot stall the lane forever. */
  maxSegmentMs: number;
  /** Dropped segments are still worth a line; a silent drop reads as a bug. */
  onDropped?: ((durationMs: number) => void) | undefined;
  now?: (() => number) | undefined;
  setTimeoutFn?: ((handler: () => void, ms: number) => unknown) | undefined;
  clearTimeoutFn?: ((handle: unknown) => void) | undefined;
};

export class SpeakerSegmenter {
  private chunks: Buffer[] = [];
  private bufferedMs = 0;
  private startedAt = 0;
  private hangover: unknown;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly params: SpeakerSegmenterParams) {
    this.now = params.now ?? (() => Date.now());
    this.setTimeoutFn = params.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = params.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
  }

  /** Audio buffered but not yet handed to a transcriber, in milliseconds. */
  get pendingMs(): number {
    return this.bufferedMs;
  }

  get isOpen(): boolean {
    return this.chunks.length > 0;
  }

  /**
   * The speaker started (or resumed) talking. Resuming inside the hangover
   * window cancels the close, which is the whole reason the window exists.
   */
  handleSpeakerStart(): void {
    if (this.closed) {
      return;
    }
    this.cancelHangover();
  }

  appendAudio(pcm48kMono: Buffer): void {
    if (this.closed || pcm48kMono.length === 0) {
      return;
    }
    // Audio arriving is itself evidence the speaker is live: some bridges send
    // frames before the start edge, and treating that as silence would clip the
    // first syllable of every utterance.
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
  handleSpeakerStop(): void {
    if (this.closed || this.chunks.length === 0 || this.hangover !== undefined) {
      return;
    }
    if (this.params.hangoverMs <= 0) {
      this.emit("speaker-stop");
      return;
    }
    this.hangover = this.setTimeoutFn(() => {
      this.hangover = undefined;
      this.emit("speaker-stop");
    }, this.params.hangoverMs);
  }

  /** Close whatever is buffered now, e.g. because the session is ending. */
  flush(): void {
    if (this.closed) {
      return;
    }
    this.cancelHangover();
    this.emit("flush");
  }

  close(): void {
    this.closed = true;
    this.cancelHangover();
    this.chunks = [];
    this.bufferedMs = 0;
  }

  private cancelHangover(): void {
    if (this.hangover === undefined) {
      return;
    }
    this.clearTimeoutFn(this.hangover);
    this.hangover = undefined;
  }

  private emit(reason: SpeakerSegmentReason): void {
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
      closedAt: this.now(),
    });
  }
}
