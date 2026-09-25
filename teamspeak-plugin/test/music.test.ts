/**
 * The music lane without yt-dlp, ffmpeg, or a bridge.
 *
 * yt-dlp is replaced by a recorded command result and ffmpeg by a fake child
 * whose stdout is fed by the test, so the assertions here are about the two
 * things this plugin actually owns: how the query reaches yt-dlp, and the
 * pacing that keeps ts-bridge's unbounded music queue from swallowing a whole
 * track (which would make `stop_music` a no-op for minutes).
 */
import { describe, expect, it } from "vitest";
import {
  MUSIC_FRAME_BYTES,
  MUSIC_FRAME_MS,
  MusicError,
  MusicPlayer,
  type MusicChildProcess,
  type MusicCommandResult,
} from "../src/tools/music.js";

class FakeStream {
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
  paused = false;

  on(event: string, listener: (...args: never[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...rest: unknown[]) => void)(...args);
    }
  }
}

class FakeFfmpeg implements MusicChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly signals: (string | undefined)[] = [];
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  constructor(readonly args: string[]) {}

  on(event: string, listener: (...args: never[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  kill(signal?: NodeJS.Signals): void {
    this.signals.push(signal);
  }

  /** Feed decoded PCM, in whole 20 ms frames unless `bytes` says otherwise. */
  emitFrames(count: number, byte = 1): void {
    this.stdout.emit("data", Buffer.alloc(count * MUSIC_FRAME_BYTES, byte));
  }

  emitBytes(bytes: number): void {
    this.stdout.emit("data", Buffer.alloc(bytes, 7));
  }

  end(code = 0): void {
    this.stdout.emit("end");
    for (const listener of this.listeners.get("exit") ?? []) {
      (listener as (...rest: unknown[]) => void)(code);
    }
  }
}

type Harness = {
  player: MusicPlayer;
  music: Buffer[];
  gains: number[];
  logs: string[];
  children: FakeFfmpeg[];
  ytdlpCalls: { command: string; args: string[] }[];
  tick(): void;
  advance(ms: number): void;
};

function createHarness(
  options: {
    resolve?: MusicCommandResult;
    defaultVolume?: number;
    prebufferMs?: number;
    cookiesFile?: string;
  } = {},
): Harness {
  const music: Buffer[] = [];
  const gains: number[] = [];
  const logs: string[] = [];
  const children: FakeFfmpeg[] = [];
  const ytdlpCalls: { command: string; args: string[] }[] = [];
  let clock = 1_000;
  const ticks: (() => void)[] = [];

  const player = new MusicPlayer({
    config: {
      ...(options.defaultVolume === undefined ? {} : { defaultVolume: options.defaultVolume }),
      ...(options.prebufferMs === undefined ? {} : { prebufferMs: options.prebufferMs }),
      ...(options.cookiesFile === undefined ? {} : { cookiesFile: options.cookiesFile }),
    },
    sink: {
      sendMusicAudio: (pcm) => music.push(pcm),
      setMusicGain: (gain) => gains.push(gain),
    },
    run: async (command, args) => {
      ytdlpCalls.push({ command, args });
      return (
        options.resolve ?? {
          code: 0,
          stdout: "Smooth Jazz Radio\thttps://cdn.example/audio.webm\n",
          stderr: "",
        }
      );
    },
    spawnProcess: (_command, args) => {
      const child = new FakeFfmpeg(args);
      children.push(child);
      return child;
    },
    now: () => clock,
    setIntervalFn: (handler) => {
      ticks.push(handler);
      return handler;
    },
    clearIntervalFn: (handle) => {
      const index = ticks.indexOf(handle as () => void);
      if (index >= 0) {
        ticks.splice(index, 1);
      }
    },
    log: (message) => logs.push(message),
  });

  return {
    player,
    music,
    gains,
    logs,
    children,
    ytdlpCalls,
    tick: () => {
      for (const handler of [...ticks]) {
        handler();
      }
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("MusicPlayer resolve", () => {
  it("searches with ytsearch1 and passes the query as a single argument", async () => {
    const harness = createHarness();
    const track = await harness.player.play({ query: "smooth jazz; rm -rf /" });

    expect(track.title).toBe("Smooth Jazz Radio");
    expect(track.streamUrl).toBe("https://cdn.example/audio.webm");
    const call = harness.ytdlpCalls[0];
    expect(call?.command).toBe("yt-dlp");
    expect(call?.args).toContain("ytsearch1:smooth jazz; rm -rf /");
    expect(call?.args.slice(0, 4)).toEqual(["-f", "bestaudio/best", "--no-playlist", "--no-warnings"]);
  });

  it("passes a URL through untouched and adds the cookies file when configured", async () => {
    const harness = createHarness({ cookiesFile: "/etc/sexton/cookies.txt" });
    await harness.player.play({ url: "https://youtube.com/watch?v=abc" });

    const args = harness.ytdlpCalls[0]?.args ?? [];
    expect(args).toContain("https://youtube.com/watch?v=abc");
    expect(args.join(" ")).toContain("--cookies /etc/sexton/cookies.txt");
    expect(args.some((arg) => arg.startsWith("ytsearch1:"))).toBe(false);
  });

  it("rejects a non-http URL rather than handing it to yt-dlp", async () => {
    const harness = createHarness();
    await expect(harness.player.play({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      MusicError,
    );
    expect(harness.ytdlpCalls).toHaveLength(0);
  });

  it("reports a failed search with yt-dlp's own last line", async () => {
    const harness = createHarness({
      resolve: { code: 1, stdout: "", stderr: "ERROR: no video results\n" },
    });
    await expect(harness.player.play({ query: "nothing at all" })).rejects.toThrow(
      /no video results/u,
    );
    expect(harness.player.isPlaying).toBe(false);
  });

  it("rejects output that carries no playable URL", async () => {
    const harness = createHarness({ resolve: { code: 0, stdout: "Title\tnot-a-url\n", stderr: "" } });
    await expect(harness.player.play({ query: "x" })).rejects.toThrow(/no playable stream/u);
  });

  it("asks for a query or a URL when given neither", async () => {
    const harness = createHarness();
    await expect(harness.player.play({})).rejects.toThrow(/search phrase or a URL/u);
  });
});

describe("MusicPlayer streaming", () => {
  it("decodes to the bridge's native format and paces frames against the clock", async () => {
    // prebuffer 40ms = 2 frames ahead of realtime.
    const harness = createHarness({ prebufferMs: 40 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];
    expect(child?.args.join(" ")).toContain("-vn -ac 1 -ar 48000 -f s16le pipe:1");

    child?.emitFrames(50);
    harness.tick();
    // At t=0 only the prebuffer is due.
    expect(harness.music).toHaveLength(2);
    expect(harness.music[0]?.length).toBe(MUSIC_FRAME_BYTES);

    harness.advance(10 * MUSIC_FRAME_MS);
    harness.tick();
    expect(harness.music).toHaveLength(12);

    // A tick that never fired does not lose audio: the next one catches up to
    // where the wall clock says we should be.
    harness.advance(20 * MUSIC_FRAME_MS);
    harness.tick();
    expect(harness.music).toHaveLength(32);
  });

  it("pauses ffmpeg's stdout when the buffer runs deep and resumes as it drains", async () => {
    const harness = createHarness({ prebufferMs: 40 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];

    child?.emitFrames(250); // 5 s buffered, over the 4 s high-water mark
    expect(child?.stdout.paused).toBe(true);

    harness.advance(220 * MUSIC_FRAME_MS);
    harness.tick();
    expect(child?.stdout.paused).toBe(false);
  });

  it("pads a final short chunk and finishes when ffmpeg exits", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];

    child?.emitFrames(1);
    child?.emitBytes(500);
    child?.end(0);
    harness.advance(5 * MUSIC_FRAME_MS);
    harness.tick();
    harness.tick();

    expect(harness.music).toHaveLength(2);
    expect(harness.music[1]?.length).toBe(MUSIC_FRAME_BYTES);
    expect(harness.player.isPlaying).toBe(false);
    expect(harness.logs.join("\n")).toContain('finished "Smooth Jazz Radio"');
  });

  it("stops on request: kills ffmpeg and stops feeding the lane", async () => {
    const harness = createHarness({ prebufferMs: 40 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];
    child?.emitFrames(100);
    harness.tick();
    const sentBeforeStop = harness.music.length;

    expect(harness.player.stop("stop_music")).toBe(true);
    expect(child?.signals).toEqual(["SIGKILL"]);
    expect(harness.player.isPlaying).toBe(false);

    harness.advance(500);
    harness.tick();
    expect(harness.music).toHaveLength(sentBeforeStop);
    expect(harness.player.stop("stop_music")).toBe(false);
  });

  it("replaces the current track rather than mixing two ffmpegs into one lane", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first" });
    await harness.player.play({ query: "second" });

    expect(harness.children).toHaveLength(2);
    expect(harness.children[0]?.signals).toEqual(["SIGKILL"]);
    expect(harness.player.nowPlaying?.request).toBe("second");
  });

  it("re-announces the lane gain on every track, so a previous set_volume(0) cannot mute it", async () => {
    const harness = createHarness({ defaultVolume: 0.6 });
    harness.player.setVolume(0);
    await harness.player.play({ query: "smooth jazz" });
    expect(harness.gains).toEqual([0, 0]);

    harness.player.setVolume(0.8);
    await harness.player.play({ query: "smooth jazz" });
    expect(harness.gains).toEqual([0, 0, 0.8, 0.8]);
  });

  it("clamps volume into 0..1", () => {
    const harness = createHarness();
    expect(harness.player.setVolume(4)).toBe(1);
    expect(harness.player.setVolume(-2)).toBe(0);
    expect(harness.player.setVolume(Number.NaN)).toBe(0.6);
  });

  it("closes: kills the stream and refuses to start another", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "smooth jazz" });
    harness.player.close();

    expect(harness.children[0]?.signals).toEqual(["SIGKILL"]);
    await expect(harness.player.play({ query: "again" })).rejects.toThrow(/shut down/u);
  });
});

describe("MusicPlayer queueing (PHA-3635)", () => {
  it("stacks an enqueued request behind what's already playing instead of interrupting it", async () => {
    const harness = createHarness();
    const first = await harness.player.play({ query: "first", enqueue: true });
    expect(first.queuedPosition).toBeUndefined();
    expect(harness.children).toHaveLength(1);

    const second = await harness.player.play({ query: "second", enqueue: true });
    expect(second.queuedPosition).toBe(1);
    expect(harness.player.queueLength).toBe(1);
    // No second ffmpeg spawned, and the first track keeps streaming.
    expect(harness.children).toHaveLength(1);
    expect(harness.player.nowPlaying?.request).toBe("first");

    const third = await harness.player.play({ query: "third", enqueue: true });
    expect(third.queuedPosition).toBe(2);
    expect(harness.player.queueLength).toBe(2);
  });

  it("an enqueued request starts immediately when nothing is playing", async () => {
    const harness = createHarness();
    const track = await harness.player.play({ query: "first", enqueue: true });
    expect(track.queuedPosition).toBeUndefined();
    expect(harness.player.isPlaying).toBe(true);
    expect(harness.player.queueLength).toBe(0);
  });

  it("advances to the next queued track on its own once the current one finishes", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    expect(harness.player.queueLength).toBe(1);

    const child = harness.children[0];
    child?.emitFrames(1);
    child?.end(0);
    harness.advance(5 * MUSIC_FRAME_MS);
    harness.tick();
    harness.tick();

    expect(harness.player.isPlaying).toBe(true);
    expect(harness.player.queueLength).toBe(0);
    expect(harness.player.nowPlaying?.request).toBe("second");
    expect(harness.children).toHaveLength(2);
    expect(harness.logs.join("\n")).toContain('advancing to queued "Smooth Jazz Radio"');
  });

  it("stop() clears the queue as well as the current track", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    expect(harness.player.queueLength).toBe(1);

    expect(harness.player.stop("stop_music")).toBe(true);
    expect(harness.player.queueLength).toBe(0);

    harness.advance(500);
    harness.tick();
    // Nothing advances from the cleared queue.
    expect(harness.player.isPlaying).toBe(false);
  });

  it("a plain (non-enqueue) play still interrupts immediately and drops anything queued", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    expect(harness.player.queueLength).toBe(1);

    await harness.player.play({ query: "interrupt" });
    expect(harness.children[0]?.signals).toEqual(["SIGKILL"]);
    expect(harness.player.queueLength).toBe(0);
    expect(harness.player.nowPlaying?.request).toBe("interrupt");
  });
});

describe("MusicPlayer files (PHA-3554)", () => {
  it("plays a local file without yt-dlp, without the reconnect flags, and holds the downbeat", async () => {
    const harness = createHarness({ prebufferMs: 40 });
    const track = await harness.player.play({
      file: "/songs/kais-truck.mp3",
      title: "Kai's Truck",
      startDelayMs: 100,
    });
    expect(harness.ytdlpCalls).toHaveLength(0);
    expect(track).toEqual({
      id: expect.any(String),
      title: "Kai's Truck",
      streamUrl: "/songs/kais-truck.mp3",
      request: "Kai's Truck",
      isFile: true,
    });
    const child = harness.children[0];
    expect(child?.args).not.toContain("-reconnect");
    expect(child?.args.join(" ")).toContain("-i /songs/kais-truck.mp3 -vn -ac 1 -ar 48000 -f s16le pipe:1");

    // Decoded audio is ready, but the start is 100ms in the future: nothing
    // leaves for the bridge until the clock gets there.
    child?.emitFrames(50);
    harness.tick();
    expect(harness.music).toHaveLength(0);
    harness.advance(60);
    harness.tick();
    expect(harness.music).toHaveLength(0);
    harness.advance(40);
    harness.tick();
    // At the downbeat only the prebuffer (2 frames) is due.
    expect(harness.music).toHaveLength(2);
    harness.advance(10 * MUSIC_FRAME_MS);
    harness.tick();
    expect(harness.music).toHaveLength(12);
    expect(harness.logs.some((line) => line.includes("startDelayMs=100") && line.includes("source=file"))).toBe(true);
  });

  it("names a file after its basename when no title is given", async () => {
    const harness = createHarness();
    const track = await harness.player.play({ file: "/songs/2026-09-17-tuesday-again.mp3" });
    expect(track.title).toBe("2026-09-17-tuesday-again");
  });
});

describe("MusicPlayer queue browsing (PHA-3785)", () => {
  it("show_queue reflects previously-added tracks in order", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true, requestedBy: "Brandon" });
    await harness.player.play({ query: "third", enqueue: true });

    const queue = harness.player.listQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0]?.request).toBe("second");
    expect(queue[0]?.requestedBy).toBe("Brandon");
    expect(queue[1]?.request).toBe("third");
  });

  it("skip advances to the next track without clearing the rest of the queue", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    await harness.player.play({ query: "third", enqueue: true });
    expect(harness.player.queueLength).toBe(2);

    const next = harness.player.skip();
    expect(next?.request).toBe("second");
    expect(harness.player.nowPlaying?.request).toBe("second");
    // "third" is still queued — skip must not have cleared it.
    expect(harness.player.queueLength).toBe(1);
    expect(harness.player.listQueue()[0]?.request).toBe("third");
    expect(harness.children[0]?.signals).toEqual(["SIGKILL"]);
  });

  it("skip with nothing queued behaves like stop: nothing left playing", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first" });
    const next = harness.player.skip();
    expect(next).toBeUndefined();
    expect(harness.player.isPlaying).toBe(false);
  });

  it("skip on an idle player is a no-op", () => {
    const harness = createHarness();
    expect(harness.player.skip()).toBeUndefined();
  });

  it("remove_from_queue removes only the targeted entry", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    const second = await harness.player.play({ query: "second", enqueue: true });
    await harness.player.play({ query: "third", enqueue: true });

    const removed = harness.player.removeFromQueue(second.id);
    expect(removed?.request).toBe("second");
    const remaining = harness.player.listQueue().map((track) => track.request);
    expect(remaining).toEqual(["third"]);
  });

  it("remove_from_queue returns undefined for an unknown id", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    expect(harness.player.removeFromQueue("not-a-real-id")).toBeUndefined();
    expect(harness.player.queueLength).toBe(1);
  });

  it("move_in_queue reorders a track to a new position", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    const second = await harness.player.play({ query: "second", enqueue: true });
    await harness.player.play({ query: "third", enqueue: true });

    const reordered = harness.player.moveInQueue(second.id, 2);
    expect(reordered.map((track) => track.request)).toEqual(["third", "second"]);
  });

  it("move_in_queue throws for an unknown id", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    expect(() => harness.player.moveInQueue("nope", 1)).toThrow(MusicError);
  });

  it("clear_queue empties the queue without touching what's playing", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "first", enqueue: true });
    await harness.player.play({ query: "second", enqueue: true });
    await harness.player.play({ query: "third", enqueue: true });
    expect(harness.player.queueLength).toBe(2);

    const cleared = harness.player.clearQueue();
    expect(cleared).toBe(2);
    expect(harness.player.queueLength).toBe(0);
    // Still playing "first" — clear_queue is not stop_music.
    expect(harness.player.isPlaying).toBe(true);
    expect(harness.player.nowPlaying?.request).toBe("first");
    expect(harness.children[0]?.signals).toEqual([]);
  });

  it("now_playing (nowPlayingInfo) reports elapsed time and pause state", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "smooth jazz", requestedBy: "Brandon" });
    const child = harness.children[0];
    child?.emitFrames(50);
    harness.tick();

    const info = harness.player.nowPlayingInfo();
    expect(info?.track.requestedBy).toBe("Brandon");
    expect(info?.paused).toBe(false);
    expect(info?.elapsedMs).toBeGreaterThan(0);
  });

  it("now_playing reports undefined when nothing is loaded", () => {
    const harness = createHarness();
    expect(harness.player.nowPlayingInfo()).toBeUndefined();
  });
});

