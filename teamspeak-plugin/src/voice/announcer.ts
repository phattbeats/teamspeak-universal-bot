/**
 * Entrance and exit lines (#3824).
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
 *
 * Daily mood (#3840): a `shift_start` also rolls the bot's mood for the
 * shift from a weighted table in the workspace (`moods.json`) and writes it to
 * `mood/AGENTS.md`, which the bootstrap-extra-files hook puts in every prompt.
 * The entrance line comes from the `mood:<name>` pool when there is one. A
 * summon keeps the shift's mood, or rolls one if the last is stale. The
 * summoner sends entrances even into an empty server, marked `quiet`, so the
 * mood still turns over when nobody's there to hear the line.
 *
 * #3841 additions (all optional, so an older summoner still works):
 *   - `reason` may carry a tag, `shift_start:halloween` (a calendar night) or
 *     `shift_start:bender_return` (a rare event). Line order: the tagged pool,
 *     then the mood pool, then the plain `shift_start`. A themed night beats a
 *     mood; the mood still rolls off the base reason.
 *   - `vars` fill `{name}` placeholders (`{who}` on a birthday). A line with a
 *     placeholder the request didn't fill is skipped, never read out raw.
 *   - `text` is a line to say verbatim, no pool. Two-bot scenes use it: the
 *     summoner owns the script and hands each bot its next line in turn.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AnnounceRequest = {
  reason: string;
  at: number;
  quiet?: boolean;
  text?: string;
  vars?: Record<string, string>;
};

/** One row of moods.json. `prompt` is backstory, never "you are sad". */
export type MoodEntry = { weight?: number; prompt?: string };

export type AnnouncerParams = {
  requestFile: string;
  linesFile: string;
  /** Weighted mood table. Missing = no moods, plain pools. */
  moodsFile?: string;
  /** Prompt file the gateway injects; `current.json` beside it remembers the roll. */
  moodPromptFile?: string;
  /** A summon after this long rolls a fresh mood instead of keeping the last. */
  moodTtlMs?: number;
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
const DEFAULT_MOOD_TTL_MS = 14 * 60 * 60_000;
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
      const request: AnnounceRequest = {
        reason: String(parsed.reason ?? ""),
        at: Number(parsed.at) || 0,
        quiet: parsed.quiet === true,
      };
      if (typeof parsed.text === "string" && parsed.text.trim()) request.text = parsed.text.trim();
      if (parsed.vars && typeof parsed.vars === "object") {
        request.vars = Object.fromEntries(
          Object.entries(parsed.vars).filter(([, v]) => typeof v === "string") as [string, string][],
        );
      }
      return request;
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
    const chain = reasonChain(request.reason);
    const base = chain[chain.length - 1] ?? "";
    const mood = await this.settleMood(base);
    if (request.quiet) {
      this.params.log?.(`teamspeak announce: '${request.reason}' quiet (empty server)`);
      return;
    }
    const line = request.text ? fill(request.text, request.vars) : await this.choose(chain, mood, request.vars);
    if (!line) {
      this.params.log?.(`teamspeak announce: no lines for '${request.reason}'`);
      return;
    }
    this.params.log?.(`teamspeak announce: ${request.reason}${mood ? ` (mood ${mood})` : ""}: ${line}`);
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

  /**
   * Rolls (shift_start, or a summon with a stale mood) or keeps the mood, and
   * returns its name. Entrance-only: exits leave the mood alone.
   */
  private async settleMood(reason: string): Promise<string | undefined> {
    const { moodsFile, moodPromptFile } = this.params;
    if (!moodsFile || !moodPromptFile || (reason !== "shift_start" && reason !== "summon")) return undefined;
    let moods: Record<string, MoodEntry>;
    try {
      moods = JSON.parse(await readFile(moodsFile, "utf8")) as Record<string, MoodEntry>;
    } catch {
      return undefined;
    }
    const stateFile = join(dirname(moodPromptFile), "current.json");
    const now = (this.params.now ?? Date.now)();
    if (reason === "summon") {
      try {
        const cur = JSON.parse(await readFile(stateFile, "utf8")) as { mood?: string; at?: number };
        const ttl = this.params.moodTtlMs ?? DEFAULT_MOOD_TTL_MS;
        if (cur.mood && moods[cur.mood] && now - Number(cur.at) < ttl) return cur.mood;
      } catch {
        // nothing rolled yet: roll below
      }
    }
    const mood = rollMood(moods, this.params.random ?? Math.random);
    if (!mood) return undefined;
    try {
      await mkdir(dirname(moodPromptFile), { recursive: true });
      await writeFile(moodPromptFile, renderMood(moods[mood]?.prompt));
      await writeFile(stateFile, JSON.stringify({ mood, at: now }) + "\n");
      this.params.log?.(`teamspeak announce: mood for this shift: ${mood}`);
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't write mood: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return mood;
  }

  /** Tagged pools (most specific first), then the mood's, then the plain one. */
  private async choose(chain: string[], mood: string | undefined, vars?: Record<string, string>) {
    const order = [...chain.slice(0, -1), ...(mood ? [`mood:${mood}`] : []), ...chain.slice(-1)];
    for (const key of order) {
      const line = await this.pick(key, vars);
      if (line) return line;
    }
    return undefined;
  }

  private async pick(reason: string, vars?: Record<string, string>): Promise<string | undefined> {
    let pool: unknown;
    try {
      pool = (JSON.parse(await readFile(this.params.linesFile, "utf8")) as Record<string, unknown>)[reason];
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't read ${this.params.linesFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const lines = Array.isArray(pool)
      ? pool
          .filter((l): l is string => typeof l === "string" && l.trim() !== "")
          .map((l) => fill(l, vars))
          .filter((l): l is string => l !== undefined)
      : [];
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

/** `a:b:c` -> [`a:b:c`, `a:b`, `a`]. */
export function reasonChain(reason: string): string[] {
  const parts = reason.split(":");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join(":"));
}

/** Fills `{name}` from vars; undefined if any placeholder is left unfilled. */
export function fill(line: string, vars: Record<string, string> = {}): string | undefined {
  let missing = false;
  const out = line.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (typeof v !== "string" || !v.trim()) missing = true;
    return v ?? "";
  });
  return missing ? undefined : out;
}

/** Weighted pick; weight defaults to 1, zero or negative never comes up. */
export function rollMood(moods: Record<string, MoodEntry>, random: () => number): string | undefined {
  const rows = Object.entries(moods).map(([name, m]) => [name, Math.max(0, Number(m?.weight ?? 1) || 0)] as const);
  const total = rows.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return undefined;
  let r = random() * total;
  for (const [name, w] of rows) {
    if (w > 0 && (r -= w) < 0) return name;
  }
  return rows.filter(([, w]) => w > 0).at(-1)?.[0];
}

export function renderMood(prompt: string | undefined): string {
  const body = prompt?.trim() || "Nothing special about today. Just a regular shift.";
  return [
    "# How today's going",
    "",
    body,
    "",
    "This colours how you come across tonight. It doesn't run the show. Never name the mood or explain it; let it leak through how you talk. If the night gives you a reason to come round, come round.",
    "",
  ].join("\n");
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
