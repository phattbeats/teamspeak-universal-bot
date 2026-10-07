/**
 * Fuzzy wake matcher (#3428) and the #3605 guard rails.
 *
 * The fixture is the accept/decline diff from replaying 24h of live sexton +
 * bexton `heard=` / `wakeHeardAs=` log lines (2026-09-18 to 2026-09-19)
 * through the old and new matcher: every line whose outcome changed, with
 * the outcome the new matcher must keep producing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateFuzzyWakeName, matchFuzzyWakeName } from "../src/voice/fuzzy-wake.js";

const SEXTON = {
  names: ["Sexton", "sexton", "Henchman", "henchman"],
  aliases: ["section", "sections", "sex and", "sexin", "saxton", "sex ton", "sex done"],
  exclude: ["Bexton", "band leader", "maestro"],
};
const BEXTON = {
  names: ["Bexton", "bexton", "band leader", "maestro"],
  aliases: [] as string[],
  exclude: ["Sexton", "Henchman"],
};

function bot(config: typeof SEXTON) {
  return (transcript: string) =>
    evaluateFuzzyWakeName(transcript, config.names, {
      aliases: config.aliases,
      excludeNames: config.exclude,
    });
}

describe("matchFuzzyWakeName", () => {
  it("still tolerates whisper's spelling of a single word", () => {
    expect(matchFuzzyWakeName("hey saxton what time is it", ["Sexton"])).toEqual({
      text: "hey what time is it",
      activationName: "Sexton",
      heardAs: "saxton",
    });
    expect(matchFuzzyWakeName("Sexton?", ["Sexton"])?.text).toBe("");
  });

  it("still joins a split name when nothing was dropped", () => {
    expect(matchFuzzyWakeName("sex ton are you there", ["Sexton"])?.heardAs).toBe("sex ton");
  });

  it("requires the first letter to agree", () => {
    for (const junk of ["next one", "stat on", "sets on"]) {
      expect(matchFuzzyWakeName(junk, ["Sexton"]), junk).toBeUndefined();
    }
  });

  it("gives a joined word pair one edit and no deletions", () => {
    expect(matchFuzzyWakeName("be on", ["Bexton"])).toBeUndefined();
    expect(matchFuzzyWakeName("sex to", ["Sexton"])).toBeUndefined();
    expect(matchFuzzyWakeName("sex done", ["Sexton"])).toBeUndefined();
    expect(matchFuzzyWakeName("sex tone", ["Sexton"])?.heardAs).toBe("sex tone");
  });

  it("accepts an alias exactly, with no budget of its own", () => {
    const sexton = bot(SEXTON);
    expect(sexton("sections please stop responding").match).toEqual({
      text: "please stop responding",
      activationName: "Sexton",
      heardAs: "sections",
    });
    expect(sexton("Sex and infection are at it again, dude.").match?.heardAs).toBe("sex and");
    expect(sexton("sexin").match?.activationName).toBe("Sexton");
    // "sex to" is two edits from the alias "sexin"; aliases do not fuzz.
    expect(sexton("sex to").match).toBeUndefined();
  });

  it("declines the other bot's name and says so", () => {
    expect(bot(SEXTON)("bexton play something")).toEqual({ excludedBy: "Bexton" });
    expect(bot(SEXTON)("s bexton")).toEqual({ excludedBy: "Bexton" });
    expect(bot(BEXTON)("sexton what do you think")).toEqual({ excludedBy: "Sexton" });
    expect(bot(BEXTON)("hey maestro").match?.activationName).toBe("maestro");
  });

  it("still answers its own name when both names are in the sentence", () => {
    const result = bot(SEXTON)("bexton and sexton, both of you");
    expect(result.match?.heardAs).toBe("sexton");
    expect(result.excludedBy).toBeUndefined();
  });

  it("gives a tie to the other bot", () => {
    // "sexton" vs "bexton": one edit either way. Ours only if it is closer.
    expect(evaluateFuzzyWakeName("sexton", ["Sexton"], { excludeNames: ["Sexton"] })).toEqual({
      excludedBy: "Sexton",
    });
    expect(evaluateFuzzyWakeName("sexton", ["Sexton"], { excludeNames: ["Bexton"] }).match).toBeDefined();
  });
});

describe("24h live replay (#3605 fixture)", () => {
  type Row = { bot: "sexton" | "bexton"; at: string; heard: string; before: string; after: string };
  const rows = JSON.parse(
    readFileSync(new URL("./fixtures/wake-heard-pha3605.json", import.meta.url), "utf8"),
  ) as Row[];

  it("has every line the change flipped", () => {
    expect(rows.length).toBe(17);
  });

  for (const row of rows) {
    it(`${row.bot} ${row.at} ${JSON.stringify(row.heard)}: ${row.before} -> ${row.after}`, () => {
      const result = bot(row.bot === "sexton" ? SEXTON : BEXTON)(row.heard);
      const outcome = result.match
        ? `accept(${result.match.heardAs})`
        : result.excludedBy
          ? `decline excludedBy=${result.excludedBy}`
          : "decline";
      expect(outcome).toBe(row.after);
    });
  }
});
