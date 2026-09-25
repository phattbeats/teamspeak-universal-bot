/**
 * The tool surface itself: definitions, argument handling, dispatch, timing log.
 *
 * The music controller and the log reader are fakes here; their real behavior
 * is covered by music.test.ts and catch-up.test.ts. What is asserted is what
 * the provider sees — that every call settles with a result, that a thrown
 * handler becomes `ok: false` rather than a hung turn, and that a spoken
 * nickname finds the right person.
 */
import { describe, expect, it } from "vitest";
import type { RosterEntry } from "../src/bridge/protocol.js";
import type { ChannelLogResult, ReadChannelLogParams } from "../src/tools/catch-up.js";
import type { MusicController, MusicTrack } from "../src/tools/music.js";
import type { BandController, ComposeRequest } from "../src/tools/band.js";
import {
  BAND_STATUS_TOOL,
  buildTeamSpeakTools,
  COMPOSE_SONG_TOOL,
  createTeamSpeakToolRegistration,
  JOIN_VOICE_TOOL,
  LEAVE_VOICE_TOOL,
  PLAY_MUSIC_TOOL,
  POKE_TOOL,
  REPLAY_SONG_TOOL,
  SET_VOLUME_TOOL,
  SONG_LYRICS_TOOL,
  STOP_MUSIC_TOOL,
  WHAT_DID_I_MISS_TOOL,
  WHO_IS_HERE_TOOL,
  type TeamSpeakToolDeps,
} from "../src/tools/registry.js";

class FakeMusic implements MusicController {
  isPlaying = false;
  nowPlaying: MusicTrack | undefined;
  queueLength = 0;
  volume = 0.6;
  paused = false;
  readonly requests: { query?: string; url?: string; enqueue?: boolean }[] = [];
  readonly stops: string[] = [];
  failWith: Error | undefined;
  private queue: MusicTrack[] = [];
  private nextId = 1;

  async play(request: { query?: string; url?: string; enqueue?: boolean }): Promise<MusicTrack> {
    this.requests.push(request);
    if (this.failWith) {
      throw this.failWith;
    }
    const track: MusicTrack = {
      id: `t${this.nextId++}`,
      title: "Smooth Jazz Radio",
      streamUrl: "https://cdn.example/a.webm",
      request: request.query ?? request.url ?? "",
    };
    if (request.enqueue && this.isPlaying) {
      this.queueLength += 1;
      this.queue.push(track);
      return { ...track, queuedPosition: this.queueLength };
    }
    this.isPlaying = true;
    this.nowPlaying = track;
    return track;
  }

  async playSource(): Promise<MusicTrack> {
    return this.play({});
  }

  stop(reason: string): boolean {
    this.stops.push(reason);
    const wasPlaying = this.isPlaying;
    this.queueLength = 0;
    this.queue = [];
    this.isPlaying = false;
    this.nowPlaying = undefined;
    return wasPlaying;
  }

  setVolume(volume: number): number {
    this.volume = Math.min(1, Math.max(0, volume));
    return this.volume;
  }

  close(): void {
    this.stop("close");
  }

  nowPlayingInfo() {
    return this.nowPlaying ? { track: this.nowPlaying, elapsedMs: 0, paused: this.paused } : undefined;
  }

  listQueue(): MusicTrack[] {
    return [...this.queue];
  }

  skip(): MusicTrack | undefined {
    const next = this.queue.shift();
    this.queueLength = this.queue.length;
    this.nowPlaying = next;
    this.isPlaying = next !== undefined;
    return next;
  }

