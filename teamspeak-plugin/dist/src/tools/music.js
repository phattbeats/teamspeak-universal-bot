import { execFile, spawn } from "node:child_process";
import {
  DEFAULT_MUSIC_PREBUFFER_MS,
  DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS,
  DEFAULT_MUSIC_VOLUME
} from "../config.js";
const MUSIC_FRAME_SAMPLES = 960;
const MUSIC_FRAME_BYTES = MUSIC_FRAME_SAMPLES * 2;
const MUSIC_FRAME_MS = 20;
const HIGH_WATER_MS = 4e3;
const LOW_WATER_MS = 1e3;
const STDERR_KEEP_BYTES = 2e3;
class MusicError extends Error {
}
const defaultRun = (command, args, options) => new Promise((resolve) => {
  execFile(
    command,
    args,
    { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    }
  );
});
const defaultSpawn = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
class MusicPlayer {
  constructor(params) {
    this.params = params;
    this.run = params.run ?? defaultRun;
    this.spawnProcess = params.spawnProcess ?? defaultSpawn;
    this.now = params.now ?? (() => Date.now());
    this.setIntervalFn = params.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = params.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.gain = clampGain(params.config?.defaultVolume ?? DEFAULT_MUSIC_VOLUME);
  }
  params;
  stream;
  /** Resolved tracks waiting their turn (PHA-3635); consumed on natural finish. */
  queue = [];
  gain;
  closed = false;
  run;
  spawnProcess;
  now;
  setIntervalFn;
  clearIntervalFn;
  nextTrackId = 1;
  get isPlaying() {
    return this.stream !== void 0;
  }
  get nowPlaying() {
    return this.stream?.track;
  }
  get queueLength() {
    return this.queue.length;
  }
  get volume() {
    return this.gain;
  }
  get paused() {
    return this.stream?.userPaused ?? false;
  }
  /** Milliseconds of decoded audio waiting to be paced out. Test/diagnostic. */
  get bufferedMs() {
    return this.stream ? Math.floor(this.stream.pending.length / MUSIC_FRAME_BYTES * MUSIC_FRAME_MS) : 0;
  }
  async play(request) {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    const file = request.file?.trim();
    const track = file ? {
      id: this.newTrackId(),
      title: request.title?.trim() || basenameOf(file),
      streamUrl: file,
      request: request.title?.trim() || file,
      isFile: true,
      ...request.requestedBy ? { requestedBy: request.requestedBy } : {}
    } : await this.resolve(resolveTarget(request), request.requestedBy);
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    if (request.enqueue && (this.stream !== void 0 || this.queue.length > 0)) {
      this.queue.push(track);
      this.params.log?.(
        `teamspeak music: queued "${track.title}" request="${track.request}" position=${this.queue.length}`
      );
      return { ...track, queuedPosition: this.queue.length };
    }
    this.stop("replaced");
    this.startStream(track, Math.max(0, request.startDelayMs ?? 0));
    return track;
  }
  /** Explicit-source play (PHA-3785). Delegates to `play()` once the target is resolved per source. */
  async playSource(request) {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    const common = {
      ...request.enqueue === void 0 ? {} : { enqueue: request.enqueue },
      ...request.requestedBy === void 0 ? {} : { requestedBy: request.requestedBy }
    };
    switch (request.source) {
      case "local": {
        const file = request.file?.trim();
        if (!file) {
          throw new MusicError("A local source needs a file path.");
        }
        return this.play({
          file,
          ...request.title === void 0 ? {} : { title: request.title },
          ...common
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
        const track = await this.resolve({ arg: `scsearch1:${query}`, request: query }, request.requestedBy);
        return this.enqueueOrStart(track, request.enqueue);
      }
      case "bandcamp": {
        const url = request.url?.trim();
        if (!url) {
          throw new MusicError("Bandcamp needs a direct URL \u2014 search is not supported for this source.");
        }
        return this.play({ url, ...common });
      }
      case "band-library":
        throw new MusicError(
          "The band-library source is not available yet: there is no backing catalog wired up for it."
        );
      default:
        throw new MusicError(`Unknown source "${String(request.source)}".`);
    }
  }
  /** Shared tail of the two `resolve()`-then-queue-or-play paths outside `play()`. */
  async enqueueOrStart(track, enqueue) {
    if (this.closed) {
      throw new MusicError("The music player is shut down.");
    }
    if (enqueue && (this.stream !== void 0 || this.queue.length > 0)) {
      this.queue.push(track);
      this.params.log?.(
        `teamspeak music: queued "${track.title}" request="${track.request}" position=${this.queue.length}`
      );
      return { ...track, queuedPosition: this.queue.length };
    }
    this.stop("replaced");
    this.startStream(track, 0);
    return track;
  }
  stop(reason) {
    this.queue = [];
    const stream = this.stream;
    if (!stream) {
      return false;
    }
    this.stream = void 0;
    this.clearIntervalFn(stream.timer);
    try {
      stream.child.kill("SIGKILL");
    } catch (error) {
      this.params.log?.(`teamspeak music: killing ffmpeg failed: ${describe(error)}`);
    }
    this.params.log?.(
      `teamspeak music: stopped reason=${reason} track="${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS}`
    );
    return true;
  }
  setVolume(volume) {
    this.gain = clampGain(volume);
    this.params.sink.setMusicGain(this.gain);
    this.params.log?.(`teamspeak music: volume=${this.gain}`);
    return this.gain;
  }
  close() {
    this.closed = true;
    this.stop("close");
  }
  // --- resolve --------------------------------------------------------------
  newTrackId() {
    return `t${this.nextTrackId++}`;
  }
  async resolve(target, requestedBy) {
    const config = this.params.config;
    const args = [
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      // One line, tab-separated, so a title containing anything at all cannot
      // be confused for the URL line the way `-g -e` output can.
      "--print",
      "%(title)s	%(urls)s",
      ...config?.cookiesFile ? ["--cookies", config.cookiesFile] : [],
      ...config?.ytdlpArgs ?? [],
      target.arg
    ];
    const ytdlp = config?.ytdlpPath ?? "yt-dlp";
    const started = this.now();
    const result = await this.run(ytdlp, args, {
      timeoutMs: config?.resolveTimeoutMs ?? DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS
    });
    const elapsed = this.now() - started;
    if (result.code !== 0) {
      this.params.log?.(
        `teamspeak music: yt-dlp failed code=${result.code} in ${elapsed}ms: ${lastLine(result.stderr)}`
      );
      throw new MusicError(
        `Could not find anything for "${target.request}"${result.stderr.trim() ? `: ${lastLine(result.stderr)}` : "."}`
      );
    }
    const parsed = parseResolveOutput(result.stdout);
    if (!parsed) {
      throw new MusicError(`yt-dlp returned no playable stream for "${target.request}".`);
    }
    this.params.log?.(
      `teamspeak music: resolved "${parsed.title}" in ${elapsed}ms request="${target.request}"`
    );
    return {
      ...parsed,
      id: this.newTrackId(),
      request: target.request,
      ...requestedBy ? { requestedBy } : {}
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
  startStream(track, startDelayMs = 0, startFrames = 0, seekSeconds = 0) {
    const config = this.params.config;
    const args = [
      "-nostdin",
      "-loglevel",
      "error",
      ...seekSeconds > 0 ? ["-ss", String(seekSeconds)] : [],
      // The resolved URL is a signed CDN link; reconnect so a mid-track TCP
      // reset does not end the song. Meaningless for a file, and ffmpeg
      // complains about it, so a file gets none of it.
      ...track.isFile ? [] : ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"],
      "-i",
      track.streamUrl,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "s16le",
      "pipe:1"
    ];
    const child = this.spawnProcess(config?.ffmpegPath ?? "ffmpeg", args);
    const stream = {
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
      pausedAt: void 0,
      stderrTail: "",
      timer: void 0
    };
    this.stream = stream;
    child.stdout?.on("data", ((chunk) => {
      if (this.stream !== stream) {
        return;
      }
      stream.pending = Buffer.concat([stream.pending, chunk]);
      this.applyBackpressure(stream);
    }));
    child.stdout?.on("end", (() => {
      stream.ended = true;
    }));
    child.stderr?.on("data", ((chunk) => {
      stream.stderrTail = `${stream.stderrTail}${String(chunk)}`.slice(-STDERR_KEEP_BYTES);
    }));
    child.on("error", ((error) => {
      this.params.log?.(`teamspeak music: ffmpeg error: ${describe(error)}`);
      stream.ended = true;
    }));
    child.on("exit", ((code) => {
      stream.ended = true;
      if (code !== 0 && code !== null && stream.stderrTail.trim()) {
        this.params.log?.(
          `teamspeak music: ffmpeg exited code=${code}: ${lastLine(stream.stderrTail)}`
        );
      }
    }));
    this.params.sink.setMusicGain(this.gain);
    stream.timer = this.setIntervalFn(() => this.pump(stream), MUSIC_FRAME_MS);
    this.params.log?.(
      `teamspeak music: playing "${track.title}" request="${track.request}" volume=${this.gain}${startDelayMs > 0 ? ` startDelayMs=${startDelayMs}` : ""}${track.isFile ? " source=file" : ""}`
    );
  }
  /**
   * Hand the bridge every frame that is due by wall clock, plus the prebuffer.
   * Falling behind (a slow tick, a stalled decode) is caught up here rather
   * than accumulating, because `framesSent` is compared against elapsed time
   * and not against the previous tick.
   */
  pump(stream) {
    if (this.stream !== stream) {
      return;
    }
    if (stream.userPaused) {
      this.applyBackpressure(stream);
      return;
    }
    const prebufferFrames = Math.max(
      1,
      Math.round((this.params.config?.prebufferMs ?? DEFAULT_MUSIC_PREBUFFER_MS) / MUSIC_FRAME_MS)
    );
    const due = stream.startFrames + Math.floor((this.now() - stream.startedAt) / MUSIC_FRAME_MS) + prebufferFrames;
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
      return;
    }
    if (stream.pending.length > 0) {
      const padded = Buffer.alloc(MUSIC_FRAME_BYTES);
      stream.pending.copy(padded);
      stream.pending = Buffer.alloc(0);
      stream.framesSent += 1;
      this.params.sink.sendMusicAudio(padded);
      return;
    }
    this.finish(stream);
  }
  finish(stream) {
    if (this.stream !== stream) {
      return;
    }
    this.stream = void 0;
    this.clearIntervalFn(stream.timer);
    this.params.log?.(
      `teamspeak music: finished "${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS}`
    );
    const next = this.queue.shift();
    if (next) {
      this.params.log?.(
        `teamspeak music: advancing to queued "${next.title}" remaining=${this.queue.length}`
      );
      this.startStream(next, 0);
    }
  }
  applyBackpressure(stream) {
    const bufferedMs = stream.pending.length / MUSIC_FRAME_BYTES * MUSIC_FRAME_MS;
    if (!stream.backpressured && bufferedMs >= HIGH_WATER_MS) {
      stream.backpressured = true;
      stream.child.stdout?.pause();
      return;
    }
    if (stream.backpressured && bufferedMs <= LOW_WATER_MS && !stream.userPaused) {
      stream.backpressured = false;
      stream.child.stdout?.resume();
    }
  }
  // --- queue browsing & transport (PHA-3785) ---------------------------------
  nowPlayingInfo() {
    const stream = this.stream;
    if (!stream) {
      return void 0;
    }
    return {
      track: stream.track,
      elapsedMs: stream.framesSent * MUSIC_FRAME_MS,
      paused: stream.userPaused
    };
  }
  listQueue() {
    return [...this.queue];
  }
  /** Advance past the current track without touching the rest of the queue. */
  skip() {
    const stream = this.stream;
    if (!stream) {
      return void 0;
    }
    this.stream = void 0;
    this.clearIntervalFn(stream.timer);
    try {
      stream.child.kill("SIGKILL");
    } catch (error) {
      this.params.log?.(`teamspeak music: killing ffmpeg failed: ${describe(error)}`);
    }
    this.params.log?.(
      `teamspeak music: skipped track="${stream.track.title}" playedMs=${stream.framesSent * MUSIC_FRAME_MS} remaining=${this.queue.length}`
    );
    const next = this.queue.shift();
    if (next) {
      this.startStream(next, 0);
    }
    return next;
  }
  removeFromQueue(id) {
    const index = this.queue.findIndex((track) => track.id === id);
    if (index < 0) {
      return void 0;
    }
    const [removed] = this.queue.splice(index, 1);
    this.params.log?.(`teamspeak music: removed "${removed?.title}" from queue remaining=${this.queue.length}`);
    return removed;
  }
  moveInQueue(id, toPosition) {
    const index = this.queue.findIndex((track2) => track2.id === id);
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
      `teamspeak music: moved "${track.title}" to position=${clamped + 1} of ${this.queue.length}`
    );
    return [...this.queue];
  }
  clearQueue() {
    const count = this.queue.length;
    this.queue = [];
    if (count > 0) {
      this.params.log?.(`teamspeak music: cleared ${count} queued track(s)`);
    }
    return count;
  }
  async search(query, limit) {
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
      "%(title)s	%(id)s	%(duration)s	%(uploader)s	%(webpage_url)s",
      ...config?.cookiesFile ? ["--cookies", config.cookiesFile] : [],
      `ytsearch${count}:${trimmedQuery}`
    ];
    const ytdlp = config?.ytdlpPath ?? "yt-dlp";
    const result = await this.run(ytdlp, args, {
      timeoutMs: config?.resolveTimeoutMs ?? DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS
    });
    if (result.code !== 0) {
      throw new MusicError(
        `Search failed for "${trimmedQuery}"${result.stderr.trim() ? `: ${lastLine(result.stderr)}` : "."}`
      );
    }
    const candidates = parseSearchOutput(result.stdout);
    this.params.log?.(`teamspeak music: search "${trimmedQuery}" -> ${candidates.length} candidate(s)`);
    return candidates;
  }
  pause() {
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
  resume() {
    const stream = this.stream;
    if (!stream || !stream.userPaused) {
      return false;
    }
    const heldMs = stream.pausedAt === void 0 ? 0 : this.now() - stream.pausedAt;
    stream.startedAt += heldMs;
    stream.userPaused = false;
    stream.pausedAt = void 0;
    if (!stream.backpressured) {
      stream.child.stdout?.resume();
    }
    this.params.log?.(`teamspeak music: resumed "${stream.track.title}" heldMs=${heldMs}`);
    return true;
  }
  async seek(seconds) {
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
    this.stream = void 0;
    const startFrames = Math.round(seconds * 1e3 / MUSIC_FRAME_MS);
    this.params.log?.(`teamspeak music: seeking "${track.title}" to ${seconds}s`);
    this.startStream(track, 0, startFrames, Math.max(0, Math.trunc(seconds)));
    return track;
  }
}
function resolveTarget(request) {
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
  return { arg: `ytsearch1:${query}`, request: query };
}
function parseResolveOutput(stdout) {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const tab = trimmed.indexOf("	");
    const title = tab >= 0 ? trimmed.slice(0, tab).trim() : "";
    const streamUrl = tab >= 0 ? trimmed.slice(tab + 1).trim() : trimmed;
    if (!/^https?:\/\//iu.test(streamUrl)) {
      continue;
    }
    return { title: title || "something", streamUrl };
  }
  return void 0;
}
function parseSearchOutput(stdout) {
  const candidates = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("	");
    const [title, id, duration, channel, webpageUrl] = parts;
    if (!id || !webpageUrl) {
      continue;
    }
    const durationSeconds = duration ? Number(duration) : Number.NaN;
    candidates.push({
      title: title || "something",
      id,
      url: webpageUrl,
      ...Number.isFinite(durationSeconds) ? { durationSeconds } : {},
      ...channel && channel !== "NA" ? { channel } : {}
    });
  }
  return candidates;
}
function basenameOf(file) {
  const name = file.split(/[\\/]/u).pop() ?? file;
  return name.replace(/\.[a-z0-9]+$/iu, "") || "something";
}
function clampGain(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_MUSIC_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}
function lastLine(text) {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  MUSIC_FRAME_BYTES,
  MUSIC_FRAME_MS,
  MUSIC_FRAME_SAMPLES,
  MusicError,
  MusicPlayer
};
