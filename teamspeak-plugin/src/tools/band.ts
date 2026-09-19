/**
 * The band leader (PHA-3554).
 *
 * `compose_song` is not a tool call that returns a song. A real generator
 * takes one to three minutes, and a voice turn that sits in a tool for that
 * long is a room staring at a silent bot — and, on most hosts, a tool call
 * that times out. So the tool kicks the job and returns at once; the agent
 * says one line ("the band's warming up"); and when the track lands, the band
 * leader does the rest himself, off the turn: the announcement over the voice
 * lane, a beat of silence, then the downbeat on the music lane.
 *
 * One song at a time. A second `compose_song` while one is cooking is refused
 * with the state, so the agent can say so rather than queue a set list.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedTeamSpeakBandConfig } from "../config.js";
import type { GeneratedSong, SongGenerator, SongSpec } from "./band-generators.js";
import {
  buildBandAnnouncement,
  buildBandFailureLine,
  buildBandVibe,
  DEFAULT_BAND_NAME,
  titleFromBrief,
  type BandSinger,
  type Rng,
} from "./band-vibe.js";
import type { MusicController } from "./music.js";

export type ComposeRequest = {
  title?: string | undefined;
  brief: string;
  vocals: boolean;
  /** Who sings, when `vocals`. Defaults to the band leader. */
  singer?: BandSinger | undefined;
  lyrics?: string | undefined;
  mood?: string | undefined;
  dedicatedTo?: string | undefined;
  requestedBy?: string | undefined;
};

export type BandJobStatus = "idle" | "composing" | "announcing" | "playing" | "failed";

export type BandStatus = {
  status: BandJobStatus;
  bandName: string;
  provider: string;
  title: string | undefined;
  startedAt: number | undefined;
  elapsedMs: number | undefined;
  error: string | undefined;
  /** What went to the generator, for `band_status` and the log. */
  style: string | undefined;
  mood: string | undefined;
  singer: BandSinger | undefined;
  announcement: string | undefined;
  lastSong: { title: string; audioPath: string; provider: string } | undefined;
};

export type ComposeOutcome =
  | {
      ok: true;
      title: string;
      style: string;
      styleTags: string;
      mood: string;
      keywords: string[];
      singer: BandSinger | undefined;
    }
  | { ok: false; error: string; status: BandStatus };

/** The surface the tool registry needs; a fake stands in for it in tests. */
export type BandController = {
  compose(request: ComposeRequest): ComposeOutcome;
  status(): BandStatus;
  close(): void;
};

export type BandSpeak = (text: string) => Promise<{ durationMs: number } | undefined>;