  removeFromQueue(id: string): MusicTrack | undefined {
    const index = this.queue.findIndex((t) => t.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = this.queue.splice(index, 1);
    this.queueLength = this.queue.length;
    return removed;
  }

  moveInQueue(id: string, toPosition: number): MusicTrack[] {
    const index = this.queue.findIndex((t) => t.id === id);
    if (index < 0) {
      return [...this.queue];
    }
    const [track] = this.queue.splice(index, 1);
    if (track) {
      this.queue.splice(Math.max(0, toPosition - 1), 0, track);
    }
    return [...this.queue];
  }

  clearQueue(): number {
    const count = this.queue.length;
    this.queue = [];
    this.queueLength = 0;
    return count;
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

const ROSTER: RosterEntry[] = [
  { clientId: 4, nickname: "Brandon", muted: false, away: false },
  { clientId: 7, nickname: "[PHATT] Kai_", muted: true, away: false },
];

type Harness = {
  deps: TeamSpeakToolDeps;
  music: FakeMusic;
  logs: string[];
  pokes: { clientId: number; text: string }[];
  logRequests: ReadChannelLogParams[];
  call: (name: string, args?: unknown) => Promise<Record<string, unknown> & { ok: boolean }>;
};

function createHarness(
  options: {
    music?: MusicController | undefined;
    noMusic?: boolean;
    channelName?: string;
    log?: ChannelLogResult;
  } = {},
): Harness {
  const music = new FakeMusic();
  const logs: string[] = [];
  const pokes: { clientId: number; text: string }[] = [];
  const logRequests: ReadChannelLogParams[] = [];
  const parkings: { parked: boolean; reason: string }[] = [];
  let parked = false;
  const deps: TeamSpeakToolDeps = {
    config: undefined,
    music: options.noMusic ? undefined : (options.music ?? music),
    roster: () => ROSTER,
    channelName: () => options.channelName ?? "General Shit",
    poke: (clientId, text) => pokes.push({ clientId, text }),
    logDir: "/mnt/user/appdata/sexton",
    readLog: async (params) => {
      logRequests.push(params);
      return (
        options.log ?? {
          entries: [
            {
              time: "18:01",
              nickname: "Kai",
              text: "we start at nine",
              line: "18:01  Kai: we start at nine",
              at: new Date(2026, 8, 6, 18, 1),
            },
          ],
          lines: ["18:01  Kai: we start at nine"],
          filesRead: ["/mnt/user/appdata/sexton/General Shit/2026-09-06.md"],
          skippedLines: 0,
        }
      );
    },
    log: (message) => logs.push(message),
    setParked: (next, reason) => {
      parked = next;
      parkings.push({ parked: next, reason });
    },
    isParked: () => parked,
  };
  const registration = createTeamSpeakToolRegistration(deps);
  return {
    deps,
    music,
    logs,
    pokes,
    logRequests,
    call: async (name, args) =>
      (await registration.handle(
        { itemId: "item-1", callId: `call-${name}`, name, args: args ?? {} },
        { clientId: 4, nickname: "Brandon" },
      )) as Record<string, unknown> & { ok: boolean },
  };
}

describe("tool definitions", () => {
  it("registers the v1 tools plus the music queue v2 tools", () => {
    expect(buildTeamSpeakTools({ music: true }).map((tool) => tool.name)).toEqual([
      PLAY_MUSIC_TOOL,
      STOP_MUSIC_TOOL,
      SET_VOLUME_TOOL,
      "now_playing",
      "show_queue",
      "skip",
      "remove_from_queue",
      "move_in_queue",
      "clear_queue",
      "search_music",
      "play_source",
      "pause",
      "resume",
      "seek",
      WHAT_DID_I_MISS_TOOL,
      WHO_IS_HERE_TOOL,
      POKE_TOOL,
      LEAVE_VOICE_TOOL,
      JOIN_VOICE_TOOL,
    ]);
  });

  it("omits the music tools when there is no player, so the model cannot promise music", () => {
    const names = buildTeamSpeakTools({ music: false }).map((tool) => tool.name);
    expect(names).toEqual([
      WHAT_DID_I_MISS_TOOL,
      WHO_IS_HERE_TOOL,
      POKE_TOOL,
      LEAVE_VOICE_TOOL,
      JOIN_VOICE_TOOL,
    ]);
  });

  it("keeps confirmations short by instruction, not by persona", () => {
    const play = buildTeamSpeakTools({ music: true }).find((tool) => tool.name === PLAY_MUSIC_TOOL);
    expect(play?.description).toMatch(/Confirm in a few words/u);
    expect(play?.parameters.required).toBeUndefined();
  });
});

describe("the house band (PHA-3554)", () => {
  it("adds compose_song and band_status only when an account has a band", () => {
    const names = buildTeamSpeakTools({ music: true, band: true }).map((tool) => tool.name);
    expect(names.slice(-4)).toEqual([
      COMPOSE_SONG_TOOL,
      BAND_STATUS_TOOL,
      SONG_LYRICS_TOOL,
      REPLAY_SONG_TOOL,
    ]);
    expect(buildTeamSpeakTools({ music: true }).map((tool) => tool.name)).not.toContain(
      COMPOSE_SONG_TOOL,
    );
    const registration = createTeamSpeakToolRegistration({
      ...createHarness().deps,
      band: undefined,
    });
    expect(registration.tools.map((tool) => tool.name)).not.toContain(COMPOSE_SONG_TOOL);
  });

  it("hands compose_song to the band with the caller as the requester", async () => {
    const composed: ComposeRequest[] = [];
    const band: BandController = {
      compose: (request) => {
        composed.push(request);
        return { ok: true, title: request.title ?? "?", style: "Vintage lounge jazz.", styleTags: "", mood: "house", keywords: [], singer: request.singer };
      },
      status: () => ({
        status: "composing",
        bandName: "The Velvet Vice Lounge Band",
        provider: "fake",
        title: "Tuesday Again",
        startedAt: 1,
        elapsedMs: 5,
        error: undefined,
        style: undefined,
        mood: undefined,
        singer: undefined,
        announcement: undefined,
        lastSong: undefined,
      }),
      lyrics: (title) =>
        title
          ? { ok: false, error: `No song called "${title}" in what I remember playing.` }
          : { ok: true, title: "Tuesday Again", singer: "bexton", lyrics: "[Verse]\ntest lyric line" },
      replay: (request) => ({ ok: true, title: request.titleQuery ?? "Tuesday Again", singer: "bexton" }),
      close: () => undefined,
    };
    const deps = { ...createHarness().deps, band };
    const registration = createTeamSpeakToolRegistration(deps);
    const call = (name: string, args: unknown) =>
      registration.handle(
        { itemId: "i", callId: `c-${name}`, name, args },
        { clientId: 4, nickname: "Brandon" },
      ) as Promise<Record<string, unknown> & { ok: boolean }>;

    const result = await call(COMPOSE_SONG_TOOL, {
      title: "Tuesday Again",
      brief: "a song about Tuesdays",
      vocals: "true",
      lyrics: "[Verse]\nit is Tuesday",
      dedicatedTo: "Kai",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("composing");
    expect(result.title).toBe("Tuesday Again");
    expect(String(result.next)).toContain("one short line");
    expect(composed).toEqual([
      {
        title: "Tuesday Again",
        brief: "a song about Tuesdays",
        vocals: true,
        singer: "bexton",
        lyrics: "[Verse]\nit is Tuesday",
        mood: undefined,
        dedicatedTo: "Kai",
        requestedBy: "Brandon",
      },
    ]);

    const missing = await call(COMPOSE_SONG_TOOL, { vocals: false });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain("brief");

    const status = await call(BAND_STATUS_TOOL, {});
    expect(status).toMatchObject({ ok: true, status: "composing", title: "Tuesday Again" });

    const noBand = await (createTeamSpeakToolRegistration({ ...deps, band: undefined }).handle(
      { itemId: "i", callId: "c", name: COMPOSE_SONG_TOOL, args: { brief: "x", vocals: false } },
      { clientId: 4, nickname: "Brandon" },
    ) as Promise<Record<string, unknown> & { ok: boolean }>);
    expect(noBand.ok).toBe(false);

    const lyrics = await call(SONG_LYRICS_TOOL, {});
    expect(lyrics).toMatchObject({ ok: true, title: "Tuesday Again", singer: "bexton" });
    expect(String(lyrics.lyrics)).toContain("test lyric line");

    const missingLyrics = await call(SONG_LYRICS_TOOL, { title: "Nope" });
    expect(missingLyrics.ok).toBe(false);
    expect(String(missingLyrics.error)).toContain("Nope");

    const replayed = await call(REPLAY_SONG_TOOL, { title: "Tuesday Again" });
    expect(replayed).toMatchObject({ ok: true, status: "announcing", title: "Tuesday Again" });
    expect(String(replayed.next)).toContain("bringing it back");
  });
});

describe("play_music / stop_music / set_volume", () => {
  it("plays a search query and reports the resolved title", async () => {
    const harness = createHarness();
    const result = await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });

    expect(result).toMatchObject({ ok: true, title: "Smooth Jazz Radio", request: "smooth jazz" });
    expect(harness.music.requests).toEqual([{ query: "smooth jazz", enqueue: true }]);
  });

  it("accepts arguments as a JSON string, which some providers send", async () => {
    const harness = createHarness();
    const result = await harness.call(PLAY_MUSIC_TOOL, '{"url":"https://youtu.be/abc"}');

    expect(result.ok).toBe(true);
    expect(harness.music.requests).toEqual([{ url: "https://youtu.be/abc", enqueue: true }]);
  });

  it("settles a failed play as ok:false instead of leaving the turn hanging", async () => {
    const harness = createHarness();
    harness.music.failWith = new Error("Could not find anything for \"gabber polka\".");
    const result = await harness.call(PLAY_MUSIC_TOOL, { query: "gabber polka" });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/gabber polka/u);
  });

  it("reports whether stop actually stopped something", async () => {
    const harness = createHarness();
    expect(await harness.call(STOP_MUSIC_TOOL)).toMatchObject({ ok: true, wasPlaying: false });
    await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    expect(await harness.call(STOP_MUSIC_TOOL)).toMatchObject({ ok: true, wasPlaying: true });
    expect(harness.music.stops).toEqual(["stop_music", "stop_music"]);
  });

  it("queues a request instead of interrupting what's already playing (PHA-3635)", async () => {
    const harness = createHarness();
    const first = await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    expect(first).toMatchObject({ ok: true, title: "Smooth Jazz Radio" });
    expect(first.queued).toBeUndefined();

    const second = await harness.call(PLAY_MUSIC_TOOL, { query: "some death metal" });
    expect(second).toMatchObject({ ok: true, queued: true, position: 1 });

    const third = await harness.call(PLAY_MUSIC_TOOL, { query: "polka" });
    expect(third).toMatchObject({ ok: true, queued: true, position: 2 });

    // Nothing was interrupted: only the first request's play() started a track.
    expect(harness.music.isPlaying).toBe(true);
  });

  it("reports how many queued songs stop_music clears along with the current track", async () => {
    const harness = createHarness();
    await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "some death metal" });

    const stopped = await harness.call(STOP_MUSIC_TOOL);
    expect(stopped).toMatchObject({ ok: true, wasPlaying: true, queueCleared: 1 });
  });

  it("reads a bare number over 1 as a percentage", async () => {
    const harness = createHarness();
    expect(await harness.call(SET_VOLUME_TOOL, { volume: 40 })).toMatchObject({ volume: 0.4 });
    expect(await harness.call(SET_VOLUME_TOOL, { volume: 0.25 })).toMatchObject({ volume: 0.25 });
    expect((await harness.call(SET_VOLUME_TOOL, {})).ok).toBe(false);
  });

  it("says music is off rather than failing silently when there is no player", async () => {
    const harness = createHarness({ noMusic: true });
    const result = await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toMatch(/not enabled/u);
  });
});

