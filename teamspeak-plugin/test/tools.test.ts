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
import type { ChannelInfo, RosterEntry, TeamSpeakClientId } from "../src/bridge/protocol.js";
import type { ChannelLogResult, ReadChannelLogParams } from "../src/tools/catch-up.js";
import type { MusicController, MusicTrack } from "../src/tools/music.js";
import type { BandController, ComposeRequest } from "../src/tools/band.js";
import {
  BAND_STATUS_TOOL,
  buildTeamSpeakTools,
  COMPOSE_SONG_TOOL,
  createTeamSpeakToolRegistration,
  JOIN_VOICE_TOOL,
  KICK_CLIENT_TOOL,
  LEAVE_VOICE_TOOL,
  MOVE_CLIENT_TOOL,
  LIST_CHANNELS_TOOL,
  MOVE_TO_CHANNEL_TOOL,
  PLAY_MUSIC_TOOL,
  POKE_TOOL,
  REPLAY_SONG_TOOL,
  SEND_TEXT_TOOL,
  SUMMON_BOT_TOOL,
  DISMISS_BOT_TOOL,
  SET_VOLUME_TOOL,
  SONG_LYRICS_TOOL,
  STOP_MUSIC_TOOL,
  WHAT_DID_I_MISS_TOOL,
  WHERE_IS_TOOL,
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
  sentTexts: { target: unknown; text: string }[];
  moderationCalls: { fn: string; args: unknown[] }[];
  moves: string[];
  call: (name: string, args?: unknown) => Promise<Record<string, unknown> & { ok: boolean }>;
};

function createHarness(
  options: {
    music?: MusicController | undefined;
    noMusic?: boolean;
    channelName?: string;
    log?: ChannelLogResult;
    config?: TeamSpeakToolDeps["config"];
    roster?: RosterEntry[];
    channels?: ChannelInfo[];
  } = {},
): Harness {
  const music = new FakeMusic();
  const logs: string[] = [];
  const pokes: { clientId: number; text: string }[] = [];
  const logRequests: ReadChannelLogParams[] = [];
  const sentTexts: { target: unknown; text: string }[] = [];
  const moderationCalls: { fn: string; args: unknown[] }[] = [];
  const parkings: { parked: boolean; reason: string }[] = [];
  const moves: string[] = [];
  let parked = false;
  const recordModeration =
    (fn: string) =>
    (...args: unknown[]) => {
      moderationCalls.push({ fn, args });
    };
  const deps: TeamSpeakToolDeps = {
    config: options.config,
    music: options.noMusic ? undefined : (options.music ?? music),
    roster: () => options.roster ?? ROSTER,
    channelName: () => options.channelName ?? "General Shit",
    poke: (clientId, text) => pokes.push({ clientId, text }),
    listChannels: async () => options.channels ?? [],
    moveToChannel: (channel) => moves.push(channel),
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
    sendText: (target, text) => sentTexts.push({ target, text }),
    kickClient: recordModeration("kickClient"),
    banClient: recordModeration("banClient"),
    banDel: recordModeration("banDel"),
    banList: recordModeration("banList"),
    moveClient: recordModeration("moveClient"),
    muteClient: recordModeration("muteClient"),
    editChannel: recordModeration("editChannel"),
    createChannel: recordModeration("createChannel"),
    deleteChannel: recordModeration("deleteChannel"),
    editServer: recordModeration("editServer"),
    addToServerGroup: recordModeration("addToServerGroup"),
  };
  const registration = createTeamSpeakToolRegistration(deps);
  return {
    deps,
    music,
    logs,
    pokes,
    logRequests,
    sentTexts,
    moderationCalls,
    moves,
    call: async (name, args) =>
      (await registration.handle(
        { itemId: "item-1", callId: `call-${name}`, name, args: args ?? {} },
        { clientId: 4, nickname: "Brandon" },
      )) as Record<string, unknown> & { ok: boolean },
  };
}

