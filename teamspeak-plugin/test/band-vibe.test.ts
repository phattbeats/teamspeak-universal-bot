/**
 * The band's sound and its introductions (PHA-3554).
 *
 * The rng is a scripted sequence, so what is asserted is the shape of the
 * variation — genre stays first, the vocal prefix goes on only when there is
 * a singer, the extra keywords are rationed, the mood is read from the brief —
 * rather than any one draw.
 */
import { describe, expect, it } from "vitest";
import {
  BAND_KEYWORDS,
  BAND_STYLE_GENRE,
  BAND_VOCAL_PREFIX,
  buildBandAnnouncement,
  buildBandFailureLine,
  buildBandVibe,
  DEFAULT_BAND_NAME,
  readSinger,
  titleFromBrief,
  TRIXIE_VOCAL_PREFIX,
} from "../src/tools/band-vibe.js";

/** A deterministic rng: mulberry32 from a seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildBandVibe", () => {
  it("leads the style with the genre and the core instruments, every time", () => {
    for (let seed = 1; seed < 40; seed += 1) {
      const vibe = buildBandVibe({ brief: "something for a Tuesday", vocals: false }, seeded(seed));
      expect(vibe.style.startsWith(BAND_STYLE_GENRE)).toBe(true);
      for (const core of ["upright bass", "brushed drums", "muted trumpet", "baritone sax"]) {
        expect(vibe.style.toLowerCase()).toContain(core);
      }
      expect(vibe.style.length).toBeLessThanOrEqual(600);
    }
  });

  it("puts the band-leader vocal in front of the tags only when there is a singer", () => {
    const sung = buildBandVibe({ brief: "a song about Kai", vocals: true }, seeded(3));
    const played = buildBandVibe({ brief: "a song about Kai", vocals: false }, seeded(3));
    expect(sung.styleTags.startsWith(BAND_VOCAL_PREFIX)).toBe(true);
    expect(played.styleTags.startsWith("instrumental")).toBe(true);
    expect(played.styleTags).not.toContain(BAND_VOCAL_PREFIX);
    // The vocal never leaks into the MiniMax-shaped style field either.
    expect(sung.style).not.toContain("crooner");
  });

  it("hands the mic to Trixie when asked, and bills her on the marquee", () => {
    const trixie = buildBandVibe({ brief: "a torch song", vocals: true, singer: "trixie" }, seeded(3));
    expect(trixie.singer).toBe("trixie");
    expect(trixie.styleTags.startsWith(TRIXIE_VOCAL_PREFIX)).toBe(true);
    expect(trixie.styleTags).not.toContain(BAND_VOCAL_PREFIX);
    expect(trixie.styleTags).toContain("female");

    const bexton = buildBandVibe({ brief: "a torch song", vocals: true }, seeded(3));
    expect(bexton.singer).toBe("bexton");
    const none = buildBandVibe({ brief: "a torch song", vocals: false, singer: "trixie" }, seeded(3));
    expect(none.singer).toBeUndefined();
    expect(none.styleTags).not.toContain("Trixie");

    for (let seed = 0; seed < 40; seed += 1) {
      const line = buildBandAnnouncement(
        { title: "Half for Later", requestedBy: "Kai", dedicatedTo: "Kyle", singer: "trixie" },
        seeded(seed),
      );
      expect(line).toContain("Trixie");
    }
    expect(buildBandAnnouncement({ title: "x", singer: "bexton" }, seeded(1))).not.toContain("Trixie");
  });

  it("reads a singer from the room's words", () => {
    expect(readSinger(undefined)).toBe("bexton");
    expect(readSinger("Trixie")).toBe("trixie");
    expect(readSinger("female lead")).toBe("trixie");
    expect(readSinger("bexton")).toBe("bexton");
    expect(readSinger("the band leader")).toBe("bexton");
  });

  it("rations the extra keywords: never more than two, and often none", () => {
    let none = 0;
    let max = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const vibe = buildBandVibe({ brief: "anything", vocals: false }, seeded(seed));
      expect(vibe.keywords.length).toBeLessThanOrEqual(2);
      for (const keyword of vibe.keywords) {
        expect(BAND_KEYWORDS).toContain(keyword);
        expect(vibe.style.toLowerCase()).toContain(keyword.toLowerCase());
      }
      if (vibe.keywords.length === 0) {
        none += 1;
      }
      max = Math.max(max, vibe.keywords.length);
    }
    expect(none).toBeGreaterThan(50);
    expect(max).toBe(2);
  });

  it("varies: two seeds do not produce the same style", () => {
    const styles = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      styles.add(buildBandVibe({ brief: "anything", vocals: false }, seeded(seed)).style);
    }
    expect(styles.size).toBeGreaterThan(10);
  });

  it("reads the mood from the brief and lets an explicit mood override it", () => {
    const sad = buildBandVibe({ brief: "Kai's dog died, something sad", vocals: true }, seeded(1));
    expect(sad.mood).toBe("mournful");
    expect(sad.style).toContain("mournful");
    expect(sad.styleTags).toContain("torch song");

    const party = buildBandVibe({ brief: "it's Brandon's birthday", vocals: true }, seeded(1));
    expect(party.mood).toBe("celebration");

    const forced = buildBandVibe(
      { brief: "it's Brandon's birthday", mood: "menace", vocals: true },
      seeded(1),
    );
    expect(forced.mood).toBe("menace");
    expect(forced.style).toContain("Menacing");

    const plain = buildBandVibe({ brief: "just play something", vocals: false }, seeded(1));
    expect(plain.mood).toBe("house");
  });
});

describe("buildBandAnnouncement", () => {
  it("names the band, and mostly opens with ladies and gentlemen", () => {
    let canonical = 0;
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) {
      const line = buildBandAnnouncement({ title: "Tuesday Again" }, seeded(seed));
      seen.add(line);
      expect(
        line.includes(DEFAULT_BAND_NAME) ||
          line.includes("Sgt. Bexton and the Digital Heart Club Band") ||
          line.includes('"Tuesday Again"'),
      ).toBe(true);
      if (line.startsWith("Ladies and gentlemen")) {
        canonical += 1;
      }
      // Templates that need a requester or a dedicatee never fire without one.
      expect(line).not.toMatch(/\{|\}/u);
      expect(line).not.toContain("  ");
    }
    expect(canonical).toBeGreaterThan(40);
    expect(seen.size).toBeGreaterThan(4);
  });

  it("bills the band under an alias some of the time, and never under a blank one", () => {
    const seen = new Set<string>();
    let alias = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const line = buildBandAnnouncement({ title: "Tuesday Again" }, seeded(seed));
      seen.add(line);
      if (line.includes("Sgt. Bexton and the Digital Heart Club Band")) {
        alias += 1;
      }
    }
    // Weight 4:1, so roughly a fifth of the introductions that name the band.
    expect(alias).toBeGreaterThan(15);
    expect(alias).toBeLessThan(80);
    for (let seed = 1; seed <= 50; seed += 1) {
      const line = buildBandAnnouncement(
        { title: "x", bandName: "The Band", bandAliases: ["", "  ", "The Band"] },
        seeded(seed),
      );
      expect(line.includes("The Band") || line.includes('"x"')).toBe(true);
    }
  });

  it("uses the requester and the dedicatee when they are given", () => {
    const lines = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      lines.add(
        buildBandAnnouncement(
          { title: "Kai's Lament", requestedBy: "Brandon", dedicatedTo: "Kai", bandName: "The Band" },
          seeded(seed),
        ),
      );
    }
    const joined = [...lines].join("\n");
    expect(joined).toContain("Brandon asked for this");
    expect(joined).toContain("For Kai, who did not ask for this. The Band.");
  });
});

describe("the small ones", () => {
  it("has more than one way to say the band failed", () => {
    const lines = new Set<string>();
    for (let seed = 1; seed <= 50; seed += 1) {
      lines.add(buildBandFailureLine(seeded(seed)));
    }
    expect(lines.size).toBeGreaterThan(2);
  });

  it("titles a song from its brief when the agent forgot to", () => {
    expect(titleFromBrief("a sad song about kai's broken truck, please")).toBe(
      "A Sad Song About Kai's",
    );
    expect(titleFromBrief("   ")).toBe("Untitled Number");
  });
});