describe("music queue v2 tools (PHA-3785)", () => {
  it("now_playing reports nothing playing, then the current track", async () => {
    const harness = createHarness();
    expect(await harness.call("now_playing")).toMatchObject({ ok: true, playing: false });

    await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    const info = await harness.call("now_playing");
    expect(info).toMatchObject({ ok: true, playing: true, title: "Smooth Jazz Radio" });
  });

  it("show_queue reflects previously-added tracks", async () => {
    const harness = createHarness();
    await harness.call(PLAY_MUSIC_TOOL, { query: "first" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "second" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "third" });

    const result = await harness.call("show_queue");
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect((result.queue as { title: string }[]).map((t) => t.title)).toEqual([
      "Smooth Jazz Radio",
      "Smooth Jazz Radio",
    ]);
  });

  it("skip advances without clearing the rest of the queue and reports it plainly", async () => {
    const harness = createHarness();
    expect(await harness.call("skip")).toMatchObject({ ok: false });

    await harness.call(PLAY_MUSIC_TOOL, { query: "first" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "second" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "third" });

    const result = await harness.call("skip");
    expect(result).toMatchObject({ ok: true, skipped: true, remaining: 1 });
  });

  it("remove_from_queue removes the requested track", async () => {
    const harness = createHarness();
    await harness.call(PLAY_MUSIC_TOOL, { query: "first" });
    const second = await harness.call(PLAY_MUSIC_TOOL, { query: "second" });
    const id = harness.music.listQueue()[0]?.id;
    expect(id).toBeDefined();

    const result = await harness.call("remove_from_queue", { id });
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(second.queued).toBe(true);

    const missing = await harness.call("remove_from_queue", { id: "bogus" });
    expect(missing.ok).toBe(false);
  });

  it("move_in_queue reorders and clear_queue empties without stopping playback", async () => {
    const harness = createHarness();
    await harness.call(PLAY_MUSIC_TOOL, { query: "first" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "second" });
    await harness.call(PLAY_MUSIC_TOOL, { query: "third" });
    const [secondId] = harness.music.listQueue().map((t) => t.id);

    const moved = await harness.call("move_in_queue", { id: secondId, position: 2 });
    expect(moved.ok).toBe(true);

    const cleared = await harness.call("clear_queue");
    expect(cleared).toMatchObject({ ok: true, cleared: 2 });
    expect(harness.music.isPlaying).toBe(true);
  });

  it("search_music returns candidates without auto-playing anything", async () => {
    const harness = createHarness();
    const result = await harness.call("search_music", { query: "smooth jazz", limit: 3 });
    expect(result.ok).toBe(true);
    expect(harness.music.isPlaying).toBe(false);
  });

  it("play_source dispatches to the controller with the given source", async () => {
    const harness = createHarness();
    const result = await harness.call("play_source", { source: "youtube", query: "smooth jazz" });
    expect(result).toMatchObject({ ok: true, source: "youtube" });
  });

  it("play_source without a source fails clearly", async () => {
    const harness = createHarness();
    const result = await harness.call("play_source", {});
    expect(result.ok).toBe(false);
  });

  it("pause and resume flip playback state, seek reports the new position", async () => {
    const harness = createHarness();
    expect((await harness.call("pause")).ok).toBe(false);

    await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    expect(await harness.call("pause")).toMatchObject({ ok: true, paused: true });
    expect(await harness.call("resume")).toMatchObject({ ok: true, resumed: true });

    const seek = await harness.call("seek", { seconds: 30 });
    expect(seek).toMatchObject({ ok: true, seconds: 30 });
  });

  it("all queue v2 tools say music is off when there is no player", async () => {
    const harness = createHarness({ noMusic: true });
    for (const name of ["now_playing", "show_queue", "skip", "search_music", "pause", "resume"]) {
      const result = await harness.call(name);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not enabled/u);
    }
  });
});