describe("MusicPlayer search (PHA-3785)", () => {
  it("search_music returns candidates without auto-playing anything", async () => {
    const harness = createHarness({
      resolve: {
        code: 0,
        stdout: [
          "Song One\tabc123\t210\tChannel A\thttps://youtube.com/watch?v=abc123",
          "Song Two\tdef456\t180\tChannel B\thttps://youtube.com/watch?v=def456",
        ].join("\n"),
        stderr: "",
      },
    });

    const candidates = await harness.player.search("smooth jazz", 2);
    expect(candidates).toEqual([
      { title: "Song One", id: "abc123", url: "https://youtube.com/watch?v=abc123", durationSeconds: 210, channel: "Channel A" },
      { title: "Song Two", id: "def456", url: "https://youtube.com/watch?v=def456", durationSeconds: 180, channel: "Channel B" },
    ]);
    // No ffmpeg spawned and nothing playing: search never plays.
    expect(harness.children).toHaveLength(0);
    expect(harness.player.isPlaying).toBe(false);
    const call = harness.ytdlpCalls[0];
    expect(call?.args).toContain("ytsearch2:smooth jazz");
    expect(call?.args).toContain("--flat-playlist");
  });

  it("search_music rejects an empty query", async () => {
    const harness = createHarness();
    await expect(harness.player.search("   ", 5)).rejects.toBeInstanceOf(MusicError);
    expect(harness.ytdlpCalls).toHaveLength(0);
  });

  it("search_music surfaces a yt-dlp failure", async () => {
    const harness = createHarness({ resolve: { code: 1, stdout: "", stderr: "ERROR: blocked\n" } });
    await expect(harness.player.search("x", 5)).rejects.toThrow(/blocked/u);
  });
});

