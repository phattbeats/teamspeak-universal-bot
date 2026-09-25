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
 *
 * Song-request queueing (PHA-3635) lives here too, one level up from the
 * bridge's frame queue above: `play({ enqueue: true })` stacks a track behind
 * whatever is playing instead of replacing it, and the next one starts itself
 * when the current track's ffmpeg drains. A plain `play()` (no `enqueue`,
 * e.g. the band leader taking the stage) still interrupts immediately and
 * drops anything queued — that is a deliberate restart, not a skip.
 *
 * Queue browsing and transport (PHA-3785) extend the same `queue` array and
 * the same `ActiveStream`, rather than standing up a second queue:
 *
 *  - **`skip` is not `stop`.** `stop()` (the `stop_music` tool) clears the
 *    queue on purpose — it means "get out". `skip()` tears down only the
 *    current ffmpeg and, if something is queued, starts it; the rest of the
 *    queue is untouched. `clear_queue` is the third, orthogonal op: empty the
 *    queue, leave whatever is currently playing alone.
 *  - **`search_music` never plays anything.** It is a read-only yt-dlp
 *    `ytsearchN:` lookup that returns candidates (title/id/duration/channel)
 *    for the caller to choose from. Search results are a structured batch
 *    returned in one tool result — never narrated into the channel as
 *    separate chat lines or spoken one at a time, which would spam a voice
 *    channel with five lines when one list suffices. Likewise `show_queue`
 *    is read-only and returns the whole queue as one structured list.
 *  - **`pause`/`resume` freeze the wall clock, not the process.** ffmpeg
 *    keeps decoding into the OS pipe (bounded by the existing backpressure
 *    high-water mark) while paused; `pump()` just stops pacing frames out and
 *    `resume()` shifts `startedAt` forward by however long the pause lasted,
 *    so playback resumes exactly where it left off with no `-ss` reseek.
 *  - **`seek` does reseek.** There is no way to seek inside an already-piped
 *    ffmpeg decode, so `seek()` kills the current ffmpeg and restarts one
 *    with `-ss <seconds>` (input-side, fast) against the same resolved
 *    `streamUrl`, seeding `framesSent` at the target offset so elapsed time
 *    and pacing both read correctly from the new segment's first tick.
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
  /** Stable id for this resolved track — used by `remove_from_queue`/`move_in_queue`. */
  id: string;
  title: string;
  /** The resolved direct stream URL handed to ffmpeg — or a local path for a file. */
  streamUrl: string;
  /** What the caller asked for, for logging and the spoken confirmation. */
  request: string;
  /** A file on disk (the band's output) rather than a resolved stream. */
  isFile?: boolean;
  /** Who asked for it, for `now_playing`/`show_queue`. Not always known. */
  requestedBy?: string;
  /**
   * Set when this `play()` call queued behind what was already playing
   * instead of starting it. 1-based position in the queue.
   */
  queuedPosition?: number;
};

/** One yt-dlp search hit, for `search_music`. Never played automatically. */
export type MusicSearchCandidate = {
  title: string;
  /** yt-dlp video id (not a full URL — `play_source` resolves it like a search). */
  id: string;
  url: string;
  /** Seconds, when yt-dlp reports one. */
  durationSeconds?: number;
  channel?: string;
};

export type MusicSourceKind =
  | "youtube"
  | "soundcloud"
  | "bandcamp"
  | "direct-url"
  | "local"
  | "band-library";

export type MusicPlaySourceRequest = {
  source: MusicSourceKind;
  query?: string;
  url?: string;
  file?: string;
  title?: string;
  requestedBy?: string;
  enqueue?: boolean;
};

export type MusicNowPlaying = {
  track: MusicTrack;
  elapsedMs: number;
  paused: boolean;
};

export type MusicPlayRequest = {
  query?: string;
  url?: string;
  /**
   * A local audio file (PHA-3554: the house band's generated track). Skips
   * yt-dlp entirely; ffmpeg reads the path.
   */
  file?: string;
  /** Title to log and report for a file, which has no yt-dlp to name it. */
  title?: string;
  /**
   * Hold the first frame back this long. The band leader announces the song
   * over the voice lane first, and the downbeat should land after the line,
   * not under it.
   */
  startDelayMs?: number;
  /**
   * Stack behind whatever is already playing instead of replacing it
   * (PHA-3635). Ignored when nothing is playing and the queue is empty —
   * the request just starts. A caller that wants the old interrupt
   * behaviour (the band leader taking the stage) simply omits this.
   */
  enqueue?: boolean;
  /** Who asked, for `now_playing`/`show_queue`. */
  requestedBy?: string;
};

