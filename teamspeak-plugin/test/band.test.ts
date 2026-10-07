/**
 * The band leader's job (#3554), with the generator, the music lane and the
 * mouth all faked. What is asserted is the sequence the room hears: the tool
 * returns at once; the song is generated off the turn; the announcement is
 * spoken; the downbeat is delayed by exactly the announcement plus the gap;
 * and a failure is spoken in character rather than swallowed.
 */
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedTeamSpeakBandConfig } from "../src/config.js";
import type { GeneratedSong, SongGenerator, SongSpec } from "../src/tools/band-generators.js";
import { BandLeader, type BandStatus } from "../src/tools/band.js";
import type { MusicController, MusicPlayRequest, MusicTrack } from "../src/tools/music.js";

class FakeGenerator implements SongGenerator {
  readonly id = "fake";
  readonly specs: SongSpec[] = [];
  private resolveNext: ((song: GeneratedSong) => void) | undefined;
  private rejectNext: ((error: Error) => void) | undefined;
  lastSignal: AbortSignal | undefined;
  lastOutDir: string | undefined;

  generate(spec: SongSpec, options: { outDir: string; signal: AbortSignal }): Promise<GeneratedSong> {
    this.specs.push(spec);
    this.lastSignal = options.signal;
    this.lastOutDir = options.outDir;
    return new Promise((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }

  finish(song: Partial<GeneratedSong> = {}): void {
    this.resolveNext?.({
      title: song.title ?? this.specs[this.specs.length - 1]?.title ?? "song",
      audioPath: song.audioPath ?? "/songs/song.mp3",
      provider: "fake",
      durationMs: song.durationMs,
    });
  }

  fail(message: string): void {
    this.rejectNext?.(new Error(message));
  }
}

class FakeMusic implements MusicController {
  isPlaying = false;
  nowPlaying: MusicTrack | undefined;
  queueLength = 0;
  volume = 0.6;
  paused = false;
  readonly plays: MusicPlayRequest[] = [];
  failWith: Error | undefined;

  async play(request: MusicPlayRequest): Promise<MusicTrack> {
    this.plays.push(request);
    if (this.failWith) {
      throw this.failWith;
    }
    const track: MusicTrack = {
      id: "t1",
      title: request.title ?? "song",
      streamUrl: request.file ?? request.url ?? "",
      request: request.title ?? "",
      isFile: Boolean(request.file),
    };
    this.isPlaying = true;
    this.nowPlaying = track;
    return track;
  }

  async playSource(): Promise<MusicTrack> {
    return this.play({});
  }

  stop(): boolean {
    const was = this.isPlaying;
    this.isPlaying = false;
    return was;
  }

  setVolume(volume: number): number {
    this.volume = volume;
    return volume;
  }

  close(): void {}

  nowPlayingInfo() {
    return this.nowPlaying ? { track: this.nowPlaying, elapsedMs: 0, paused: this.paused } : undefined;
  }

  listQueue(): MusicTrack[] {
    return [];
  }

  skip(): MusicTrack | undefined {
    this.isPlaying = false;
    return undefined;
  }

  removeFromQueue(): MusicTrack | undefined {
    return undefined;
  }

  moveInQueue(): MusicTrack[] {
    return [];
  }

  clearQueue(): number {
    return 0;
  }

  async search(): Promise<never[]> {
    return [];
  }

  pause(): boolean {
    if (!this.isPlaying || this.paused) {
      return false;
    }
    this.paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.paused) {
      return false;
    }
    this.paused = false;
    return true;
  }

  async seek(): Promise<MusicTrack> {
    if (!this.nowPlaying) {
      throw new Error("Nothing is playing to seek.");
    }
    return this.nowPlaying;
  }
}

function config(overrides: Partial<ResolvedTeamSpeakBandConfig> = {}): ResolvedTeamSpeakBandConfig {
  return {
    name: undefined,
    aliases: undefined,
    provider: "command",
    minimax: { apiKey: undefined, baseUrl: "https://api.minimax.io", model: "music-3.0" },
    sunoApi: { baseUrl: undefined, apiKey: undefined },
    command: { path: "/bin/true", args: [] },
    songsDir: "/songs",
    generateTimeoutMs: 5_000,
    announce: true,
    introGapMs: 700,
    keepSongs: 20,
    ...overrides,
  };
}

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

function harness(options: { config?: Partial<ResolvedTeamSpeakBandConfig>; speak?: boolean } = {}) {
  const generator = new FakeGenerator();
  const music = new FakeMusic();
  const spoken: string[] = [];
  const logs: string[] = [];
  const settled: BandStatus[] = [];
  let clock = 1_000_000;
  const band = new BandLeader({
    config: config(options.config),
    generator,
    music,
    speak:
      options.speak === false
        ? undefined
        : async (text) => {
            spoken.push(text);
            return { durationMs: 2_300 };
          },
    rng: seeded(7),
    now: () => clock,
    onSettled: (status) => settled.push(status),
    log: (message) => logs.push(message),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { band, generator, music, spoken, logs, settled, settle, tick: (ms: number) => (clock += ms) };
}

describe("BandLeader.compose", () => {
  it("returns at once with the style, then generates, announces and plays off the turn", async () => {
    const h = harness();
    const outcome = h.band.compose({
      title: "Kai's Truck",
      brief: "a sad one about Kai's truck breaking down again",
      vocals: true,
      lyrics: "[Verse]\nthe truck is dead\n[Chorus]\nagain, again",
      requestedBy: "Brandon",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.title).toBe("Kai's Truck");
    expect(outcome.mood).toBe("mournful");
    expect(outcome.style).toContain("Vintage lounge jazz");
    expect(h.band.status().status).toBe("composing");
    // Nothing has been played or said yet: the generator has not answered.
    expect(h.music.plays).toHaveLength(0);
    expect(h.spoken).toHaveLength(0);
    expect(h.generator.specs[0]).toMatchObject({
      title: "Kai's Truck",
      vocals: true,
      lyrics: "[Verse]\nthe truck is dead\n[Chorus]\nagain, again",
    });
    expect(h.generator.lastOutDir).toBe("/songs");

    h.tick(90_000);
    h.generator.finish({ audioPath: "/songs/kais-truck.mp3", durationMs: 120_000 });
    await h.settle();
    await h.settle();

    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toMatch(/Velvet Vice Lounge Band|Digital Heart Club Band|"Kai's Truck"/u);
    expect(h.music.plays).toEqual([
      { file: "/songs/kais-truck.mp3", title: "Kai's Truck", startDelayMs: 2_300 + 700 },
    ]);
    expect(h.band.status().status).toBe("idle");
    expect(h.band.status().lastSong).toEqual({
      title: "Kai's Truck",
      audioPath: "/songs/kais-truck.mp3",
      provider: "fake",
      vocals: true,
      lyrics: "[Verse]\nthe truck is dead\n[Chorus]\nagain, again",
      singer: "bexton",
    });
    expect(h.settled.map((status) => status.status)).toEqual(["playing"]);
    expect(h.logs.some((line) => line.includes('composing "Kai\'s Truck"') && line.includes("mood=mournful"))).toBe(true);
  });

  it("plays without an introduction when the lane cannot speak or announcing is off", async () => {
    for (const h of [harness({ speak: false }), harness({ config: { announce: false } })]) {
      h.band.compose({ brief: "anything", vocals: false });
      h.generator.finish({ audioPath: "/songs/x.mp3" });
      await h.settle();
      await h.settle();
      expect(h.spoken).toHaveLength(0);
      expect(h.music.plays).toEqual([{ file: "/songs/x.mp3", title: "Anything", startDelayMs: 0 }]);
    }
  });

  it("refuses a second song while one is cooking, and a sung song without lyrics", () => {
    const h = harness();
    expect(h.band.compose({ brief: "one", vocals: false }).ok).toBe(true);
    const second = h.band.compose({ brief: "two", vocals: false });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toContain("already working");
      expect(second.status.status).toBe("composing");
    }

    const g = harness();
    const noLyrics = g.band.compose({ brief: "sing about Kai", vocals: true });
    expect(noLyrics.ok).toBe(false);
    if (!noLyrics.ok) {
      expect(noLyrics.error).toContain("needs lyrics");
    }
    expect(g.generator.specs).toHaveLength(0);
  });

  it("says the failure in character and records why", async () => {
    const h = harness();
    h.band.compose({ brief: "anything", vocals: false });
    h.generator.fail("MiniMax music refused (status 2153): no longer available to new users");
    await h.settle();
    await h.settle();
    expect(h.music.plays).toHaveLength(0);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).not.toContain("2153");
    const status = h.band.status();
    expect(status.status).toBe("failed");
    expect(status.error).toContain("2153");
    // #3601: band_status (and the silent event built from it) must still
    // name which song failed — there is no job left to read the title from.
    expect(status.title).toBe("Anything");
    expect(h.settled.map((s) => s.status)).toEqual(["failed"]);
    // And the band is free again.
    expect(h.band.compose({ brief: "again", vocals: false }).ok).toBe(true);
  });

  it("aborts the generator at the timeout", async () => {
    const h = harness({ config: { generateTimeoutMs: 20 } });
    h.band.compose({ brief: "slow one", vocals: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.generator.lastSignal?.aborted).toBe(true);
    // The generator honours the abort by rejecting; the leader reports the timeout, not the rejection.
    h.generator.fail("aborted");
    await h.settle();
    await h.settle();
    expect(h.band.status().status).toBe("failed");
    expect(h.band.status().error).toContain("timed out");
  });

  it("still plays when the announcement itself fails", async () => {
    const generator = new FakeGenerator();
    const music = new FakeMusic();
    const band = new BandLeader({
      config: config(),
      generator,
      music,
      speak: async () => {
        throw new Error("tts down");
      },
      rng: seeded(1),
    });
    band.compose({ brief: "anything", vocals: false });
    generator.finish({ audioPath: "/songs/y.mp3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(music.plays).toEqual([{ file: "/songs/y.mp3", title: "Anything", startDelayMs: 0 }]);
  });

  it("close aborts the job and drops its result on the floor", async () => {
    const h = harness();
    h.band.compose({ brief: "anything", vocals: false });
    h.band.close();
    expect(h.generator.lastSignal?.aborted).toBe(true);
    h.generator.finish({ audioPath: "/songs/z.mp3" });
    await h.settle();
    await h.settle();
    expect(h.music.plays).toHaveLength(0);
    expect(h.spoken).toHaveLength(0);
  });

  it("prunes the songs dir down to keepSongs after a song lands", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-prune-"));
    for (let i = 0; i < 5; i += 1) {
      await writeFile(path.join(dir, `old-${i}.mp3`), "x");
    }
    const generator = new FakeGenerator();
    const music = new FakeMusic();
    const band = new BandLeader({
      config: config({ songsDir: dir, keepSongs: 2, announce: false }),
      generator,
      music,
      rng: seeded(1),
    });
    band.compose({ brief: "anything", vocals: false });
    generator.finish({ audioPath: path.join(dir, "new.mp3") });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const left = await readdir(dir);
    expect(left).toHaveLength(2);
  });
});

describe("BandLeader.lyrics (#3601)", () => {
  it("gives back the last song's lyrics, and refuses before anything has played", async () => {
    const h = harness();
    expect(h.band.lyrics()).toEqual({
      ok: false,
      error: "Nothing's been played yet tonight.",
    });
    h.band.compose({
      title: "Kai's Truck",
      brief: "a sad one about Kai's truck",
      vocals: true,
      lyrics: "[Verse]\ntest line one\n[Chorus]\ntest line two",
    });
    h.generator.finish({ audioPath: "/songs/kais-truck.mp3" });
    await h.settle();
    await h.settle();
    expect(h.band.lyrics()).toEqual({
      ok: true,
      title: "Kai's Truck",
      singer: "bexton",
      lyrics: "[Verse]\ntest line one\n[Chorus]\ntest line two",
    });
    expect(h.band.lyrics("truck")).toMatchObject({ ok: true, title: "Kai's Truck" });
    expect(h.band.lyrics("nope")).toEqual({
      ok: false,
      error: 'No song called "nope" in what I remember playing.',
    });
  });

  it("refuses lyrics for an instrumental", async () => {
    const h = harness();
    h.band.compose({ title: "Just Horns", brief: "instrumental", vocals: false });
    h.generator.finish({ audioPath: "/songs/just-horns.mp3" });
    await h.settle();
    await h.settle();
    expect(h.band.lyrics()).toEqual({
      ok: false,
      error: '"Just Horns" was instrumental. No lyrics — just the band.',
    });
  });
});

describe("BandLeader.replay (#3601)", () => {
  it("plays the last song again without calling the generator", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-replay-"));
    const audioPath = path.join(dir, "kais-truck.mp3");
    await writeFile(audioPath, "x");
    const h = harness({ config: { songsDir: dir } });
    h.band.compose({ title: "Kai's Truck", brief: "anything", vocals: false });
    h.generator.finish({ audioPath });
    await h.settle();
    await h.settle();
    expect(h.generator.specs).toHaveLength(1);

    const outcome = h.band.replay({ requestedBy: "Brandon" });
    expect(outcome).toEqual({ ok: true, title: "Kai's Truck", singer: undefined });
    expect(h.band.status().status).toBe("composing");
    await h.settle();
    await h.settle();

    // No second generator call: the replay reused the file on disk.
    expect(h.generator.specs).toHaveLength(1);
    expect(h.music.plays).toEqual([
      { file: audioPath, title: "Kai's Truck", startDelayMs: 2_300 + 700 },
      { file: audioPath, title: "Kai's Truck", startDelayMs: 2_300 + 700 },
    ]);
    expect(h.band.status().status).toBe("idle");
  });

  it("finds an older song by a fragment of its title", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-replay-"));
    const pathA = path.join(dir, "a.mp3");
    const pathB = path.join(dir, "b.mp3");
    await writeFile(pathA, "x");
    await writeFile(pathB, "x");
    const h = harness({ config: { songsDir: dir } });
    h.band.compose({ title: "Kai's Truck", brief: "one", vocals: false });
    h.generator.finish({ audioPath: pathA });
    await h.settle();
    await h.settle();
    h.band.compose({ title: "Tuesday Blues", brief: "two", vocals: false });
    h.generator.finish({ audioPath: pathB });
    await h.settle();
    await h.settle();

    const outcome = h.band.replay({ titleQuery: "truck" });
    expect(outcome).toEqual({ ok: true, title: "Kai's Truck", singer: undefined });
    await h.settle();
    await h.settle();
    expect(h.music.plays.at(-1)).toMatchObject({ file: pathA, title: "Kai's Truck" });
  });

  it("refuses to replay while a song is cooking, and when nothing matches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-replay-"));
    const pathA = path.join(dir, "a.mp3");
    const pathB = path.join(dir, "b.mp3");
    await writeFile(pathA, "x");
    await writeFile(pathB, "x");
    const h = harness({ config: { songsDir: dir } });
    expect(h.band.replay({})).toEqual({
      ok: false,
      error: "Nothing's been played yet tonight, so there's nothing to bring back.",
    });

    h.band.compose({ title: "Kai's Truck", brief: "one", vocals: false });
    h.generator.finish({ audioPath: pathA });
    await h.settle();
    await h.settle();

    h.band.compose({ title: "Tuesday Blues", brief: "two", vocals: false });
    const busy = h.band.replay({});
    expect(busy).toEqual({
      ok: false,
      error: 'The band is already working on "Tuesday Blues". One song at a time.',
    });

    h.generator.finish({ audioPath: pathB });
    await h.settle();
    await h.settle();
    expect(h.band.replay({ titleQuery: "nope" })).toEqual({
      ok: false,
      error: 'No song called "nope" in what I remember playing.',
    });
  });

  it("fails in character when the recording has been pruned off disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-replay-"));
    const generator = new FakeGenerator();
    const music = new FakeMusic();
    const spoken: string[] = [];
    const band = new BandLeader({
      config: config({ songsDir: dir, keepSongs: 20 }),
      generator,
      music,
      speak: async (text) => {
        spoken.push(text);
        return { durationMs: 100 };
      },
      rng: seeded(1),
    });
    band.compose({ title: "Gone Song", brief: "anything", vocals: false });
    generator.finish({ audioPath: path.join(dir, "missing.mp3") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const outcome = band.replay({});
    expect(outcome.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(band.status().status).toBe("failed");
    expect(band.status().error).toContain("Gone Song");
  });
});
