import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const DEFAULT_VILLAIN_EXEMPT = ["Emily", "miss_shade", "Sexton", "Bexton", "Lexton"];
const DEFAULT_VILLAIN_EXEMPT_GROUPS = ["Sexton"];
const DEFAULT_JAIL_CHANNEL_ID = 7;
const DEFAULT_HOME_CHANNEL = "General Shit";
const DEFAULT_BOARD_ROOM_NAME = "LexCorp Board Room";
const MAX_SENTENCE_MINUTES = 10;
const MIN_SILENCE_SECONDS = 30;
const MAX_SILENCE_SECONDS = 120;
const MAX_SUMMON_MINUTES = 10;
const SWEEP_MS = 5e3;
const GIVE_UP_AFTER_MS = 60 * 6e4;
class VillainController {
  constructor(config, stateFile, deps) {
    this.config = config;
    this.stateFile = stateFile;
    this.deps = deps;
    this.jailChannelId = config.jailChannelId ?? DEFAULT_JAIL_CHANNEL_ID;
    this.homeChannel = config.homeChannel ?? DEFAULT_HOME_CHANNEL;
    this.boardRoomName = config.boardRoomName ?? DEFAULT_BOARD_ROOM_NAME;
    this.exempt = (config.exempt ?? DEFAULT_VILLAIN_EXEMPT).map(fold);
    this.exemptGroups = (config.exemptGroups ?? DEFAULT_VILLAIN_EXEMPT_GROUPS).map((g) => g.toLowerCase());
  }
  config;
  stateFile;
  deps;
  jailChannelId;
  homeChannel;
  boardRoomName;
  exempt;
  exemptGroups;
  inFlight = /* @__PURE__ */ new Set();
  seq = 0;
  sweeper;
  /** Start the sweeper; anything a previous gateway left on file gets done. */
  start() {
    const left = this.load();
    if (left.length > 0) {
      this.deps.log?.(`villain: ${left.length} pending revert(s) on file in ${this.stateFile}`);
    }
    const setTimer = this.deps.setTimer ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return timer;
    });
    this.sweeper = setTimer(() => {
      void this.sweep();
    }, SWEEP_MS);
  }
  stop() {
    if (this.sweeper !== void 0 && !this.deps.setTimer) {
      clearInterval(this.sweeper);
    }
  }
  pendingReverts() {
    return this.load();
  }
  /** Run every overdue revert on file. Exposed for tests. */
  async sweep() {
    const now = this.now();
    for (const revert of this.load()) {
      if (revert.dueAt <= now && !this.inFlight.has(revert.id)) {
        this.inFlight.add(revert.id);
        try {
          await this.run(revert);
        } catch (error) {
          this.deps.log?.(`villain: ${revert.kind} revert for ${revert.nickname} failed: ${String(error)}`);
        } finally {
          this.inFlight.delete(revert.id);
        }
      }
    }
  }
  /** Why this person can't be touched, or undefined if they can. */
  exemption(entry) {
    const nick = fold(entry.nickname);
    if (this.exempt.some((name) => name && nick.includes(name))) {
      return `${entry.nickname} is off limits.`;
    }
    if ((entry.serverGroups ?? []).some((g) => this.exemptGroups.includes(g.toLowerCase()))) {
      return `${entry.nickname} is one of the bots.`;
    }
    return void 0;
  }
  sentence(target, minutes) {
    if (target.channelId === this.jailChannelId) {
      return { ok: false, error: `${target.nickname} is already in Bot Jail.` };
    }
    if (this.busy(target.clientId, "jail") || this.busy(target.clientId, "summon")) {
      return { ok: false, error: `${target.nickname} is already serving a sentence.` };
    }
    const mins = clamp(minutes, 1, MAX_SENTENCE_MINUTES);
    const revert = {
      kind: "jail",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      jailChannelId: this.jailChannelId,
      returnChannelId: target.channelId,
      dueAt: this.now() + mins * 6e4
    };
    this.add(revert);
    this.deps.moveClient(target.clientId, this.jailChannelId);
    return { ok: true, nickname: target.nickname, minutes: mins, jailChannelId: this.jailChannelId };
  }
  silence(target, seconds) {
    if (this.busy(target.clientId, "mute")) {
      return { ok: false, error: `${target.nickname} is already silenced.` };
    }
    const secs = clamp(seconds, MIN_SILENCE_SECONDS, MAX_SILENCE_SECONDS);
    const revert = {
      kind: "mute",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      dueAt: this.now() + secs * 1e3
    };
    this.add(revert);
    this.deps.muteClient(target.clientId, true);
    return { ok: true, nickname: target.nickname, seconds: secs };
  }
  /**
   * Create the Board Room (the core creates channels with no permanence flag,
   * which TeamSpeak makes *temporary*: it deletes itself once empty), wait for
   * it to show up in the tree, then pull the target and Lexton in.
   */
  async summon(target, minutes) {
    if (this.load().some((p) => p.kind === "summon")) {
      return { ok: false, error: "The Board Room is already in session." };
    }
    if (this.busy(target.clientId, "jail")) {
      return { ok: false, error: `${target.nickname} is in Bot Jail. One sentence at a time.` };
    }
    const mins = clamp(minutes, 1, MAX_SUMMON_MINUTES);
    const revert = {
      kind: "summon",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      roomName: this.boardRoomName,
      returnChannelId: target.channelId,
      homeChannel: this.homeChannel,
      dueAt: this.now() + mins * 6e4
    };
    this.add(revert);
    let room = findChannel(await this.deps.listChannels(), this.boardRoomName);
    if (!room) {
      this.deps.createChannel(this.boardRoomName);
      for (let attempt = 0; attempt < 10 && !room; attempt += 1) {
        await this.sleep(500);
        room = findChannel(await this.deps.listChannels(), this.boardRoomName);
      }
    }
    if (!room) {
      this.remove(revert.id);
      this.deps.moveToChannel(this.homeChannel);
      return { ok: false, error: "The Board Room didn't open. The server refused to build it." };
    }
    this.deps.moveToChannel(String(room.channelId));
    this.deps.moveClient(target.clientId, room.channelId);
    return { ok: true, nickname: target.nickname, room: room.name, channelId: room.channelId, minutes: mins };
  }
  async run(revert) {
    let tree = [];
    try {
      tree = await this.deps.listChannels();
    } catch {
      tree = [];
    }
    if (tree.length === 0) {
      if (this.now() - revert.dueAt > GIVE_UP_AFTER_MS) {
        this.deps.log?.(`villain: giving up on ${revert.kind} revert for ${revert.nickname} (no channel tree)`);
        this.remove(revert.id);
      } else {
        this.deps.log?.(`villain: no channel tree for ${revert.kind} revert of ${revert.nickname}; retrying`);
      }
      return;
    }
    const where = locate(tree, revert.clientId, revert.nickname);
    switch (revert.kind) {
      case "jail":
        if (where?.channelId === revert.jailChannelId) {
          this.deps.moveClient(revert.clientId, revert.returnChannelId);
          this.deps.log?.(`villain: released ${revert.nickname} from jail to ${revert.returnChannelId}`);
        } else {
          this.deps.log?.(`villain: ${revert.nickname} left jail on their own; not moving them`);
        }
        break;
      case "mute":
        if (where) {
          this.deps.muteClient(revert.clientId, false);
          this.deps.log?.(`villain: unmuted ${revert.nickname}`);
        }
        break;
      case "summon": {
        const room = findChannel(tree, revert.roomName);
        if (room && where?.channelId === room.channelId) {
          this.deps.moveClient(revert.clientId, revert.returnChannelId);
        }
        this.deps.moveToChannel(revert.homeChannel);
        this.deps.log?.(`villain: board room adjourned for ${revert.nickname}`);
        break;
      }
    }
    this.remove(revert.id);
  }
  busy(clientId, kind) {
    return this.load().some((p) => p.kind === kind && p.clientId === clientId);
  }
  add(revert) {
    this.save([...this.load(), revert]);
  }
  remove(id) {
    this.save(this.load().filter((p) => p.id !== id));
  }
  load() {
    return readState(this.stateFile, this.deps.log);
  }
  save(pending) {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}
