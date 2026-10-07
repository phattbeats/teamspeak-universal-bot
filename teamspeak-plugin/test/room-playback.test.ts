/**
 * Acceptance: "barge-in clears the queue" (#3175).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomPlaybackQueue, type RoomPlaybackSink } from "../src/voice/room-playback.js";
import { toneFrame48k } from "./mock-bridge.js";

/** 960 samples @48k = exactly 20 ms. */
const FRAME_20MS = toneFrame48k();

function createSink(): RoomPlaybackSink & { written: Buffer[]; cleared: number } {
  const written: Buffer[] = [];
  return {
    written,
    cleared: 0,
    writeVoiceAudio(pcm) {
      written.push(pcm);
    },
    clearVoice() {
      this.cleared += 1;
    },
  };
}

describe("RoomPlaybackQueue", () => {
  let sink: ReturnType<typeof createSink>;

  beforeEach(() => {
    sink = createSink();
  });

  it("writes the owning speaker's audio straight through to the bridge", () => {
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0 });
    queue.enqueue("client:1", FRAME_20MS);
    queue.enqueue("client:1", FRAME_20MS);

    expect(sink.written).toHaveLength(2);
    expect(queue.activeOwner).toBe("client:1");
    expect(queue.activeWrittenMs).toBe(40);
  });

  it("holds a second speaker behind the owner until the lane is released", () => {
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0 });
    queue.enqueue("client:1", FRAME_20MS);
    queue.enqueue("client:2", FRAME_20MS);

    // The bridge mixes one Opus stream; two concurrent writers would overlap.
    expect(sink.written).toHaveLength(1);
    expect(queue.pendingChunkCount).toBe(1);

    queue.release("client:1");
    expect(sink.written).toHaveLength(2);
    expect(queue.activeOwner).toBe("client:2");
  });

  it("clears queued audio and tells the bridge to drop its buffer on barge-in", () => {
    const onOwnerInterrupted = vi.fn();
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0, onOwnerInterrupted });

    queue.enqueue("client:1", FRAME_20MS);
    queue.enqueue("client:2", FRAME_20MS);
    expect(queue.pendingChunkCount).toBe(1);

    expect(queue.handleBargeIn("speaker-start")).toBe(true);

    expect(queue.pendingChunkCount).toBe(0);
    expect(queue.activeOwner).toBeUndefined();
    expect(queue.isActive()).toBe(false);
    expect(sink.cleared).toBe(1);
    // Both the interrupted owner and the queued one must learn their audio died.
    expect(onOwnerInterrupted.mock.calls.map(([owner]) => owner).sort()).toEqual([
      "client:1",
      "client:2",
    ]);
  });

  it("ignores a barge-in inside the echo guard window", () => {
    const onOwnerInterrupted = vi.fn();
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 250, onOwnerInterrupted });

    // 100 ms of assistant audio: our own voice is still coming back through the
    // channel, so a speaker_start here is echo, not an interruption.
    for (let index = 0; index < 5; index += 1) {
      queue.enqueue("client:1", FRAME_20MS);
    }
    expect(queue.activeWrittenMs).toBe(100);

    expect(queue.handleBargeIn("speaker-start")).toBe(false);
    expect(queue.isActive()).toBe(true);
    expect(sink.cleared).toBe(0);
    expect(onOwnerInterrupted).not.toHaveBeenCalled();

    // Past the guard, the same event interrupts.
    for (let index = 0; index < 8; index += 1) {
      queue.enqueue("client:1", FRAME_20MS);
    }
    expect(queue.activeWrittenMs).toBe(260);
    expect(queue.handleBargeIn("speaker-start")).toBe(true);
    expect(sink.cleared).toBe(1);
  });

  it("forces through the echo guard when the caller demands it", () => {
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 250 });
    queue.enqueue("client:1", FRAME_20MS);

    expect(queue.handleBargeIn("provider-clear-audio", { force: true })).toBe(true);
    expect(sink.cleared).toBe(1);
    expect(queue.isActive()).toBe(false);
  });

  it("reports no interruption when nothing is playing", () => {
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0 });
    expect(queue.handleBargeIn("speaker-start")).toBe(false);
    expect(sink.cleared).toBe(0);
  });

  it("stops accepting audio once closed", () => {
    const queue = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0 });
    queue.close();
    queue.enqueue("client:1", FRAME_20MS);
    expect(sink.written).toHaveLength(0);
  });
});
