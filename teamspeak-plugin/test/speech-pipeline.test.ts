/**
 * The streaming speech pipeline (PHA-3792): text pushed over time, spoken in
 * order, first audio before the last text has arrived.
 */
import { describe, expect, it } from "vitest";
import { BRIDGE_FRAME_BYTES } from "../src/voice/audio.js";
import { RoomPlaybackQueue } from "../src/voice/room-playback.js";
import { SpeechPipeline } from "../src/voice/speech-pipeline.js";
import type { SpeechSynthesisOutcome, SpeechSynthesizer } from "../src/voice/speech.js";

const ONE_FRAME = Buffer.alloc(BRIDGE_FRAME_BYTES, 1);

class GatedSynthesizer implements SpeechSynthesizer {
  readonly id = "fake";
  readonly started: string[] = [];
  private readonly gates = new Map<string, () => void>();
  outcomeFor: (text: string) => SpeechSynthesisOutcome = () => ({
    status: "ok",
    pcm48kMono: ONE_FRAME,
    provider: "fake",
    speakText: "",
  });

  synthesize(text: string): Promise<SpeechSynthesisOutcome> {
    this.started.push(text);
    return new Promise((resolve) => {
      this.gates.set(text, () => resolve(this.outcomeFor(text)));
    });
  }

  release(text: string): void {
    const gate = this.gates.get(text);
    if (!gate) {
      throw new Error(`no synthesis in flight for ${JSON.stringify(text)}`);
    }
    this.gates.delete(text);
    gate();
  }
}

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createQueue(): { queue: RoomPlaybackQueue; sent: Buffer[] } {
  const sent: Buffer[] = [];
  const queue = new RoomPlaybackQueue({
    sink: {
      writeVoiceAudio: (frame) => {
        sent.push(frame);
      },
      clearVoice: () => undefined,
    },
    minBargeInAudioEndMs: 0,
  });
  return { queue, sent };
}

describe("SpeechPipeline", () => {
  it("speaks the first block before the second has arrived", async () => {
    const synthesizer = new GatedSynthesizer();
    const { queue, sent } = createQueue();
    let now = 1_000;
    const pipeline = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:7",
      isLive: () => true,
      now: () => now,
    });

    pipeline.push("First sentence of the answer.");
    await tick();
    expect(synthesizer.started).toEqual(["First sentence of the answer."]);

    now = 1_500;
    synthesizer.release("First sentence of the answer.");
    await tick();
    // Audio is on the wire while the model is still writing block two.
    expect(sent).toHaveLength(1);

    pipeline.push("Second sentence, which took the model a while.");
    await tick();
    synthesizer.release("Second sentence, which took the model a while.");
    const result = await pipeline.finish();

    expect(sent).toHaveLength(2);
    expect(result.spokenChunks).toBe(2);
    expect(result.totalChunks).toBe(2);
    expect(result.firstChunkTtsMs).toBe(500);
    expect(result.firstAudioAt).toBe(1_500);
    expect(result.firstSynthesisAt).toBe(1_000);
    expect(result.speechProvider).toBe("fake");
  });

  it("keeps one synthesis prefetched ahead of playback, in push order", async () => {
    const synthesizer = new GatedSynthesizer();
    const { queue, sent } = createQueue();
    const pipeline = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:7",
      isLive: () => true,
    });

    pipeline.push("Sentence number one is here and it is long enough. Sentence number two follows it and is long enough. Sentence number three ends it and is long enough.");
    await tick();
    // Two in flight (current + one prefetch), not three.
    expect(synthesizer.started).toEqual([
      "Sentence number one is here and it is long enough.",
      "Sentence number two follows it and is long enough.",
    ]);

    synthesizer.release("Sentence number one is here and it is long enough.");
    await tick();
    expect(synthesizer.started).toHaveLength(3);
    expect(sent).toHaveLength(1);

    synthesizer.release("Sentence number three ends it and is long enough.");
    await tick();
    // Three finished before two; nothing plays until two has.
    expect(sent).toHaveLength(1);
    synthesizer.release("Sentence number two follows it and is long enough.");
    await tick();
    const result = await pipeline.finish();
    expect(sent).toHaveLength(3);
    expect(result.spokenChunks).toBe(3);
  });

  it("goes quiet when the turn is retired mid-synthesis", async () => {
    const synthesizer = new GatedSynthesizer();
    const { queue, sent } = createQueue();
    let live = true;
    const pipeline = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:7",
      isLive: () => live,
    });
    pipeline.push("The answer starts here.");
    await tick();
    live = false;
    synthesizer.release("The answer starts here.");
    const result = await pipeline.finish();
    expect(sent).toHaveLength(0);
    expect(result.spokenChunks).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("fails the turn only when the first chunk fails", async () => {
    const synthesizer = new GatedSynthesizer();
    synthesizer.outcomeFor = (text) =>
      text.startsWith("Bad")
        ? { status: "failed", error: "boom" }
        : { status: "ok", pcm48kMono: ONE_FRAME, provider: "fake", speakText: "" };
    const { queue, sent } = createQueue();
    const logs: string[] = [];

    const failing = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:7",
      isLive: () => true,
      log: (line) => logs.push(line),
    });
    failing.push("Bad from the start.");
    await tick();
    synthesizer.release("Bad from the start.");
    expect((await failing.finish()).error).toBe("boom");
    expect(sent).toHaveLength(0);

    const partial = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:8",
      isLive: () => true,
      log: (line) => logs.push(line),
    });
    partial.push("Good opening sentence here, long enough to stand alone. Bad second sentence right after it, also long enough.");
    await tick();
    synthesizer.release("Good opening sentence here, long enough to stand alone.");
    await tick();
    synthesizer.release("Bad second sentence right after it, also long enough.");
    const result = await partial.finish();
    expect(result.error).toBeUndefined();
    expect(result.spokenChunks).toBe(1);
    expect(logs.some((line) => line.includes("speech chunk failed chunk=2"))).toBe(true);
  });

  it("finishes cleanly with nothing to say", async () => {
    const synthesizer = new GatedSynthesizer();
    const { queue } = createQueue();
    const pipeline = new SpeechPipeline({
      synthesizer,
      playback: queue,
      ownerKey: "client:7",
      isLive: () => true,
    });
    pipeline.push("   ");
    const result = await pipeline.finish();
    expect(result.totalChunks).toBe(0);
    expect(synthesizer.started).toEqual([]);
  });
});