describe("what_did_i_miss", () => {
  it("returns the rendered log lines for the current channel", async () => {
    const harness = createHarness();
    const result = await harness.call(WHAT_DID_I_MISS_TOOL, {});

    expect(result).toMatchObject({ ok: true, channel: "General Shit", count: 1 });
    expect(result.text).toBe("18:01  Kai: we start at nine");
    expect(harness.logRequests[0]).toMatchObject({ channelName: "General Shit", limit: 15 });
    expect(harness.logRequests[0]?.minutes).toBeUndefined();
  });

  it("passes a minutes window through and clamps an absurd one", async () => {
    const harness = createHarness();
    await harness.call(WHAT_DID_I_MISS_TOOL, { minutes: 30 });
    await harness.call(WHAT_DID_I_MISS_TOOL, { minutes: 100_000 });

    expect(harness.logRequests[0]?.minutes).toBe(30);
    expect(harness.logRequests[1]?.minutes).toBe(720);
  });

  it("answers in words when nothing was said", async () => {
    const harness = createHarness({
      log: { entries: [], lines: [], filesRead: [], skippedLines: 0 },
    });
    const result = await harness.call(WHAT_DID_I_MISS_TOOL, { minutes: 10 });

    expect(result).toMatchObject({ ok: true, count: 0 });
    expect(result.text).toBe("Nothing said in General Shit in the last 10 minutes.");
  });

  it("declines when the bridge is not in a channel yet", async () => {
    const harness = createHarness({ channelName: "" });
    expect((await harness.call(WHAT_DID_I_MISS_TOOL, {})).ok).toBe(false);
  });
});