describe("MusicPlayer playSource (PHA-3785)", () => {
  it("dispatches youtube by query through the normal search path", async () => {
    const harness = createHarness();
    const track = await harness.player.playSource({ source: "youtube", query: "smooth jazz" });
    expect(track.title).toBe("Smooth Jazz Radio");
    expect(harness.ytdlpCalls[0]?.args).toContain("ytsearch1:smooth jazz");
  });

  it("dispatches soundcloud by query through scsearch1", async () => {
    const harness = createHarness();
    await harness.player.playSource({ source: "soundcloud", query: "lofi beats" });
    expect(harness.ytdlpCalls[0]?.args).toContain("scsearch1:lofi beats");
  });

  it("dispatches soundcloud by url directly", async () => {
    const harness = createHarness();
    await harness.player.playSource({ source: "soundcloud", url: "https://soundcloud.com/x/y" });
    expect(harness.ytdlpCalls[0]?.args).toContain("https://soundcloud.com/x/y");
  });

  it("bandcamp requires a direct URL and refuses a bare query", async () => {
    const harness = createHarness();
    await expect(harness.player.playSource({ source: "bandcamp", query: "some album" })).rejects.toThrow(
      /direct URL/u,
    );
    expect(harness.ytdlpCalls).toHaveLength(0);
  });

  it("bandcamp plays through when given a direct URL", async () => {
    const harness = createHarness();
    await harness.player.playSource({ source: "bandcamp", url: "https://band.bandcamp.com/track/x" });
    expect(harness.ytdlpCalls[0]?.args).toContain("https://band.bandcamp.com/track/x");
  });

  it("direct-url requires a URL", async () => {
    const harness = createHarness();
    await expect(harness.player.playSource({ source: "direct-url" })).rejects.toBeInstanceOf(MusicError);
  });

  it("local dispatches to the file path, skipping yt-dlp", async () => {
    const harness = createHarness();
    const track = await harness.player.playSource({ source: "local", file: "/songs/x.mp3" });
    expect(track.isFile).toBe(true);
    expect(harness.ytdlpCalls).toHaveLength(0);
  });

  it("local without a file path fails clearly", async () => {
    const harness = createHarness();
    await expect(harness.player.playSource({ source: "local" })).rejects.toBeInstanceOf(MusicError);
  });

  it("band-library fails gracefully: no backing catalog, no fabricated data", async () => {
    const harness = createHarness();
    await expect(harness.player.playSource({ source: "band-library" })).rejects.toThrow(
      /not available/u,
    );
    expect(harness.ytdlpCalls).toHaveLength(0);
    expect(harness.player.isPlaying).toBe(false);
  });
});

