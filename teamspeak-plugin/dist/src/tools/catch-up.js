import { readFile as readFileFs } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
class ChannelLogError extends Error {
}
async function readChannelLog(params) {
  const now = params.now ?? /* @__PURE__ */ new Date();
  const readFile = params.readFile ?? ((path) => readFileFs(path, "utf8"));
  const dir = channelLogDir(params.logDir, params.channelName);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1e3);
  const entries = [];
  const filesRead = [];
  let skippedLines = 0;
  for (const day of [yesterday, now]) {
    const path = join(dir, `${localDateStamp(day)}.md`);
    let body;
    try {
      body = await readFile(path);
    } catch {
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
  const windowed = minutes === void 0 ? entries : entries.filter((entry) => entry.at.getTime() >= now.getTime() - minutes * 6e4);
  const limit = Math.max(1, Math.floor(params.limit));
  const kept = windowed.slice(Math.max(0, windowed.length - limit));
  return {
    entries: kept,
    lines: kept.map((entry) => entry.line),
    filesRead,
    skippedLines
  };
}
function channelLogDir(logDir, channelName) {
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
function parseLogLine(raw) {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const split = line.indexOf("  ");
  if (split < 0) {
    return void 0;
  }
  const time = line.slice(0, split);
  if (!/^\d{2}:\d{2}$/u.test(time)) {
    return void 0;
  }
  const rest = line.slice(split + 2);
  const colon = rest.indexOf(":");
  if (colon <= 0) {
    return void 0;
  }
  const nickname = rest.slice(0, colon);
  const afterColon = rest.slice(colon + 1);
  const text = afterColon.startsWith(" ") ? afterColon.slice(1) : afterColon;
  return { time, nickname, text, line };
}
function localDateStamp(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
function atLocalTime(day, time) {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}
export {
  ChannelLogError,
  channelLogDir,
  parseLogLine,
  readChannelLog
};
