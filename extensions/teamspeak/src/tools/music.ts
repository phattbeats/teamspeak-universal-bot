/**
 * The music lane: yt-dlp -> ffmpeg -> the bridge's `music_audio` frames.
 *
 * This is TS3AudioBot's pipeline (PHA-3099 finding 8), which is the one proven
 * against a TeamSpeak server, with the Opus encode left to the bridge:
 *
 *   yt-dlp -f bestaudio/best --no-playlist   -> direct stream URL + title
 *   ffmpeg -i <url> -vn -ac 1 -ar 48000 -f s16le pipe:1
 *   -> 20 ms / 960-sample frames -> bridge `music_audio` (0x82)
 *
 * Two properties are load-bearing:
 *
 *  - **We pace, the bridge does not.** ts-bridge's music queue is an unbounded
 *    VecDeque with no drop path, so writing as fast as ffmpeg decodes would
 *    park a whole track in the bridge's memory and make `stop_music` a no-op
 *    for minutes. Frames leave here on a wall-clock schedule with a small
 *    prebuffer, and that prebuffer is exactly the worst-case stop latency.
 *  - **No shell.** The query reaches yt-dlp as one argv element; nothing is
 *    interpolated into a command line.
 *
 * Ducking is not implemented here: the bridge drops the music lane to
 * `duckGain` on its own whenever voice is queued or a human is speaking.
 */
import { execFile, spawn } from "node:child_process";
import {
  DEFAULT_MUSIC_PREBUFFER_MS,
  DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS,
  DEFAULT_MUSIC_VOLUME,
  type TeamSpeakMusicConfig,
} from "../config.js";

/** 20 ms of 48 kHz mono PCM16 — the bridge's native frame. */
export const MUSIC_FRAME_SAMPLES = 960;
export const MUSIC_FRAME_BYTES = MUSIC_FRAME_SAMPLES * 2;
export const MUSIC_FRAME_MS = 20;

/** Stop reading from ffmpeg above this much buffered audio, resume below it. */
const HIGH_WATER_MS = 4_000;
const LOW_WATER_MS = 1_000;
const STDERR_KEEP_BYTES = 2_000;

export type MusicSink = {
  sendMusicAudio(pcm48kMono: Buffer): void;
  setMusicGain(gain: number): void;
};

export type MusicTrack = {
  title: string;
  /** The resolved direct stream URL handed to ffmpeg. */
  streamUrl: string;
  /** What the caller asked for, for logging and the spoken confirmation. */
  request: string;
};

/** The surface the tool registry needs; a fake stands in for it in tests. */
export type MusicController = {
  readonly isPlaying: boolean;
  readonly nowPlaying: MusicTrack | undefined;
  readonly volume: number;
  play(request: { query?: string; url?: string }): Promise<MusicTrack>;
  stop(reason: string): boolean;
  setVolume(volume: number): number;
  close(): void;
};

export type MusicCommandResult = { code: number | null; stdout: string; stderr: string };

/** Seam for the one-shot yt-dlp resolve. */
export type MusicCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<MusicCommandResult>;

type MusicChildStream = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  pause(): void;
  resume(): void;
};

export type MusicChildProcess = {
  stdout: MusicChildStream | null;
  stderr: MusicChildStream | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): void;
};

/** Seam for the long-running ffmpeg decode. */
export type MusicSpawn = (command: string, args: string[]) => MusicChildProcess;

