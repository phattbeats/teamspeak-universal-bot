import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Announcer } from "../src/voice/announcer.js";

function setup(opts: { ready?: boolean; random?: () => number; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "announce-"));
  const requestFile = join(dir, ".announce");
  const linesFile = join(dir, "lines.json");
  writeFileSync(linesFile, JSON.stringify({ shift_end: ["a", "b", "c"], summon: ["only"], empty: [] }));
  const spoken: string[] = [];
  const slept: number[] = [];
  const state = { ready: opts.ready ?? true };
  const announcer = new Announcer({
    requestFile,
    linesFile,
    speak: async (text) => {
      spoken.push(text);
      return { durationMs: 2_000 };
    },
    isReady: () => state.ready,
    random: opts.random ?? (() => 0),
    now: () => opts.now ?? 1_000_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const request = (reason: string, at = 1_000_000) =>
    writeFileSync(requestFile, JSON.stringify({ reason, at }));
  return { announcer, requestFile, spoken, slept, state, request };
}

describe("Announcer (PHA-3824)", () => {
  it("speaks a line from the reason's pool, waits it out, then removes the request", async () => {
    const t = setup();
    t.request("shift_end");
    await t.announcer.tick();
    expect(t.spoken).toEqual(["a"]);
    expect(t.slept[0]).toBeGreaterThanOrEqual(2_000);
    expect(existsSync(t.requestFile)).toBe(false);
  });

  it("holds an entrance until the bot is in the channel", async () => {
    const t = setup({ ready: false });
    t.request("summon");
    await t.announcer.tick();
    expect(t.spoken).toEqual([]);
    expect(existsSync(t.requestFile)).toBe(true);
    t.state.ready = true;
    await t.announcer.tick();
    expect(t.spoken).toEqual(["only"]);
  });

  it("never repeats the previous line in a slot", async () => {
    const t = setup({ random: () => 0 });
    for (let i = 0; i < 4; i++) {
      t.request("shift_end");
      await t.announcer.tick();
    }
    for (let i = 1; i < t.spoken.length; i++) expect(t.spoken[i]).not.toBe(t.spoken[i - 1]);
  });

  it("consumes unknown reasons, empty pools and stale requests without speaking", async () => {
    const t = setup({ now: 10_000_000 });
    t.request("empty", 10_000_000);
    await t.announcer.tick();
    t.request("nope", 10_000_000);
    await t.announcer.tick();
    t.request("summon", 1_000);
    await t.announcer.tick();
    expect(t.spoken).toEqual([]);
    expect(existsSync(t.requestFile)).toBe(false);
  });
});