describe("MusicPlayer transport: pause/resume/seek (PHA-3785)", () => {
  it("pause freezes pacing without killing ffmpeg", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];
    child?.emitFrames(50);
    harness.tick();
    const sentBeforePause = harness.music.length;

    expect(harness.player.pause()).toBe(true);
    expect(harness.player.paused).toBe(true);
    harness.advance(10 * MUSIC_FRAME_MS);
    harness.tick();
    // No new frames while paused, and ffmpeg is still alive (never killed).
    expect(harness.music).toHaveLength(sentBeforePause);
    expect(child?.signals).toEqual([]);
  });

  it("pause on an already-paused or idle player returns false", async () => {
    const harness = createHarness();
    expect(harness.player.pause()).toBe(false);
    await harness.player.play({ query: "smooth jazz" });
    expect(harness.player.pause()).toBe(true);
    expect(harness.player.pause()).toBe(false);
  });

  it("resume continues pacing from where it paused, not from the start", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "smooth jazz" });
    const child = harness.children[0];
    child?.emitFrames(200);
    harness.tick();
    const sentBeforePause = harness.music.length;

    harness.player.pause();
    harness.advance(500); // time passes while paused; must not count toward pacing
    harness.tick();
    expect(harness.music).toHaveLength(sentBeforePause);

    expect(harness.player.resume()).toBe(true);
    expect(harness.player.paused).toBe(false);
    harness.advance(5 * MUSIC_FRAME_MS);
    harness.tick();
    expect(harness.music.length).toBeGreaterThan(sentBeforePause);
  });

  it("resume with nothing paused returns false", () => {
    const harness = createHarness();
    expect(harness.player.resume()).toBe(false);
  });

  it("seek restarts ffmpeg with -ss and seeds pacing at the offset", async () => {
    const harness = createHarness({ prebufferMs: 20 });
    await harness.player.play({ query: "smooth jazz" });
    const firstChild = harness.children[0];

    const track = await harness.player.seek(90);
    expect(track.title).toBe("Smooth Jazz Radio");
    expect(firstChild?.signals).toEqual(["SIGKILL"]);
    expect(harness.children).toHaveLength(2);
    const secondChild = harness.children[1];
    expect(secondChild?.args).toContain("-ss");
    expect(secondChild?.args).toContain("90");

    const info = harness.player.nowPlayingInfo();
    expect(info?.elapsedMs).toBeGreaterThanOrEqual(90_000);
  });

  it("seek with nothing playing fails clearly", async () => {
    const harness = createHarness();
    await expect(harness.player.seek(10)).rejects.toThrow(/Nothing is playing/u);
  });

  it("seek rejects a negative timestamp", async () => {
    const harness = createHarness();
    await harness.player.play({ query: "smooth jazz" });
    await expect(harness.player.seek(-5)).rejects.toBeInstanceOf(MusicError);
  });
});