export type MusicPlayerParams = {
  config: TeamSpeakMusicConfig | undefined;
  sink: MusicSink;
  run?: MusicCommandRunner | undefined;
  spawnProcess?: MusicSpawn | undefined;
  now?: (() => number) | undefined;
  setIntervalFn?: ((handler: () => void, ms: number) => unknown) | undefined;
  clearIntervalFn?: ((handle: unknown) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

export class MusicError extends Error {}

const defaultRun: MusicCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? null
              : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

const defaultSpawn: MusicSpawn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

type ActiveStream = {
  child: MusicChildProcess;
  track: MusicTrack;
  startedAt: number;
  framesSent: number;
  pending: Buffer;
  ended: boolean;
  paused: boolean;
  stderrTail: string;
  timer: unknown;
};

export class MusicPlayer implements MusicController {
  private stream: ActiveStream | undefined;
  private gain: number;
  private closed = false;
  private readonly run: MusicCommandRunner;
  private readonly spawnProcess: MusicSpawn;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly params: MusicPlayerParams) {
    this.run = params.run ?? defaultRun;
    this.spawnProcess = params.spawnProcess ?? defaultSpawn;
    this.now = params.now ?? (() => Date.now());
    this.setIntervalFn = params.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = params.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
    this.gain = clampGain(params.config?.defaultVolume ?? DEFAULT_MUSIC_VOLUME);
  }

  get isPlaying(): boolean {
    return this.stream !== undefined;
  }

  get nowPlaying(): MusicTrack | undefined {
    return this.stream?.track;
  }

  get volume(): number {
    return this.gain;
  }

  /** Milliseconds of decoded audio waiting to be paced out. Test/diagnostic. */
  get bufferedMs(): number {
    return this.stream ? Math.floor((this.stream.pending.length / MUSIC_FRAME_BYTES) * MUSIC_FRAME_MS) : 0;
  }

  async play(request: { query?: string; url?: string }): Promise<MusicTrack> {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    const target = resolveTarget(request);
    const track = await this.resolve(target);
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    // A new track replaces the old one; two ffmpeg processes on one lane would
    // be summed into noise by the mixer.
    this.stop("replaced");
    this.startStream(track);
    return track;
  }

  stop(reason: string): boolean {
    const stream = this.stream;
    if (!stream) {
      return false;
    }
    this.stream = undefined;
    this.clearIntervalFn(stream.timer);
    try {
      stream.child.kill("SIGKILL");
    } catch (error) {
      this.params.log?.(`teamspeak music: killing ffmpeg failed: ${describe(error)}`);
    }
    this.params.log?.(
      `teamspeak music: stopped reason=${reason} track="${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS}`,
    );
    return true;
  }

  setVolume(volume: number): number {
    this.gain = clampGain(volume);
    this.params.sink.setMusicGain(this.gain);
    this.params.log?.(`teamspeak music: volume=${this.gain}`);
    return this.gain;
  }

  close(): void {
    this.closed = true;
    this.stop("close");
  }

  // --- resolve --------------------------------------------------------------

  private async resolve(target: { arg: string; request: string }): Promise<MusicTrack> {
    const config = this.params.config;
    const args = [
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      // One line, tab-separated, so a title containing anything at all cannot
      // be confused for the URL line the way `-g -e` output can.
      "--print",
      "%(title)s\t%(urls)s",
      ...(config?.cookiesFile ? ["--cookies", config.cookiesFile] : []),
      ...(config?.ytdlpArgs ?? []),
      target.arg,
    ];
    const ytdlp = config?.ytdlpPath ?? "yt-dlp";
    const started = this.now();
    const result = await this.run(ytdlp, args, {
      timeoutMs: config?.resolveTimeoutMs ?? DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS,
    });
    const elapsed = this.now() - started;
    if (result.code !== 0) {
      this.params.log?.(
        `teamspeak music: yt-dlp failed code=${result.code} in ${elapsed}ms: ${lastLine(result.stderr)}`,
      );
      throw new MusicError(
        `Could not find anything for "${target.request}"${result.stderr.trim() ? `: ${lastLine(result.stderr)}` : "."}`,
      );
    }
    const parsed = parseResolveOutput(result.stdout);
    if (!parsed) {
      throw new MusicError(`yt-dlp returned no playable stream for "${target.request}".`);
    }
    this.params.log?.(
      `teamspeak music: resolved "${parsed.title}" in ${elapsed}ms request="${target.request}"`,
    );
    return { ...parsed, request: target.request };
  }

  // --- streaming ------------------------------------------------------------

  private startStream(track: MusicTrack): void {
    const config = this.params.config;
    const args = [
      "-nostdin",
      "-loglevel",
      "error",
      // The resolved URL is a signed CDN link; reconnect so a mid-track TCP
      // reset does not end the song.
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      track.streamUrl,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "s16le",
      "pipe:1",
    ];
    const child = this.spawnProcess(config?.ffmpegPath ?? "ffmpeg", args);
    const stream: ActiveStream = {
      child,
      track,
      startedAt: this.now(),
      framesSent: 0,
      pending: Buffer.alloc(0),
      ended: false,
      paused: false,
      stderrTail: "",
      timer: undefined,
    };
    this.stream = stream;

    child.stdout?.on("data", ((chunk: Buffer) => {
      if (this.stream !== stream) {
        return;
      }
      stream.pending = Buffer.concat([stream.pending, chunk]);
      this.applyBackpressure(stream);
    }) as (...args: never[]) => void);
    child.stdout?.on("end", (() => {
      stream.ended = true;
    }) as (...args: never[]) => void);
    child.stderr?.on("data", ((chunk: Buffer) => {
      stream.stderrTail = `${stream.stderrTail}${String(chunk)}`.slice(-STDERR_KEEP_BYTES);
    }) as (...args: never[]) => void);
    child.on("error", ((error: Error) => {
      this.params.log?.(`teamspeak music: ffmpeg error: ${describe(error)}`);
      stream.ended = true;
    }) as (...args: never[]) => void);
    child.on("exit", ((code: number | null) => {
      stream.ended = true;
      if (code !== 0 && code !== null && stream.stderrTail.trim()) {
        this.params.log?.(
          `teamspeak music: ffmpeg exited code=${code}: ${lastLine(stream.stderrTail)}`,
        );
      }
    }) as (...args: never[]) => void);

    // Announce the lane gain on every track: the bridge keeps whatever gain it
    // was last told, including one a previous `set_volume` left at 0.
    this.params.sink.setMusicGain(this.gain);
    stream.timer = this.setIntervalFn(() => this.pump(stream), MUSIC_FRAME_MS);
    this.params.log?.(
      `teamspeak music: playing "${track.title}" request="${track.request}" volume=${this.gain}`,
    );
  }

  /**
   * Hand the bridge every frame that is due by wall clock, plus the prebuffer.
   * Falling behind (a slow tick, a stalled decode) is caught up here rather
   * than accumulating, because `framesSent` is compared against elapsed time
   * and not against the previous tick.
   */
  private pump(stream: ActiveStream): void {
    if (this.stream !== stream) {
      return;
    }
    const prebufferFrames = Math.max(
      1,
      Math.round((this.params.config?.prebufferMs ?? DEFAULT_MUSIC_PREBUFFER_MS) / MUSIC_FRAME_MS),
    );
    const due = Math.floor((this.now() - stream.startedAt) / MUSIC_FRAME_MS) + prebufferFrames;
    while (stream.framesSent < due && stream.pending.length >= MUSIC_FRAME_BYTES) {
      const frame = stream.pending.subarray(0, MUSIC_FRAME_BYTES);
      stream.pending = stream.pending.subarray(MUSIC_FRAME_BYTES);
      stream.framesSent += 1;
      this.params.sink.sendMusicAudio(Buffer.from(frame));
    }
    this.applyBackpressure(stream);
    if (!stream.ended) {
      return;
    }
    if (stream.pending.length >= MUSIC_FRAME_BYTES) {
      // Decoded audio still owed to the clock; the next tick will send it.
      return;
    }
    if (stream.pending.length > 0) {
      // Tail shorter than a frame: pad to the frame boundary so the bridge's
      // mixer never sees a half sample.
      const padded = Buffer.alloc(MUSIC_FRAME_BYTES);
      stream.pending.copy(padded);
      stream.pending = Buffer.alloc(0);
      stream.framesSent += 1;
      this.params.sink.sendMusicAudio(padded);
      return;
    }
    this.finish(stream);
  }

  private finish(stream: ActiveStream): void {
    if (this.stream !== stream) {
      return;
    }
    this.stream = undefined;
    this.clearIntervalFn(stream.timer);
    this.params.log?.(
      `teamspeak music: finished "${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS}`,
    );
  }

  private applyBackpressure(stream: ActiveStream): void {
    const bufferedMs = (stream.pending.length / MUSIC_FRAME_BYTES) * MUSIC_FRAME_MS;
    if (!stream.paused && bufferedMs >= HIGH_WATER_MS) {
      stream.paused = true;
      stream.child.stdout?.pause();
      return;
    }
    if (stream.paused && bufferedMs <= LOW_WATER_MS) {
      stream.paused = false;
      stream.child.stdout?.resume();
    }
  }
}

function resolveTarget(request: { query?: string; url?: string }): { arg: string; request: string } {
  const url = request.url?.trim();
  if (url) {
    if (!/^https?:\/\//iu.test(url)) {
      throw new MusicError("Only http(s) URLs can be played.");
    }
    return { arg: url, request: url };
  }
  const query = request.query?.trim();
  if (!query) {
    throw new MusicError("Say what to play: a search phrase or a URL.");
  }
  // `ytsearch1:` is a yt-dlp search target, not a shell string; the query is
  // passed as a single argv element and needs no escaping.
  return { arg: `ytsearch1:${query}`, request: query };
}

function parseResolveOutput(stdout: string): { title: string; streamUrl: string } | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const tab = trimmed.indexOf("\t");
    const title = tab >= 0 ? trimmed.slice(0, tab).trim() : "";
    const streamUrl = tab >= 0 ? trimmed.slice(tab + 1).trim() : trimmed;
    if (!/^https?:\/\//iu.test(streamUrl)) {
      continue;
    }
    return { title: title || "something", streamUrl };
  }
  return undefined;
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MUSIC_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
