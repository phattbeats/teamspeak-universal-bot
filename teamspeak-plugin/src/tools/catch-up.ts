/**
 * `what_did_i_miss`: read the Sexton's markdown log back for the current channel.
 *
 * The logger bot (sexton/src/main.rs) writes one line per user message to
 * `<logDir>/<channel>/YYYY-MM-DD.md` as `HH:MM  nickname: message`, local time,
 * and nothing else — no joins, no mutes, no system text (#3099's hard rule).
 * So the catch-up is a read of that file, not a second history: whatever the
 * room sees in the channel description is what the Sexton reads aloud.
 *
 * `parseLogLine` mirrors the Rust `parse_log_line` exactly, including its
 * skip-don't-fail behavior on a line that is not in that shape.
 */
import { readFile as readFileFs } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";

export type ChannelLogEntry = {
  /** `HH:MM`, as written. */
  time: string;
  nickname: string;
  text: string;
  /** The rendered line, which is what gets read aloud. */
  line: string;
  /** Local-time timestamp, from the file's date plus `time`. */
  at: Date;
};

export type ChannelLogResult = {
  entries: ChannelLogEntry[];
  lines: string[];
  filesRead: string[];
  skippedLines: number;
};

export type ReadChannelLogParams = {
  logDir: string;
  channelName: string;
  /** Only return messages from the last N minutes. Unset returns the last `limit`. */
  minutes?: number | undefined;
  /** Hard cap on returned entries; the newest win. */
  limit: number;
  now?: Date | undefined;
  readFile?: ((path: string) => Promise<string>) | undefined;
};

export type ReadChannelLog = (params: ReadChannelLogParams) => Promise<ChannelLogResult>;

export class ChannelLogError extends Error {}

/**
 * Read today's and yesterday's log. Yesterday is included so a catch-up just
 * after midnight, or a 12-hour window, is not silently empty.
 */
export async function readChannelLog(params: ReadChannelLogParams): Promise<ChannelLogResult> {
  const now = params.now ?? new Date();
  const readFile = params.readFile ?? ((path: string) => readFileFs(path, "utf8"));
  const dir = channelLogDir(params.logDir, params.channelName);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);

  const entries: ChannelLogEntry[] = [];
  const filesRead: string[] = [];
  let skippedLines = 0;
  for (const day of [yesterday, now]) {
    const path = join(dir, `${localDateStamp(day)}.md`);
    let body: string;
    try {
      body = await readFile(path);
    } catch {
      // A missing day is the normal case, and an unreadable one must not turn
      // a catch-up into an error: the caller still reads out what it has.
      continue;
    }
    filesRead.push(path);
    for (const raw of body.split("\n")) {
      if (!raw.trim()) {
        continue;
      }
      const parsed = parseLogLine(raw);
      if (!parsed) {
        skippedLines += 1;
        continue;
      }
      entries.push({ ...parsed, at: atLocalTime(day, parsed.time) });
    }
  }

  const minutes = params.minutes;
  const windowed =
    minutes === undefined
      ? entries
      : entries.filter((entry) => entry.at.getTime() >= now.getTime() - minutes * 60_000);
  const limit = Math.max(1, Math.floor(params.limit));
  const kept = windowed.slice(Math.max(0, windowed.length - limit));
  return {
    entries: kept,
    lines: kept.map((entry) => entry.line),
    filesRead,
    skippedLines,
  };
}

/**
 * `<logDir>/<channel>` — the same join the logger writes with. The channel name
 * comes off the wire from the server, so the result is confined to `logDir`
 * rather than trusted.
 */
export function channelLogDir(logDir: string, channelName: string): string {
  const name = channelName.trim();
  if (!name) {
    throw new ChannelLogError("No channel is joined, so there is no log to read.");
  }
  const root = resolvePath(logDir);
  const dir = resolvePath(join(logDir, name));
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
    throw new ChannelLogError(`Refusing to read a log outside ${logDir}.`);
  }
  return dir;
}

/** `HH:MM  nickname: message` -> parts, or undefined for anything else. */
export function parseLogLine(
  raw: string,
): { time: string; nickname: string; text: string; line: string } | undefined {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const split = line.indexOf("  ");
  if (split < 0) {
    return undefined;
  }
  const time = line.slice(0, split);
  if (!/^\d{2}:\d{2}$/u.test(time)) {
    return undefined;
  }
  const rest = line.slice(split + 2);
  const colon = rest.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  const nickname = rest.slice(0, colon);
  const afterColon = rest.slice(colon + 1);
  const text = afterColon.startsWith(" ") ? afterColon.slice(1) : afterColon;
  return { time, nickname, text, line };
}

function localDateStamp(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function atLocalTime(day: Date, time: string): Date {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}