/** The surface the tool registry needs; a fake stands in for it in tests. */
export type MusicController = {
  readonly isPlaying: boolean;
  readonly nowPlaying: MusicTrack | undefined;
  /** Tracks stacked up behind `nowPlaying`, waiting their turn. */
  readonly queueLength: number;
  readonly volume: number;
  readonly paused: boolean;
  play(request: MusicPlayRequest): Promise<MusicTrack>;
  /** Explicit-source play (PHA-3785): youtube/soundcloud/bandcamp/direct-url/local/band-library. */
  playSource(request: MusicPlaySourceRequest): Promise<MusicTrack>;
  stop(reason: string): boolean;
  setVolume(volume: number): number;
  close(): void;
  /** `now_playing`: current track plus elapsed time and pause state. Undefined if nothing loaded. */
  nowPlayingInfo(): MusicNowPlaying | undefined;
  /** `show_queue`: the queue, in order, read-only. */
  listQueue(): MusicTrack[];
  /** Advance to the next queued track without clearing the rest of the queue. */
  skip(): MusicTrack | undefined;
  /** Remove one entry from the queue by id. Returns it, or undefined if not found. */
  removeFromQueue(id: string): MusicTrack | undefined;
  /** Move a queued entry to a new 1-based position. Returns the reordered queue. */
  moveInQueue(id: string, toPosition: number): MusicTrack[];
  /** Empty the queue; the currently playing track is untouched. Returns how many were cleared. */
  clearQueue(): number;
  /** Read-only yt-dlp search; never plays anything. */
  search(query: string, limit: number): Promise<MusicSearchCandidate[]>;
  /** Pause playback in place. Returns false if nothing is playing or already paused. */
  pause(): boolean;
  /** Resume a paused track. Returns false if nothing is paused. */
  resume(): boolean;
  /** Reseek the current track to an absolute offset in seconds. */
  seek(seconds: number): Promise<MusicTrack>;
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
  /** `framesSent` at the start of this segment — nonzero after a `seek()` restart. */
  startFrames: number;
  framesSent: number;
  pending: Buffer;
  ended: boolean;
  /** ffmpeg stdout backpressure-paused (high/low water mark). Independent of `userPaused`. */
  backpressured: boolean;
  /** `pause()`/`resume()` tool state — freezes pacing without killing ffmpeg. */
  userPaused: boolean;
  /** Wall clock when `userPaused` became true; used to shift `startedAt` on resume. */
  pausedAt: number | undefined;
  stderrTail: string;
  timer: unknown;
};

export class MusicPlayer implements MusicController {
  private stream: ActiveStream | undefined;
  /** Resolved tracks waiting their turn (PHA-3635); consumed on natural finish. */
  private queue: MusicTrack[] = [];
  private gain: number;
  private closed = false;
  private readonly run: MusicCommandRunner;
  private readonly spawnProcess: MusicSpawn;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private nextTrackId = 1;

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

  get queueLength(): number {
    return this.queue.length;
  }

  get volume(): number {
    return this.gain;
  }

  get paused(): boolean {
    return this.stream?.userPaused ?? false;
  }

  /** Milliseconds of decoded audio waiting to be paced out. Test/diagnostic. */
  get bufferedMs(): number {
    return this.stream ? Math.floor((this.stream.pending.length / MUSIC_FRAME_BYTES) * MUSIC_FRAME_MS) : 0;
  }

