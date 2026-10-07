/**
 * The per-bot in-flight cap on whisper requests (#3607).
 *
 * whisper.cpp's server has one decode slot; letting every concurrent speaker
 * submit independently just stacks each one behind a full timeout instead of
 * running in parallel. This is what used to livelock sexton/bexton under a
 * multi-speaker room (#3597): the fix caps in-flight requests and evicts
 * whichever segment was already waiting rather than letting a backlog grow.
 */
import { describe, expect, it } from "vitest";
import { ConcurrencyLimitedTranscriber } from "../src/voice/stt-tts-speaker-session.js";
import type { SttProvider, SttRequest, SttResult } from "../src/voice/stt-provider.js";

function request(label: string): SttRequest {
  return { pcm48kMono: Buffer.alloc(0), label };
}

/** An inner transcriber whose calls only resolve when the test says so. */
function deferredTranscriber(): {
  transcriber: SttProvider;
  calls: string[];
  resolve: (label: string, text: string) => void;
} {
  const calls: string[] = [];
  const pending = new Map<string, (result: SttResult) => void>();
  const transcriber: SttProvider = {
    id: "fake-whisper",
    kind: "local",
    transcribe: (req) =>
      new Promise<SttResult>((resolve) => {
        calls.push(req.label);
        pending.set(req.label, resolve);
      }),
  };
  return {
    transcriber,
    calls,
    resolve: (label, text) => {
      pending.get(label)?.({ text, provider: "fake-whisper", ms: 7 });
      pending.delete(label);
    },
  };
}

describe("ConcurrencyLimitedTranscriber", () => {
  it("runs only one request at a time against the inner transcriber", async () => {
    const inner = deferredTranscriber();
    const limiter = new ConcurrencyLimitedTranscriber(inner.transcriber, 1, 1);

    const first = limiter.transcribe(request("brandon"));
    await Promise.resolve();
    expect(inner.calls).toEqual(["brandon"]);

    inner.resolve("brandon", "hello");
    // The inner result passes straight through, `ms` included: the limiter
    // reports provider time, not provider time plus the wait it imposed.
    expect(await first).toEqual({ text: "hello", provider: "fake-whisper", ms: 7 });
  });

  it("evicts the oldest queued segment instead of letting a third submission stack up", async () => {
    const inner = deferredTranscriber();
    const log: string[] = [];
    const limiter = new ConcurrencyLimitedTranscriber(inner.transcriber, 1, 1, (m) => log.push(m));

    const first = limiter.transcribe(request("brandon")); // in flight
    await Promise.resolve();
    const second = limiter.transcribe(request("guest")); // queued
    await Promise.resolve();
    const third = limiter.transcribe(request("late")); // evicts "second"

    // "second" never reaches the inner transcriber at all.
    const evicted = await second;
    expect(evicted).toEqual({ text: "", provider: "fake-whisper", ms: 0 });
    expect(inner.calls).toEqual(["brandon"]);
    expect(log.some((line) => line.includes("dropping oldest queued segment"))).toBe(true);

    // Once "brandon" finishes, "late" — not the evicted "guest" — gets the slot.
    inner.resolve("brandon", "hi");
    await first;
    await Promise.resolve();
    expect(inner.calls).toEqual(["brandon", "late"]);
    inner.resolve("late", "hey");
    expect(await third).toEqual({ text: "hey", provider: "fake-whisper", ms: 7 });
  });

  it("lets queued segments proceed in order when nothing evicts them", async () => {
    const inner = deferredTranscriber();
    const limiter = new ConcurrencyLimitedTranscriber(inner.transcriber, 1, 1);

    const first = limiter.transcribe(request("a"));
    await Promise.resolve();
    const second = limiter.transcribe(request("b"));

    inner.resolve("a", "one");
    expect((await first).text).toBe("one");
    await Promise.resolve();
    expect(inner.calls).toEqual(["a", "b"]);
    inner.resolve("b", "two");
    expect((await second).text).toBe("two");
  });
});
