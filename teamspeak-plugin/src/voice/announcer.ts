/**
 * Entrance and exit lines (PHA-3824).
 *
 * ts-summoner owns when a bot's core starts and stops, but only the gateway
 * can speak. So the summoner drops a request file into the bot's container
 * (`docker exec`, the same way it touches `.off-duty`) and this polls for it:
 *
 *   - entrance: the file is written before `supervisorctl start sexton`; the
 *     bridge comes up, the bot joins, and the line plays once it's in.
 *   - exit: the file is written while the core is still up; the summoner then
 *     waits for the file to disappear before `supervisorctl stop sexton`.
 *     This removes it only after the line has finished playing, so "gone"
 *     means "said".
 *
 * The lines are a per-bot JSON file in the agent workspace
 * (`{ "shift_start": [...], "summon": [...], ... }`), re-read on every
 * request so swapping lines is a file edit, not a rebuild. A reason with no
 * pool is consumed silently: the summoner never waits on a bot that has
 * nothing to say.
 */
import { readFile, unlink } from "node:fs/promises";

export type AnnounceRequest = { reason: string; at: number };

export type AnnouncerParams = {
  requestFile: string;
  linesFile: string;
  /** Plays a line; resolves with its audio length, or undefined if nothing played. */
  speak: (text: string) => Promise<{ durationMs: number } | undefined>;
  /** In the channel and able to be heard. Requests wait (not dropped) until it is. */
  isReady: () => boolean;
  pollMs?: number;
  /** An entrance that waited longer than this for the core is no longer an entrance. */
  maxAgeMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_AGE_MS = 3 * 60_000;
/** Room for the last frames to leave the bridge after the line's own length. */
const TAIL_MS = 400;

export class Announcer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  /** Last index used per reason, so the same line never plays twice running. */
  private readonly last = new Map<string, number>();

  constructor(private readonly params: AnnouncerParams) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.params.pollMs ?? DEFAULT_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy || !this.params.isReady()) return;
    this.busy = true;
    try {
      const request = await this.readRequest();
      if (!request) return;
      try {
        await this.announce(request);
      } finally {
        await unlink(this.params.requestFile).catch(() => undefined);
      }
    } finally {
      this.busy = false;
    }
  }

  private async readRequest(): Promise<AnnounceRequest | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.params.requestFile, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AnnounceRequest>;
      return { reason: String(parsed.reason ?? ""), at: Number(parsed.at) || 0 };
    } catch {
      return { reason: "", at: 0 };
    }
  }

  private async announce(request: AnnounceRequest): Promise<void> {
    const now = this.params.now ?? Date.now;
    const age = now() - request.at;
    if (age > (this.params.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
      this.params.log?.(`teamspeak announce: dropped stale '${request.reason}' (${Math.round(age / 1000)}s old)`);
      return;
    }
    const line = await this.pick(request.reason);
    if (!line) {
      this.params.log?.(`teamspeak announce: no lines for '${request.reason}'`);
      return;
    }
    this.params.log?.(`teamspeak announce: ${request.reason}: ${line}`);
    try {
      const played = await this.params.speak(line);
      if (played) {
        await (this.params.sleep ?? defaultSleep)(played.durationMs + TAIL_MS);
      }
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async pick(reason: string): Promise<string | undefined> {
    let pool: unknown;
    try {
      pool = (JSON.parse(await readFile(this.params.linesFile, "utf8")) as Record<string, unknown>)[reason];
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't read ${this.params.linesFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const lines = Array.isArray(pool) ? pool.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
    if (!lines.length) return undefined;
    const prev = this.last.get(reason);
    const random = this.params.random ?? Math.random;
    let i = Math.floor(random() * lines.length);
    if (lines.length > 1 && i === prev) {
      // Skip ahead by 1..n-1 so every other line stays equally likely.
      i = (i + 1 + Math.floor(random() * (lines.length - 1))) % lines.length;
    }
    this.last.set(reason, i);
    return lines[i];
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