describe("who_is_here and poke", () => {
  it("lists the roster and marks the caller", async () => {
    const harness = createHarness();
    const result = await harness.call(WHO_IS_HERE_TOOL);

    expect(result).toMatchObject({ ok: true, count: 2 });
    expect(result.people).toEqual([
      { nickname: "Brandon", muted: false, away: false, isYou: true },
      { nickname: "[PHATT] Kai_", muted: true, away: false, isYou: false },
    ]);
  });

  it("pokes by nickname, ignoring case and the decoration a transcript drops", async () => {
    const harness = createHarness();
    const result = await harness.call(POKE_TOOL, { nickname: "kai", text: "you're up" });

    expect(result).toMatchObject({ ok: true, nickname: "[PHATT] Kai_", clientId: 7 });
    expect(harness.pokes).toEqual([{ clientId: 7, text: "you're up" }]);
  });

  it("names who is here when the nickname does not match", async () => {
    const harness = createHarness();
    const result = await harness.call(POKE_TOOL, { nickname: "Steve", text: "hi" });

    expect(result.ok).toBe(false);
    expect(result.here).toEqual(["Brandon", "[PHATT] Kai_"]);
    expect(harness.pokes).toEqual([]);
  });

  it("requires both a target and a text", async () => {
    const harness = createHarness();
    expect((await harness.call(POKE_TOOL, { text: "hi" })).ok).toBe(false);
    expect((await harness.call(POKE_TOOL, { nickname: "Brandon" })).ok).toBe(false);
    expect(harness.pokes).toEqual([]);
  });
});

describe("dispatch", () => {
  it("settles an unknown tool name", async () => {
    const harness = createHarness();
    const result = await harness.call("launch_missiles", {});
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Unknown TeamSpeak tool/u);
  });

  it("logs every call with caller, arguments, outcome and duration", async () => {
    const harness = createHarness();
    await harness.call(PLAY_MUSIC_TOOL, { query: "smooth jazz" });
    await harness.call(POKE_TOOL, { nickname: "nobody", text: "hi" });

    expect(harness.logs[0]).toMatch(
      /^teamspeak tool: play_music caller=Brandon#4 args=\{"query":"smooth jazz"\} ok=true \d+ms$/u,
    );
    expect(harness.logs[1]).toMatch(/ok=false error="No one here is called "nobody"\." \d+ms$/u);
  });
});