  async play(request: MusicPlayRequest): Promise<MusicTrack> {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    const file = request.file?.trim();
    const track: MusicTrack = file
      ? {
          id: this.newTrackId(),
          title: request.title?.trim() || basenameOf(file),
          streamUrl: file,
          request: request.title?.trim() || file,
          isFile: true,
          ...(request.requestedBy ? { requestedBy: request.requestedBy } : {}),
        }
      : await this.resolve(resolveTarget(request), request.requestedBy);
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    if (request.enqueue && (this.stream !== undefined || this.queue.length > 0)) {
      this.queue.push(track);
      this.params.log?.(
        `teamspeak music: queued "${track.title}" request="${track.request}" position=${this.queue.length}`,
      );
      return { ...track, queuedPosition: this.queue.length };
    }
    // A new track replaces the old one; two ffmpeg processes on one lane would
    // be summed into noise by the mixer. This also drops anything queued: an
    // interrupt is a deliberate "start over", not a skip.
    this.stop("replaced");
    this.startStream(track, Math.max(0, request.startDelayMs ?? 0));
    return track;
  }

  /** Explicit-source play (PHA-3785). Delegates to `play()` once the target is resolved per source. */
  async playSource(request: MusicPlaySourceRequest): Promise<MusicTrack> {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    const common = {
      ...(request.enqueue === undefined ? {} : { enqueue: request.enqueue }),
      ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
    };
    switch (request.source) {
      case "local": {
        const file = request.file?.trim();
        if (!file) {
          throw new MusicError("A local source needs a file path.");
        }
        return this.play({
          file,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...common,
        });
      }
      case "direct-url": {
        const url = request.url?.trim();
        if (!url) {
          throw new MusicError("A direct-url source needs a URL.");
        }
        return this.play({ url, ...common });
      }
      case "youtube": {
        const url = request.url?.trim();
        if (url) {
          return this.play({ url, ...common });
        }
        const query = request.query?.trim();
        if (!query) {
          throw new MusicError("Say what to play: a search phrase or a URL.");
        }
        return this.play({ query, ...common });
      }
      case "soundcloud": {
        const url = request.url?.trim();
        if (url) {
          return this.play({ url, ...common });
        }
        const query = request.query?.trim();
        if (!query) {
          throw new MusicError("Say what to play: a search phrase or a URL.");
        }
        // scsearch1: is yt-dlp's SoundCloud search extractor, same shape as ytsearch1:.
        const track = await this.resolve({ arg: `scsearch1:${query}`, request: query }, request.requestedBy);
        return this.enqueueOrStart(track, request.enqueue);
      }
      case "bandcamp": {
        const url = request.url?.trim();
        if (!url) {
          // yt-dlp has no bandcamp search extractor; only a direct URL resolves.
          throw new MusicError("Bandcamp needs a direct URL — search is not supported for this source.");
        }
        return this.play({ url, ...common });
      }
      case "band-library":
        // No backing catalog/API for the house band's own recordings exists in
        // this repo yet (PHA-3785 scope note) — fail clearly instead of
        // fabricating a listing.
        throw new MusicError(
          "The band-library source is not available yet: there is no backing catalog wired up for it.",
        );
      default:
        throw new MusicError(`Unknown source "${String(request.source)}".`);
    }
  }

  /** Shared tail of the two `resolve()`-then-queue-or-play paths outside `play()`. */
  private async enqueueOrStart(track: MusicTrack, enqueue: boolean | undefined): Promise<MusicTrack> {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    if (enqueue && (this.stream !== undefined || this.queue.length > 0)) {
      this.queue.push(track);
      this.params.log?.(
        `teamspeak music: queued "${track.title}" request="${track.request}" position=${this.queue.length}`,
      );
      return { ...track, queuedPosition: this.queue.length };
    }
    this.stop("replaced");
    this.startStream(track, 0);
    return track;
  }

