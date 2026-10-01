import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Announcer, rollMood } from "../src/voice/announcer.js";

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

describe("daily mood (PHA-3840)", () => {
  function moodSetup(random: () => number, now = { t: 1_000_000 }) {
    const dir = mkdtempSync(join(tmpdir(), "mood-"));
    const requestFile = join(dir, ".announce");
    const linesFile = join(dir, "lines.json");
    const moodsFile = join(dir, "moods.json");
    const moodPromptFile = join(dir, "mood", "AGENTS.md");
    writeFileSync(linesFile, JSON.stringify({ shift_start: ["plain"], summon: ["summoned"], "mood:rough": ["ugh"] }));
    writeFileSync(
      moodsFile,
      JSON.stringify({ easy: { weight: 3 }, rough: { weight: 1, prompt: "Somebody keyed your car this morning." } }),
    );
    const spoken: string[] = [];
    const announcer = new Announcer({
      requestFile,
      linesFile,
      moodsFile,
      moodPromptFile,
      speak: async (text) => {
        spoken.push(text);
        return { durationMs: 1 };
      },
      isReady: () => true,
      random,
      now: () => now.t,
      sleep: async () => {},
    });
    const request = (reason: string, quiet = false) =>
      writeFileSync(requestFile, JSON.stringify({ reason, at: now.t, quiet }));
    return { announcer, spoken, request, moodPromptFile, requestFile, now };
  }

  it("rolls by weight", () => {
    const moods = { a: { weight: 3 }, b: { weight: 1 }, off: { weight: 0 } };
    expect(rollMood(moods, () => 0)).toBe("a");
    expect(rollMood(moods, () => 0.74)).toBe("a");
    expect(rollMood(moods, () => 0.76)).toBe("b");
    expect(rollMood(moods, () => 0.9999)).toBe("b");
    expect(rollMood({ off: { weight: 0 } }, () => 0.5)).toBeUndefined();
  });

  it("writes the mood prompt and uses the mood pool on shift_start", async () => {
    const t = moodSetup(() => 0.9);
    t.request("shift_start");
    await t.announcer.tick();
    expect(t.spoken).toEqual(["ugh"]);
    expect(readFileSync(t.moodPromptFile, "utf8")).toContain("Somebody keyed your car");
  });

  it("falls back to shift_start when the mood has no pool", async () => {
    const t = moodSetup(() => 0);
    t.request("shift_start");
    await t.announcer.tick();
    expect(t.spoken).toEqual(["plain"]);
    expect(readFileSync(t.moodPromptFile, "utf8")).toContain("regular shift");
  });

  it("keeps the shift's mood through a summon, rerolls once stale", async () => {
    let r = 0.9;
    const t = moodSetup(() => r);
    t.request("shift_start");
    await t.announcer.tick();
    r = 0;
    t.request("summon");
    await t.announcer.tick();
    expect(readFileSync(t.moodPromptFile, "utf8")).toContain("keyed");
    t.now.t += 15 * 60 * 60_000;
    t.request("summon");
    await t.announcer.tick();
    expect(readFileSync(t.moodPromptFile, "utf8")).not.toContain("keyed");
  });

  it("a quiet entrance rolls the mood but says nothing", async () => {
    const t = moodSetup(() => 0.9);
    t.request("shift_start", true);
    await t.announcer.tick();
    expect(t.spoken).toEqual([]);
    expect(existsSync(t.requestFile)).toBe(false);
    expect(readFileSync(t.moodPromptFile, "utf8")).toContain("keyed");
  });
});