export type BandLeaderParams = {
  config: ResolvedTeamSpeakBandConfig;
  generator: SongGenerator;
  music: MusicController;
  /**
   * Say a line over the voice lane and resolve when it has been handed to the
   * bridge, with how long it runs. Undefined when the lane cannot speak (no
   * synthesizer on this account); the song then just starts.
   */
  speak?: BandSpeak | undefined;
  rng?: Rng | undefined;
  now?: (() => number) | undefined;
  /** Test seam for the wait between announcement and downbeat. */
  wait?: ((ms: number) => Promise<void>) | undefined;
  /** Called when a job settles, after the song is playing or the failure spoken. */
  onSettled?: ((status: BandStatus) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

type Job = {
  title: string;
  spec: SongSpec;
  mood: string;
  keywords: string[];
  singer: BandSinger | undefined;
  startedAt: number;
  requestedBy: string | undefined;
  dedicatedTo: string | undefined;
  controller: AbortController;
  announcement: string | undefined;
};

export class BandLeader implements BandController {
  private job: Job | undefined;
  private state: BandJobStatus = "idle";
  private lastError: string | undefined;
  private lastSong: GeneratedSong | undefined;
  private closed = false;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly songsDir: string;

  constructor(private readonly params: BandLeaderParams) {
    this.rng = params.rng ?? Math.random;
    this.now = params.now ?? (() => Date.now());
    this.wait = params.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.songsDir = params.config.songsDir ?? path.join(os.tmpdir(), "teamspeak-band");
  }

  get bandName(): string {
    return this.params.config.name ?? DEFAULT_BAND_NAME;
  }

  compose(request: ComposeRequest): ComposeOutcome {
    if (this.closed) {
      return { ok: false, error: "The band has gone home.", status: this.status() };
    }
    if (this.job) {
      return {
        ok: false,
        error: `The band is already working on "${this.job.title}". One song at a time.`,
        status: this.status(),
      };
    }
    const brief = request.brief.trim();
    if (!brief) {
      return { ok: false, error: "Say what the song is about.", status: this.status() };
    }
    const lyrics = request.lyrics?.trim() || undefined;
    if (request.vocals && !lyrics) {
      return {
        ok: false,
        error: "A song with a singer needs lyrics. Write them, then call again with them.",
        status: this.status(),
      };
    }
    const title = request.title?.trim() || titleFromBrief(brief);
    const vibe = buildBandVibe(
      { brief, mood: request.mood, vocals: request.vocals, singer: request.singer },
      this.rng,
    );
    const job: Job = {
      title,
      spec: { title, style: vibe.style, styleTags: vibe.styleTags, vocals: request.vocals, lyrics },
      mood: vibe.mood,
      keywords: vibe.keywords,
      singer: vibe.singer,
      startedAt: this.now(),
      requestedBy: request.requestedBy?.trim() || undefined,
      dedicatedTo: request.dedicatedTo?.trim() || undefined,
      controller: new AbortController(),
      announcement: undefined,
    };
    this.job = job;
    this.state = "composing";
    this.lastError = undefined;
    this.params.log?.(
      `teamspeak band: composing "${title}" provider=${this.params.generator.id} vocals=${request.vocals} singer=${vibe.singer ?? "none"} mood=${vibe.mood} keywords=${JSON.stringify(vibe.keywords)} style=${JSON.stringify(vibe.style)}`,
    );
    void this.run(job);
    return {
      ok: true,
      title,
      style: vibe.style,
      styleTags: vibe.styleTags,
      mood: vibe.mood,
      keywords: vibe.keywords,
      singer: vibe.singer,
    };
  }

  status(): BandStatus {
    const job = this.job;
    return {
      status: this.state,
      bandName: this.bandName,
      provider: this.params.generator.id,
      title: job?.title ?? this.lastSong?.title,
      startedAt: job?.startedAt,
      elapsedMs: job ? this.now() - job.startedAt : undefined,
      error: this.lastError,
      style: job?.spec.style,
      mood: job?.mood,
      singer: job?.singer,
      announcement: job?.announcement,
      lastSong: this.lastSong
        ? { title: this.lastSong.title, audioPath: this.lastSong.audioPath, provider: this.lastSong.provider }
        : undefined,
    };
  }

  close(): void {
    this.closed = true;
    this.job?.controller.abort();
    this.job = undefined;
    this.state = "idle";
  }

  // --- the job -----------------------------------------------------------------

  private async run(job: Job): Promise<void> {
    const timeout = setTimeout(() => job.controller.abort(), this.params.config.generateTimeoutMs);
    let song: GeneratedSong;
    try {
      song = await this.params.generator.generate(job.spec, {
        outDir: this.songsDir,
        signal: job.controller.signal,
        fileStem: fileStem(job.title, job.startedAt),
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = job.controller.signal.aborted
        ? `generation timed out after ${this.params.config.generateTimeoutMs}ms`
        : describe(error);
      await this.fail(job, message);
      return;
    }
    clearTimeout(timeout);
    if (this.job !== job || this.closed) {
      return;
    }
    this.lastSong = song;
    this.params.log?.(
      `teamspeak band: generated "${song.title}" provider=${song.provider} in ${this.now() - job.startedAt}ms file=${song.audioPath}${song.durationMs ? ` durationMs=${song.durationMs}` : ""}`,
    );

    let startDelayMs = 0;
    if (this.params.config.announce && this.params.speak) {
      this.state = "announcing";
      job.announcement = buildBandAnnouncement(
        {
          title: song.title,
          bandName: this.bandName,
          bandAliases: this.params.config.aliases,
          requestedBy: job.requestedBy,
          dedicatedTo: job.dedicatedTo,
          singer: job.singer,
        },
        this.rng,
      );
      try {
        const spoken = await this.params.speak(job.announcement);
        if (spoken) {
          startDelayMs = spoken.durationMs + this.params.config.introGapMs;
        }
      } catch (error) {
        // The announcement is the garnish. A TTS hiccup must not lose the song.
        this.params.log?.(`teamspeak band: announcement failed, playing anyway: ${describe(error)}`);
      }
      if (this.job !== job || this.closed) {
        return;
      }
    }

    try {
      await this.params.music.play({ file: song.audioPath, title: song.title, startDelayMs });
    } catch (error) {
      await this.fail(job, `playback failed: ${describe(error)}`);
      return;
    }
    this.state = "playing";
    this.params.log?.(
      `teamspeak band: on stage "${song.title}" announced=${JSON.stringify(job.announcement ?? "")} startDelayMs=${startDelayMs}`,
    );
    this.job = undefined;
    this.state = "idle";
    this.params.onSettled?.({ ...this.status(), status: "playing", title: song.title, announcement: job.announcement });
    void this.prune().catch((error) => {
      this.params.log?.(`teamspeak band: prune failed: ${describe(error)}`);
    });
  }

  private async fail(job: Job, message: string): Promise<void> {
    if (this.job !== job) {
      return;
    }
    this.job = undefined;
    this.state = "failed";
    this.lastError = message;
    this.params.log?.(`teamspeak band: "${job.title}" failed after ${this.now() - job.startedAt}ms: ${message}`);
    if (!this.closed && this.params.config.announce && this.params.speak) {
      try {
        await this.params.speak(buildBandFailureLine(this.rng));
      } catch (error) {
        this.params.log?.(`teamspeak band: could not even say it failed: ${describe(error)}`);
      }
    }
    this.params.onSettled?.(this.status());
  }

  /** Keep the newest `keepSongs` files in the songs dir; the rest are noise. */
  private async prune(): Promise<void> {
    const keep = this.params.config.keepSongs;
    const entries = await readdir(this.songsDir).catch(() => [] as string[]);
    const files = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(this.songsDir, name);
        const info = await stat(full).catch(() => undefined);
        return info?.isFile() ? { full, mtime: info.mtimeMs } : undefined;
      }),
    );
    const sorted = files
      .filter((file): file is { full: string; mtime: number } => file !== undefined)
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of sorted.slice(keep)) {
      await unlink(file.full).catch(() => undefined);
    }
  }
}

function fileStem(title: string, startedAt: number): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `${new Date(startedAt).toISOString().replace(/[:.]/gu, "-")}-${slug || "song"}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