  stop(reason: string): boolean {
    this.queue = [];
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

  private newTrackId(): string {
    return `t${this.nextTrackId++}`;
  }

  private async resolve(
    target: { arg: string; request: string },
    requestedBy?: string,
  ): Promise<MusicTrack> {
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
    return {
      ...parsed,
      id: this.newTrackId(),
      request: target.request,
      ...(requestedBy ? { requestedBy } : {}),
    };
  }

  // --- streaming ------------------------------------------------------------

  /**
   * @param startFrames Frames to seed `framesSent`/pacing at, for a reseek
   *   restart — the new segment's pacing and reported elapsed time both read
   *   as continuing from here rather than resetting to zero.
   * @param seekSeconds Input-side `-ss` for a reseek restart. Omitted (0) for
   *   an ordinary start.
   */
  private startStream(
    track: MusicTrack,
    startDelayMs = 0,
    startFrames = 0,
    seekSeconds = 0,
  ): void {
    const config = this.params.config;
    const args = [
      "-nostdin",
      "-loglevel",
      "error",
      ...(seekSeconds > 0 ? ["-ss", String(seekSeconds)] : []),
      // The resolved URL is a signed CDN link; reconnect so a mid-track TCP
      // reset does not end the song. Meaningless for a file, and ffmpeg
      // complains about it, so a file gets none of it.
      ...(track.isFile
        ? []
        : ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]),
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
      // A start in the future: `pump` owes no frames until the clock reaches
      // it, and ffmpeg's decode simply prebuffers up to the high-water mark.
      startedAt: this.now() + startDelayMs,
      startFrames,
      framesSent: startFrames,
      pending: Buffer.alloc(0),
      ended: false,
      backpressured: false,
      userPaused: false,
      pausedAt: undefined,
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
      `teamspeak music: playing "${track.title}" request="${track.request}" volume=${this.gain}${startDelayMs > 0 ? ` startDelayMs=${startDelayMs}` : ""}${track.isFile ? " source=file" : ""}`,
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
    if (stream.userPaused) {
      // Frozen in place: ffmpeg keeps decoding into `pending` (bounded by the
      // usual backpressure below), but nothing is paced out to the bridge
      // until `resume()` shifts `startedAt` forward.
      this.applyBackpressure(stream);
      return;
    }
    const prebufferFrames = Math.max(
      1,
      Math.round((this.params.config?.prebufferMs ?? DEFAULT_MUSIC_PREBUFFER_MS) / MUSIC_FRAME_MS),
    );
    const due =
      stream.startFrames +
      Math.floor((this.now() - stream.startedAt) / MUSIC_FRAME_MS) +
      prebufferFrames;
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
    const next = this.queue.shift();
    if (next) {
      this.params.log?.(
        `teamspeak music: advancing to queued "${next.title}" remaining=${this.queue.length}`,
      );
      this.startStream(next, 0);
    }
  }

  private applyBackpressure(stream: ActiveStream): void {
    const bufferedMs = (stream.pending.length / MUSIC_FRAME_BYTES) * MUSIC_FRAME_MS;
    if (!stream.backpressured && bufferedMs >= HIGH_WATER_MS) {
      stream.backpressured = true;
      stream.child.stdout?.pause();
      return;
    }
    // Never resume the pipe out from under a user pause — resume() will do it
    // once the user actually unpauses.
    if (stream.backpressured && bufferedMs <= LOW_WATER_MS && !stream.userPaused) {
      stream.backpressured = false;
      stream.child.stdout?.resume();
    }
  }

  // --- queue browsing & transport (PHA-3785) ---------------------------------

  nowPlayingInfo(): MusicNowPlaying | undefined {
    const stream = this.stream;
    if (!stream) {
      return undefined;
    }
    return {
      track: stream.track,
      elapsedMs: stream.framesSent * MUSIC_FRAME_MS,
      paused: stream.userPaused,
    };
  }

  listQueue(): MusicTrack[] {
    return [...this.queue];
  }

  /** Advance past the current track without touching the rest of the queue. */
  skip(): MusicTrack | undefined {
    const stream = this.stream;
    if (!stream) {
      return undefined;
    }
    this.stream = undefined;
    this.clearIntervalFn(stream.timer);
    try {
      stream.child.kill("SIGKILL");
    } catch (error) {
      this.params.log?.(`teamspeak music: killing ffmpeg failed: ${describe(error)}`);
    }
    this.params.log?.(
      `teamspeak music: skipped track="${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS} remaining=${this.queue.length}`,
    );
    const next = this.queue.shift();
    if (next) {
      this.startStream(next, 0);
    }
    return next;
  }

  removeFromQueue(id: string): MusicTrack | undefined {
    const index = this.queue.findIndex((track) => track.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = this.queue.splice(index, 1);
    this.params.log?.(`teamspeak music: removed "${removed?.title}" from queue remaining=${this.queue.length}`);
    return removed;
  }

  moveInQueue(id: string, toPosition: number): MusicTrack[] {
    const index = this.queue.findIndex((track) => track.id === id);
    if (index < 0) {
      throw new MusicError(`No queued track with id "${id}".`);
    }
    const [track] = this.queue.splice(index, 1);
    if (!track) {
      throw new MusicError(`No queued track with id "${id}".`);
    }
    const clamped = Math.min(Math.max(0, Math.trunc(toPosition) - 1), this.queue.length);
    this.queue.splice(clamped, 0, track);
    this.params.log?.(
      `teamspeak music: moved "${track.title}" to position=${clamped + 1} of ${this.queue.length}`,
    );
    return [...this.queue];
  }

  clearQueue(): number {
    const count = this.queue.length;
    this.queue = [];
    if (count > 0) {
      this.params.log?.(`teamspeak music: cleared ${count} queued track(s)`);
    }
    return count;
  }

  async search(query: string, limit: number): Promise<MusicSearchCandidate[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new MusicError("Say what to search for.");
    }
    const count = Math.min(10, Math.max(1, Math.trunc(limit) || 5));
    const config = this.params.config;
    const args = [
      "--flat-playlist",
      "--no-warnings",
      "--print",
      "%(title)s\t%(id)s\t%(duration)s\t%(uploader)s\t%(webpage_url)s",
      ...(config?.cookiesFile ? ["--cookies", config.cookiesFile] : []),
      `ytsearch${count}:${trimmedQuery}`,
    ];
    const ytdlp = config?.ytdlpPath ?? "yt-dlp";
    const result = await this.run(ytdlp, args, {
      timeoutMs: config?.resolveTimeoutMs ?? DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new MusicError(
        `Search failed for "${trimmedQuery}"${result.stderr.trim() ? `: ${lastLine(result.stderr)}` : "."}`,
      );
    }
    const candidates = parseSearchOutput(result.stdout);
    this.params.log?.(`teamspeak music: search "${trimmedQuery}" -> ${candidates.length} candidate(s)`);
    return candidates;
  }

  pause(): boolean {
    const stream = this.stream;
    if (!stream || stream.userPaused) {
      return false;
    }
    stream.userPaused = true;
    stream.pausedAt = this.now();
    stream.child.stdout?.pause();
    this.params.log?.(`teamspeak music: paused "${stream.track.title}"`);
    return true;
  }

  resume(): boolean {
    const stream = this.stream;
    if (!stream || !stream.userPaused) {
      return false;
    }
    const heldMs = stream.pausedAt === undefined ? 0 : this.now() - stream.pausedAt;
    stream.startedAt += heldMs;
    stream.userPaused = false;
    stream.pausedAt = undefined;
    if (!stream.backpressured) {
      stream.child.stdout?.resume();
    }
    this.params.log?.(`teamspeak music: resumed "${stream.track.title}" heldMs=${heldMs}`);
    return true;
  }

  async seek(seconds: number): Promise<MusicTrack> {
    const stream = this.stream;
    if (!stream) {
      throw new MusicError("Nothing is playing to seek.");
    }
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new MusicError("Give a timestamp in seconds, 0 or greater.");
    }
    const track = stream.track;
    this.clearIntervalFn(stream.timer);
    try {
      stream.child.kill("SIGKILL");
    } catch (error) {
      this.params.log?.(`teamspeak music: killing ffmpeg failed: ${describe(error)}`);
    }
    this.stream = undefined;
    const startFrames = Math.round((seconds * 1000) / MUSIC_FRAME_MS);
    this.params.log?.(`teamspeak music: seeking "${track.title}" to ${seconds}s`);
    this.startStream(track, 0, startFrames, Math.max(0, Math.trunc(seconds)));
    return track;
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

/** Parses the tab-separated `--print` lines from `search()`. Bad lines are skipped, not fatal. */
function parseSearchOutput(stdout: string): MusicSearchCandidate[] {
  const candidates: MusicSearchCandidate[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    const [title, id, duration, channel, webpageUrl] = parts;
    if (!id || !webpageUrl) {
      continue;
    }
    const durationSeconds = duration ? Number(duration) : Number.NaN;
    candidates.push({
      title: title || "something",
      id,
      url: webpageUrl,
      ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
      ...(channel && channel !== "NA" ? { channel } : {}),
    });
  }
  return candidates;
}

function basenameOf(file: string): string {
  const name = file.split(/[\\/]/u).pop() ?? file;
  return name.replace(/\.[a-z0-9]+$/iu, "") || "something";
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