describe("tool definitions", () => {
  it("registers the v1 tools plus the music queue v2 and channel tools", () => {
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
      LIST_CHANNELS_TOOL,
      MOVE_TO_CHANNEL_TOOL,
      WHERE_IS_TOOL,
      SEND_TEXT_TOOL,
      SUMMON_BOT_TOOL,
      DISMISS_BOT_TOOL,
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
      LIST_CHANNELS_TOOL,
      MOVE_TO_CHANNEL_TOOL,
      WHERE_IS_TOOL,
      SEND_TEXT_TOOL,
      SUMMON_BOT_TOOL,
      DISMISS_BOT_TOOL,
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
    expect(names.slice(-6, -2)).toEqual([
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

describe("channel and presence tools (PHA-3784)", () => {
  const TREE: ChannelInfo[] = [
    {
      channelId: 1,
      name: "General Shit",
      occupants: [
        { clientId: 4, nickname: "Brandon", muted: false, away: false },
        { clientId: 11, nickname: "Sexton", muted: false, away: false },
      ],
    },
    {
      channelId: 2,
      name: "AFK",
      occupants: [{ clientId: 7, nickname: "[PHATT] Kai_", muted: true, away: false }],
    },
    { channelId: 3, name: "Empty Room", occupants: [] },
  ];

  it("list_channels reports every channel with its occupants' nicknames", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(LIST_CHANNELS_TOOL);

    expect(result).toMatchObject({ ok: true, count: 3 });
    expect(result.channels).toEqual([
      { channelId: 1, name: "General Shit", occupantCount: 2, occupants: ["Brandon", "Sexton"] },
      { channelId: 2, name: "AFK", occupantCount: 1, occupants: ["[PHATT] Kai_"] },
      { channelId: 3, name: "Empty Room", occupantCount: 0, occupants: [] },
    ]);
  });

  it("list_channels reports failure when the bridge does not answer", async () => {
    const harness = createHarness({ channels: [] });
    const result = await harness.call(LIST_CHANNELS_TOOL);
    expect(result.ok).toBe(false);
  });

  it("move_to_channel resolves a channel by name", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(MOVE_TO_CHANNEL_TOOL, { channel: "afk" });

    expect(result).toMatchObject({ ok: true, channel: "AFK", channelId: 2 });
    expect(harness.moves).toEqual(["2"]);
  });

  it("move_to_channel resolves a channel by numeric id", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(MOVE_TO_CHANNEL_TOOL, { channel: "3" });

    expect(result).toMatchObject({ ok: true, channel: "Empty Room", channelId: 3 });
    expect(harness.moves).toEqual(["3"]);
  });

  it("move_to_channel errors on a channel that does not exist", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(MOVE_TO_CHANNEL_TOOL, { channel: "Nowhere" });

    expect(result.ok).toBe(false);
    expect(harness.moves).toEqual([]);
  });

  it("move_to_channel follows a nickname into whatever channel they're in", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(MOVE_TO_CHANNEL_TOOL, { follow: "kai" });

    expect(result).toMatchObject({ ok: true, channel: "AFK", channelId: 2, following: "[PHATT] Kai_" });
    expect(harness.moves).toEqual(["2"]);
  });

  it("move_to_channel requires channel or follow", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(MOVE_TO_CHANNEL_TOOL, {});
    expect(result.ok).toBe(false);
    expect(harness.moves).toEqual([]);
  });

  it("where_is finds someone across the whole server, not just the bot's own channel", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(WHERE_IS_TOOL, { nickname: "kai" });

    expect(result).toMatchObject({ ok: true, nickname: "[PHATT] Kai_", channel: "AFK", channelId: 2 });
  });

  it("where_is says so when nobody matches", async () => {
    const harness = createHarness({ channels: TREE });
    const result = await harness.call(WHERE_IS_TOOL, { nickname: "Steve" });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/No one/u);
  });

  it("send_text defaults to the channel", async () => {
    const harness = createHarness();
    const result = await harness.call(SEND_TEXT_TOOL, { text: "back in five" });

    expect(result).toMatchObject({ ok: true, target: "channel" });
    expect(harness.sentTexts).toEqual([{ target: "channel", text: "back in five" }]);
  });

  it("send_text can target the server", async () => {
    const harness = createHarness();
    const result = await harness.call(SEND_TEXT_TOOL, { text: "brb", target: "server" });

    expect(result).toMatchObject({ ok: true, target: "server" });
    expect(harness.sentTexts).toEqual([{ target: "server", text: "brb" }]);
  });

  it("send_text resolves a client target by nickname", async () => {
    const harness = createHarness();
    const result = await harness.call(SEND_TEXT_TOOL, {
      text: "hey",
      target: "client",
      nickname: "kai",
    });

    expect(result).toMatchObject({ ok: true, target: "client", nickname: "[PHATT] Kai_" });
    expect(harness.sentTexts).toEqual([{ target: 7, text: "hey" }]);
  });

  it("send_text requires a nickname when targeting a client", async () => {
    const harness = createHarness();
    const result = await harness.call(SEND_TEXT_TOOL, { text: "hey", target: "client" });
    expect(result.ok).toBe(false);
    expect(harness.sentTexts).toEqual([]);
  });

  it("send_text requires text", async () => {
    const harness = createHarness();
    const result = await harness.call(SEND_TEXT_TOOL, {});
    expect(result.ok).toBe(false);
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

describe("moderation (PHA-3786)", () => {
  const AUTHORIZED_ROSTER: RosterEntry[] = [
    { clientId: 4, nickname: "Brandon", muted: false, away: false, serverGroups: ["Server Admin"] },
    { clientId: 7, nickname: "[PHATT] Kai_", muted: true, away: false, serverGroups: [] },
  ];

  it("does not register moderation tools without an allowGroups config (fail closed)", () => {
    const harness = createHarness({ config: { moderation: { kick: true, ban: true, edit: true } } });
    const registration = createTeamSpeakToolRegistration(harness.deps);
    expect(registration.tools.map((t) => t.name)).not.toContain(KICK_CLIENT_TOOL);
  });

  it("registers only the tool groups whose flag and allowGroups are both set", () => {
    const names = buildTeamSpeakTools({
      music: false,
      moderation: { kick: true, ban: false, edit: false },
    }).map((t) => t.name);
    expect(names).toContain(KICK_CLIENT_TOOL);
    expect(names).toContain(MOVE_CLIENT_TOOL);
    expect(names).not.toContain("ban_client");
    expect(names).not.toContain("edit_channel");
  });

  it("refuses a moderation call from someone not in allowGroups, without touching the bridge", async () => {
    const harness = createHarness({
      config: { moderation: { kick: true, allowGroups: ["Server Admin"] } },
      roster: [
        { clientId: 4, nickname: "Brandon", muted: false, away: false, serverGroups: [] },
        { clientId: 7, nickname: "[PHATT] Kai_", muted: true, away: false, serverGroups: [] },
      ],
    });
    const result = await harness.call(KICK_CLIENT_TOOL, { nickname: "Kai" });
    expect(result.ok).toBe(false);
    expect(harness.moderationCalls).toEqual([]);
    expect(harness.sentTexts).toEqual([]);
  });

  it("refuses every moderation tool when allowGroups is empty, even with the action flag on", async () => {
    const harness = createHarness({
      config: { moderation: { kick: true, allowGroups: [] } },
      roster: AUTHORIZED_ROSTER,
    });
    const result = await harness.call(KICK_CLIENT_TOOL, { nickname: "Kai" });
    expect(result.ok).toBe(false);
    expect(harness.moderationCalls).toEqual([]);
  });

  it("kicks, records the bridge call, and writes a channel audit line for an authorized caller", async () => {
    const harness = createHarness({
      config: { moderation: { kick: true, allowGroups: ["server admin"] } },
      roster: AUTHORIZED_ROSTER,
    });
    const result = await harness.call(KICK_CLIENT_TOOL, {
      nickname: "Kai",
      fromServer: true,
      reason: "spamming",
    });
    expect(result.ok).toBe(true);
    expect(harness.moderationCalls).toEqual([{ fn: "kickClient", args: [7, true, "spamming"] }]);
    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]?.target).toBe("channel");
    expect(harness.sentTexts[0]?.text).toMatch(/^\[moderation\] Brandon: kicked \[PHATT\] Kai_/u);
  });

  it("moves another client to a numeric channel id", async () => {
    const harness = createHarness({
      config: { moderation: { kick: true, allowGroups: ["Server Admin"] } },
      roster: AUTHORIZED_ROSTER,
    });
    const result = await harness.call(MOVE_CLIENT_TOOL, { nickname: "Kai", channelId: 12 });
    expect(result.ok).toBe(true);
    expect(harness.moderationCalls).toEqual([{ fn: "moveClient", args: [7, 12] }]);
  });

  it("rejects an ambiguous target the same way other tools do", async () => {
    const harness = createHarness({
      config: { moderation: { kick: true, allowGroups: ["Server Admin"] } },
      roster: [
        { clientId: 4, nickname: "Brandon", muted: false, away: false, serverGroups: ["Server Admin"] },
        { clientId: 7, nickname: "Kai", muted: false, away: false, serverGroups: [] },
        { clientId: 8, nickname: "Kaitlyn", muted: false, away: false, serverGroups: [] },
      ],
    });
    const result = await harness.call(KICK_CLIENT_TOOL, { nickname: "Ka" });
    expect(result.ok).toBe(false);
    expect(harness.moderationCalls).toEqual([]);
  });
});
