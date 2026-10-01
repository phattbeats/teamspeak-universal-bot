import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const DEFAULT_POLL_MS = 1e3;
const DEFAULT_MAX_AGE_MS = 3 * 6e4;
const DEFAULT_MOOD_TTL_MS = 14 * 60 * 6e4;
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
      const request = {
        reason: String(parsed.reason ?? ""),
        at: Number(parsed.at) || 0,
        quiet: parsed.quiet === true
      };
      if (typeof parsed.text === "string" && parsed.text.trim()) request.text = parsed.text.trim();
      if (parsed.vars && typeof parsed.vars === "object") {
        request.vars = Object.fromEntries(
          Object.entries(parsed.vars).filter(([, v]) => typeof v === "string")
        );
      }
      return request;
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
        `teamspeak announce: failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Rolls (shift_start, or a summon with a stale mood) or keeps the mood, and
   * returns its name. Entrance-only: exits leave the mood alone.
   */
  async settleMood(reason) {
    const { moodsFile, moodPromptFile } = this.params;
    if (!moodsFile || !moodPromptFile || reason !== "shift_start" && reason !== "summon") return void 0;
    let moods;
    try {
      moods = JSON.parse(await readFile(moodsFile, "utf8"));
    } catch {
      return void 0;
    }
    const stateFile = join(dirname(moodPromptFile), "current.json");
    const now = (this.params.now ?? Date.now)();
    if (reason === "summon") {
      try {
        const cur = JSON.parse(await readFile(stateFile, "utf8"));
        const ttl = this.params.moodTtlMs ?? DEFAULT_MOOD_TTL_MS;
        if (cur.mood && moods[cur.mood] && now - Number(cur.at) < ttl) return cur.mood;
      } catch {
      }
    }
    const mood = rollMood(moods, this.params.random ?? Math.random);
    if (!mood) return void 0;
    try {
      await mkdir(dirname(moodPromptFile), { recursive: true });
      await writeFile(moodPromptFile, renderMood(moods[mood]?.prompt));
      await writeFile(stateFile, JSON.stringify({ mood, at: now }) + "\n");
      this.params.log?.(`teamspeak announce: mood for this shift: ${mood}`);
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't write mood: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return mood;
  }
  /** Tagged pools (most specific first), then the mood's, then the plain one. */
  async choose(chain, mood, vars) {
    const order = [...chain.slice(0, -1), ...mood ? [`mood:${mood}`] : [], ...chain.slice(-1)];
    for (const key of order) {
      const line = await this.pick(key, vars);
      if (line) return line;
    }
    return void 0;
  }
  async pick(reason, vars) {
    let pool;
    try {
      pool = JSON.parse(await readFile(this.params.linesFile, "utf8"))[reason];
    } catch (error) {
      this.params.log?.(
        `teamspeak announce: can't read ${this.params.linesFile}: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
    const lines = Array.isArray(pool) ? pool.filter((l) => typeof l === "string" && l.trim() !== "").map((l) => fill(l, vars)).filter((l) => l !== void 0) : [];
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
function reasonChain(reason) {
  const parts = reason.split(":");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join(":"));
}
function fill(line, vars = {}) {
  let missing = false;
  const out = line.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name];
    if (typeof v !== "string" || !v.trim()) missing = true;
    return v ?? "";
  });
  return missing ? void 0 : out;
}
function rollMood(moods, random) {
  const rows = Object.entries(moods).map(([name, m]) => [name, Math.max(0, Number(m?.weight ?? 1) || 0)]);
  const total = rows.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return void 0;
  let r = random() * total;
  for (const [name, w] of rows) {
    if (w > 0 && (r -= w) < 0) return name;
  }
  return rows.filter(([, w]) => w > 0).at(-1)?.[0];
}
function renderMood(prompt) {
  const body = prompt?.trim() || "Nothing special about today. Just a regular shift.";
  return [
    "# How today's going",
    "",
    body,
    "",
    "This colours how you come across tonight. It doesn't run the show. Never name the mood or explain it; let it leak through how you talk. If the night gives you a reason to come round, come round.",
    ""
  ].join("\n");
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export {
  Announcer,
  fill,
  reasonChain,
  renderMood,
  rollMood
};
