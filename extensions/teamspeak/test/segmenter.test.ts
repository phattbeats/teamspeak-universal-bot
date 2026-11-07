/**
 * Segmentation: where one heard utterance ends (PHA-3228).
 *
 * The hangover is the interesting part. TeamSpeak's `speaker_stop` fires at
 * every pause a talk burst contains, so without a join window a sentence with a
 * breath in it becomes two transcripts, two agent turns, and two answers
 * fighting for the room lane.
 */
import { describe, expect, it } from "vitest";
import { SpeakerSegmenter, type SpeakerSegment } from "../src/voice/segmenter.js";
import { toneFrame48k } from "./mock-bridge.js";

const FRAME_20MS = toneFrame48k();

type Clock = {
  now: () => number;
  advance: (ms: number) => void;
  setTimeoutFn: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  pendingCount: () => number;
};

/** A manual clock: real timers make hangover assertions flaky and slow. */
function createClock(): Clock {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.at <= current) {
          timers.delete(id);
          timer.handler();
        }
      }
    },
    setTimeoutFn: (handler, ms) => {
      const id = nextId++;
      timers.set(id, { at: current + ms, handler });
      return id;
    },
    clearTimeoutFn: (handle) => {
      timers.delete(handle as number);
    },
    pendingCount: () => timers.size,
  };
}

function createSegmenter(overrides: { hangoverMs?: number; minSegmentMs?: number; maxSegmentMs?: number } = {}) {
  const clock = createClock();
  const segments: SpeakerSegment[] = [];
  const dropped: number[] = [];
  const segmenter = new SpeakerSegmenter({
    onSegment: (segment) => segments.push(segment),
    onDropped: (durationMs) => dropped.push(durationMs),
    hangoverMs: overrides.hangoverMs ?? 600,
    minSegmentMs: overrides.minSegmentMs ?? 320,
    maxSegmentMs: overrides.maxSegmentMs ?? 20_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const speak = (frames: number) => {
    for (let index = 0; index < frames; index += 1) {
      segmenter.appendAudio(FRAME_20MS);
    }
  };
  return { clock, segmenter, segments, dropped, speak };
}

describe("SpeakerSegmenter", () => {
  it("closes a segment one hangover after speaker_stop", () => {
    const { clock, segmenter, segments, speak } = createSegmenter();
    segmenter.handleSpeakerStart();
    speak(50); // 1000 ms
    segmenter.handleSpeakerStop();

    clock.advance(599);
    expect(segments).toHaveLength(0);

    clock.advance(1);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.reason).toBe("speaker-stop");
    expect(segments[0]?.durationMs).toBeCloseTo(1_000, 5);
    expect(segments[0]?.pcm48kMono.length).toBe(FRAME_20MS.length * 50);
  });

  it("rejoins a mid-sentence pause instead of splitting the utterance", () => {
    const { clock, segmenter, segments, speak } = createSegmenter();
    segmenter.handleSpeakerStart();
    speak(25); // 500 ms
    segmenter.handleSpeakerStop();
    clock.advance(300); // inside the hangover
    segmenter.handleSpeakerStart();
    speak(25); // 500 ms more
    segmenter.handleSpeakerStop();
    clock.advance(600);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.durationMs).toBeCloseTo(1_000, 5);
  });

  it("treats audio arriving inside the hangover as a resume", () => {
    // Some bridges send the first frames before the start edge; letting the
    // hangover fire anyway would clip a syllable off the front of the next one.
    const { clock, segmenter, segments, speak } = createSegmenter();
    speak(25);
    segmenter.handleSpeakerStop();
    clock.advance(300);
    speak(25); // audio, with no start edge, inside the hangover
    clock.advance(600);
    expect(segments).toHaveLength(0); // the close was cancelled, not deferred

    segmenter.handleSpeakerStop();
    clock.advance(600);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.durationMs).toBeCloseTo(1_000, 5);
  });

  it("force-closes at the max duration so a monologue cannot stall the lane", () => {
    const { segmenter, segments, speak } = createSegmenter({ maxSegmentMs: 400 });
    segmenter.handleSpeakerStart();
    speak(20); // 400 ms

    expect(segments).toHaveLength(1);
    expect(segments[0]?.reason).toBe("max-duration");
    expect(segmenter.pendingMs).toBe(0);
  });

  it("drops a segment shorter than the floor, and says so", () => {
    const { clock, segmenter, segments, dropped, speak } = createSegmenter();
    segmenter.handleSpeakerStart();
    speak(5); // 100 ms — a click, not an utterance
    segmenter.handleSpeakerStop();
    clock.advance(600);

    expect(segments).toHaveLength(0);
    expect(dropped).toEqual([100]);
  });

  it("stamps the close time, which is where the latency budget starts", () => {
    const { clock, segmenter, segments, speak } = createSegmenter();
    segmenter.handleSpeakerStart();
    speak(50);
    clock.advance(1_000);
    segmenter.handleSpeakerStop();
    clock.advance(600);

    expect(segments[0]?.closedAt).toBe(1_600);
  });

  it("flushes what is buffered and cancels the hangover on close", () => {
    const { clock, segmenter, segments, speak } = createSegmenter();
    segmenter.handleSpeakerStart();
    speak(50);
    segmenter.flush();
    expect(segments).toHaveLength(1);
    expect(segments[0]?.reason).toBe("flush");

    segmenter.handleSpeakerStart();
    speak(50);
    segmenter.handleSpeakerStop();
    segmenter.close();
    clock.advance(10_000);
    expect(segments).toHaveLength(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it("ignores stop edges with nothing buffered", () => {
    const { clock, segmenter, segments } = createSegmenter();
    segmenter.handleSpeakerStop();
    clock.advance(5_000);
    expect(segments).toHaveLength(0);
  });
});
