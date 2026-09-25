import { readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBandAnnouncement,
  buildBandFailureLine,
  buildBandVibe,
  DEFAULT_BAND_NAME,
  titleFromBrief
} from "./band-vibe.js";
class BandLeader {
  constructor(params) {
    this.params = params;
    this.rng = params.rng ?? Math.random;
    this.now = params.now ?? (() => Date.now());
    this.wait = params.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.songsDir = params.config.songsDir ?? path.join(os.tmpdir(), "teamspeak-band");
  }
  params;
  job;
  state = "idle";
  lastError;
  /** Which song `lastError` is about — `status()` has no job to read the title from once a job fails. */
  lastFailedTitle;
  /** Newest first, bounded to `keepSongs` so it never outlives the files on disk. */
  history = [];
  closed = false;
  rng;
  now;
  wait;
  songsDir;
  get bandName() {
    return this.params.config.name ?? DEFAULT_BAND_NAME;
  }
  compose(request) {
    if (this.closed) {
      return { ok: false, error: "The band has gone home.", status: this.status() };
    }
    if (this.job) {
      return {
        ok: false,
        error: `The band is already working on "${this.job.title}". One song at a time.`,
        status: this.status()
      };
    }
    const brief = request.brief.trim();
    if (!brief) {
      return { ok: false, error: "Say what the song is about.", status: this.status() };
    }
    const lyrics = request.lyrics?.trim() || void 0;
    if (request.vocals && !lyrics) {
      return {
        ok: false,
        error: "A song with a singer needs lyrics. Write them, then call again with them.",
        status: this.status()
      };
    }
    const title = request.title?.trim() || titleFromBrief(brief);
    const vibe = buildBandVibe(
      { brief, mood: request.mood, vocals: request.vocals, singer: request.singer },
      this.rng
    );
    const job = {
      title,
      spec: { title, style: vibe.style, styleTags: vibe.styleTags, vocals: request.vocals, lyrics },
      mood: vibe.mood,
      keywords: vibe.keywords,
      singer: vibe.singer,
      startedAt: this.now(),
      requestedBy: request.requestedBy?.trim() || void 0,
      dedicatedTo: request.dedicatedTo?.trim() || void 0,
      controller: new AbortController(),
      announcement: void 0,
      replayOf: void 0
    };
    this.job = job;
    this.state = "composing";
    this.lastError = void 0;
    this.params.log?.(
      `teamspeak band: composing "${title}" provider=${this.params.generator.id} vocals=${request.vocals} singer=${vibe.singer ?? "none"} mood=${vibe.mood} keywords=${JSON.stringify(vibe.keywords)} style=${JSON.stringify(vibe.style)}`
    );
    void this.run(job);
    return {
      ok: true,
      title,
      style: vibe.style,
      styleTags: vibe.styleTags,
      mood: vibe.mood,
      keywords: vibe.keywords,
      singer: vibe.singer
    };
  }
  lyrics(titleQuery) {
    const found = this.findPlayed(titleQuery);
    if (!found) {
      return {
        ok: false,
        error: titleQuery ? `No song called "${titleQuery}" in what I remember playing.` : "Nothing's been played yet tonight."
      };
    }
    if (!found.vocals || !found.lyrics) {
      return { ok: false, error: `"${found.title}" was instrumental. No lyrics \u2014 just the band.` };
    }
    return { ok: true, title: found.title, singer: found.singer, lyrics: found.lyrics };
  }
  replay(request) {
    if (this.closed) {
      return { ok: false, error: "The band has gone home." };
    }
    if (this.job) {
      return { ok: false, error: `The band is already working on "${this.job.title}". One song at a time.` };
    }
    const found = this.findPlayed(request.titleQuery);
    if (!found) {
      return {
        ok: false,
        error: request.titleQuery ? `No song called "${request.titleQuery}" in what I remember playing.` : "Nothing's been played yet tonight, so there's nothing to bring back."
      };
    }
    const job = {
      title: found.title,
      spec: { title: found.title, style: "", styleTags: "", vocals: found.vocals, lyrics: found.lyrics },
      mood: "replay",
      keywords: [],
      singer: found.singer,
      startedAt: this.now(),
      requestedBy: request.requestedBy?.trim() || void 0,
      dedicatedTo: void 0,
      controller: new AbortController(),
      announcement: void 0,
      replayOf: found
    };
    this.job = job;
    this.state = "composing";
    this.lastError = void 0;
    this.params.log?.(`teamspeak band: replaying "${found.title}" provider=${found.provider}`);
    void this.run(job);
    return { ok: true, title: found.title, singer: found.singer };
  }
  status() {
    const job = this.job;
    const last = this.history[0];
    return {
      status: this.state,
      bandName: this.bandName,
      provider: this.params.generator.id,
      title: job?.title ?? last?.title ?? this.lastFailedTitle,
      startedAt: job?.startedAt,
      elapsedMs: job ? this.now() - job.startedAt : void 0,
      error: this.lastError,
      style: job?.spec.style,
      mood: job?.mood,
      singer: job?.singer,
      announcement: job?.announcement,
      lastSong: last ? {
        title: last.title,
        audioPath: last.audioPath,
        provider: last.provider,
        vocals: last.vocals,
        lyrics: last.lyrics,
        singer: last.singer
      } : void 0
    };
  }
  close() {
    this.closed = true;
    this.job?.controller.abort();
    this.job = void 0;
    this.state = "idle";
  }
  /** Exact title match first, then a substring; newest match wins either way. */
  findPlayed(titleQuery) {
    const wanted = titleQuery?.trim().toLowerCase();
    if (!wanted) {
      return this.history[0];
    }
    const exact = this.history.find((song) => song.title.toLowerCase() === wanted);
    if (exact) {
      return exact;
    }
    return this.history.find((song) => song.title.toLowerCase().includes(wanted));
  }
  /** Newest first, deduplicated by title, bounded to `keepSongs`. */
  recordPlayed(played) {
    this.history = this.history.filter((song) => song.title.toLowerCase() !== played.title.toLowerCase());
    this.history.unshift(played);
    this.history.length = Math.min(this.history.length, Math.max(1, this.params.config.keepSongs));
  }
  // --- the job -----------------------------------------------------------------
  async run(job) {
    let song;
    if (job.replayOf) {
      const onDisk = await stat(job.replayOf.audioPath).then(
        () => true,
        () => false
      );
      if (!onDisk) {
        await this.fail(job, `the recording for "${job.replayOf.title}" is gone. Ask me to write a new one.`);
        return;
      }
      song = {
        title: job.replayOf.title,
        audioPath: job.replayOf.audioPath,
        provider: job.replayOf.provider,
        durationMs: job.replayOf.durationMs
      };
    } else {
      const timeout = setTimeout(() => job.controller.abort(), this.params.config.generateTimeoutMs);
      try {
        song = await this.params.generator.generate(job.spec, {
          outDir: this.songsDir,
          signal: job.controller.signal,
          fileStem: fileStem(job.title, job.startedAt)
        });
      } catch (error) {
        clearTimeout(timeout);
        const message = job.controller.signal.aborted ? `generation timed out after ${this.params.config.generateTimeoutMs}ms` : describe(error);
        await this.fail(job, message);
        return;
      }
      clearTimeout(timeout);
    }
    if (this.job !== job || this.closed) {
      return;
    }
    this.recordPlayed({
      title: song.title,
      audioPath: song.audioPath,
      provider: song.provider,
      durationMs: song.durationMs,
      vocals: job.spec.vocals,
      lyrics: job.spec.vocals ? job.spec.lyrics : void 0,
      singer: job.singer,
      playedAt: this.now()
    });
    this.params.log?.(
      `teamspeak band: generated "${song.title}" provider=${song.provider} in ${this.now() - job.startedAt}ms file=${song.audioPath}${song.durationMs ? ` durationMs=${song.durationMs}` : ""}`
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
          singer: job.singer
        },
        this.rng
      );
      try {
        const spoken = await this.params.speak(job.announcement);
        if (spoken) {
          startDelayMs = spoken.durationMs + this.params.config.introGapMs;
        }
      } catch (error) {
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
      `teamspeak band: on stage "${song.title}" announced=${JSON.stringify(job.announcement ?? "")} startDelayMs=${startDelayMs}`
    );
    this.job = void 0;
    this.state = "idle";
    this.params.onSettled?.({ ...this.status(), status: "playing", title: song.title, announcement: job.announcement });
    void this.prune().catch((error) => {
      this.params.log?.(`teamspeak band: prune failed: ${describe(error)}`);
    });
  }
  async fail(job, message) {
    if (this.job !== job) {
      return;
    }
    this.job = void 0;
    this.state = "failed";
    this.lastError = message;
    this.lastFailedTitle = job.title;
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
  async prune() {
    const keep = this.params.config.keepSongs;
    const entries = await readdir(this.songsDir).catch(() => []);
    const files = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(this.songsDir, name);
        const info = await stat(full).catch(() => void 0);
        return info?.isFile() ? { full, mtime: info.mtimeMs } : void 0;
      })
    );
    const sorted = files.filter((file) => file !== void 0).sort((a, b) => b.mtime - a.mtime);
    for (const file of sorted.slice(keep)) {
      await unlink(file.full).catch(() => void 0);
    }
  }
}
function fileStem(title, startedAt) {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return `${new Date(startedAt).toISOString().replace(/[:.]/gu, "-")}-${slug || "song"}`;
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  BandLeader
};