`);
      renameSync(tmp, this.stateFile);
    } catch (error) {
      this.deps.log?.(`villain: could not persist pending reverts: ${String(error)}`);
    }
  }
  nextId() {
    this.seq += 1;
    return `${this.now().toString(36)}-${process.pid}-${this.seq}`;
  }
  now() {
    return this.deps.now?.() ?? Date.now();
  }
  sleep(ms) {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
function readState(path, log) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingRevert) : [];
  } catch {
    log?.(`villain: ${path} is not valid JSON; ignoring it`);
    return [];
  }
}
function isPendingRevert(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value;
  return (v.kind === "jail" || v.kind === "mute" || v.kind === "summon") && typeof v.id === "string" && typeof v.clientId === "number" && typeof v.nickname === "string" && typeof v.dueAt === "number";
}
function locate(tree, clientId, nickname) {
  return tree.find(
    (channel) => channel.occupants.some((entry) => entry.clientId === clientId && entry.nickname === nickname)
  );
}
function findChannel(tree, name) {
  const wanted = name.trim().toLowerCase();
  return tree.find((channel) => channel.name.trim().toLowerCase() === wanted);
}
function fold(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}
function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
async function readTranscriptHistory(dbPath, nickname, limit) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("select created_at, event_json from transcript_events where event_json like ? order by created_at").all(`%${nickname.replace(/[%_]/gu, "")}%`);
    const wanted = nickname.trim().toLowerCase();
    const hits = [];
    for (const row of rows) {
      const said = parseTranscriptUserLine(row.event_json);
      if (said && said.nickname.toLowerCase() === wanted) {
        hits.push({ at: new Date(row.created_at).toISOString(), lane: said.lane, text: said.text });
      }
    }
    return { lines: hits.slice(-limit), firstSeen: hits[0]?.at, total: hits.length };
  } finally {
    db.close();
  }
}
const USER_LINE = /^\[teamspeak (voice|channel|private message)\] (.+?) (?:said|wrote): ([\s\S]*)$/u;
function parseTranscriptUserLine(eventJson) {
  let event;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return void 0;
  }
  const message = event.message;
  if (event.type !== "message" || message?.role !== "user") {
    return void 0;
  }
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
  for (const line of text.split("\n")) {
    const match = USER_LINE.exec(line.trim());
    if (match) {
      return { lane: match[1], nickname: match[2], text: match[3].trim() };
    }
  }
  return void 0;
}
export {
  DEFAULT_BOARD_ROOM_NAME,
  DEFAULT_HOME_CHANNEL,
  DEFAULT_JAIL_CHANNEL_ID,
  DEFAULT_VILLAIN_EXEMPT,
  DEFAULT_VILLAIN_EXEMPT_GROUPS,
  MAX_SENTENCE_MINUTES,
  MAX_SILENCE_SECONDS,
  MAX_SUMMON_MINUTES,
  MIN_SILENCE_SECONDS,
  VillainController,
  parseTranscriptUserLine,
  readTranscriptHistory
};
