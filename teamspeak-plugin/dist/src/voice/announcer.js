import { readFile, unlink } from "node:fs/promises";
const DEFAULT_POLL_MS = 1e3;
const DEFAULT_MAX_AGE_MS = 3 * 6e4;
const TAIL_MS = 400;
class Announcer {
  constructor(params) {
    this.params = params;
  }
  params;
  timer;
  busy = false;
  /** Last index used per reason, so the same line never plays twice running. */
  last = /* @__PURE__ */ new Map();
  start() {
    this.timer ??= setInterval(() => void this.tick(), this.params.pollMs ?? DEFAULT_POLL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
  }
  /** One poll. Exposed for tests. */
  async tick() {
    if (this.busy || !this.params.isReady()) return;
    this.busy = true;
    try {
      const request = await this.readRequest();
      if (!request) return;
      try {
        await this.announce(request);
      } finally {
        await unlink(this.params.requestFile).catch(() => void 0);
      }
    } finally {
      this.busy = false;
    }
  }
  async readRequest() {
    let raw;
    try {
      raw = await readFile(this.params.requestFile, "utf8");
    } catch {
      return void 0;
    }
    try {
      const parsed = JSON.parse(raw);
      return { reason: String(parsed.reason ?? ""), at: Number(parsed.at) || 0 };
    } catch {
      return { reason: "", at: 0 };
    }
  }
  async announce(request) {
    const now = this.params.now ?? Date.now;
    const age = now() - request.at;
    if (age > (this.params.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
      this.params.log?.(`teamspeak announce: dropped stale '${request.reason}' (${Math.round(age / 1e3)}s old)`);
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
        `teamspeak announce: failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async pick(reason) {
    let pool;
    try {
      pool = JSON.parse(await readFile(this.params.linesFile, "utf8"))[reason];
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't read ${this.params.linesFile}: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
    const lines = Array.isArray(pool) ? pool.filter((l) => typeof l === "string" && l.trim() !== "") : [];
    if (!lines.length) return void 0;
    const prev = this.last.get(reason);
    const random = this.params.random ?? Math.random;
    let i = Math.floor(random() * lines.length);
    if (lines.length > 1 && i === prev) {
      i = (i + 1 + Math.floor(random() * (lines.length - 1))) % lines.length;
    }
    this.last.set(reason, i);
    return lines[i];
  }
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export {
  Announcer
};
