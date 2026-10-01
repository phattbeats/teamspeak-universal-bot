/**
 * Lexton's villain tools (PHA-3820): `sentence` (timed Bot Jail), `silence`
 * (timed mute), `summon` (a temporary LexCorp Board Room) and `dossier`.
 *
 * The first three change the server, and every change has to undo itself even
 * if the gateway restarts halfway through the timer. So each one is written to
 * `stateFile` as a pending revert *before* the server is touched, and the file,
 * not memory, is the source of truth: a sweeper re-reads it every few seconds
 * and runs whatever is overdue. That also covers a second controller instance
 * in the same gateway (the host may load the plugin more than once), and a
 * restart simply picks the file up again. A revert that can't read the channel
 * tree yet stays on file and is retried on the next sweep.
 *
 * Reverts never yank anyone. Each one re-reads the tree first and only acts if
 * the person is still exactly where Lexton put them (same client, same nick,
 * same channel). Someone who left, or moved themselves out, is left alone.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelInfo, RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";
import type { TeamSpeakVillainConfig } from "../config.js";

export const DEFAULT_VILLAIN_EXEMPT = ["Emily", "miss_shade", "Sexton", "Bexton", "Lexton"];
export const DEFAULT_VILLAIN_EXEMPT_GROUPS = ["Sexton"];
export const DEFAULT_JAIL_CHANNEL_ID = 7;
export const DEFAULT_HOME_CHANNEL = "General Shit";
export const DEFAULT_BOARD_ROOM_NAME = "LexCorp Board Room";
export const MAX_SENTENCE_MINUTES = 10;
export const MIN_SILENCE_SECONDS = 30;
export const MAX_SILENCE_SECONDS = 120;
export const MAX_SUMMON_MINUTES = 10;

const SWEEP_MS = 5_000;
/** Give up on a revert this long past due (the server state is long gone by then). */
const GIVE_UP_AFTER_MS = 60 * 60_000;

export type VillainTarget = { clientId: TeamSpeakClientId; nickname: string; channelId: number };

export type PendingRevert =
  | {
      kind: "jail";
      id: string;
      clientId: TeamSpeakClientId;
      nickname: string;
      jailChannelId: number;
      returnChannelId: number;
      dueAt: number;
    }
  | { kind: "mute"; id: string; clientId: TeamSpeakClientId; nickname: string; dueAt: number }
  | {
      kind: "summon";
      id: string;
      clientId: TeamSpeakClientId;
      nickname: string;
      roomName: string;
      returnChannelId: number;
      homeChannel: string;
      dueAt: number;
    };

export type VillainDeps = {
  listChannels: () => Promise<ChannelInfo[]>;
  moveClient: (clientId: TeamSpeakClientId, channelId: number) => void;
  muteClient: (clientId: TeamSpeakClientId, muted: boolean) => void;
  createChannel: (name: string, parentId?: number) => void;
  /** Move the bot itself, by channel name or numeric id. */
  moveToChannel: (channel: string) => void;
  now?: (() => number) | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  log?: ((message: string) => void) | undefined;
};

type Outcome = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export class VillainController {
  readonly jailChannelId: number;
  readonly homeChannel: string;
  readonly boardRoomName: string;
  private readonly exempt: string[];
  private readonly exemptGroups: string[];
  private readonly inFlight = new Set<string>();
  private seq = 0;
  private sweeper: unknown;

  constructor(
    private readonly config: TeamSpeakVillainConfig,
    private readonly stateFile: string,
    private readonly deps: VillainDeps,
  ) {
    this.jailChannelId = config.jailChannelId ?? DEFAULT_JAIL_CHANNEL_ID;
    this.homeChannel = config.homeChannel ?? DEFAULT_HOME_CHANNEL;
    this.boardRoomName = config.boardRoomName ?? DEFAULT_BOARD_ROOM_NAME;
    this.exempt = (config.exempt ?? DEFAULT_VILLAIN_EXEMPT).map(fold);
    this.exemptGroups = (config.exemptGroups ?? DEFAULT_VILLAIN_EXEMPT_GROUPS).map((g) => g.toLowerCase());
  }

  /** Start the sweeper; anything a previous gateway left on file gets done. */
  start(): void {
    const left = this.load();
    if (left.length > 0) {
      this.deps.log?.(`villain: ${left.length} pending revert(s) on file in ${this.stateFile}`);
    }
    const setTimer =
      this.deps.setTimer ??
      ((fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        timer.unref();
        return timer;
      });
    this.sweeper = setTimer(() => {
      void this.sweep();
    }, SWEEP_MS);
  }

  stop(): void {
    if (this.sweeper !== undefined && !this.deps.setTimer) {
      clearInterval(this.sweeper as ReturnType<typeof setInterval>);
    }
  }

  pendingReverts(): readonly PendingRevert[] {
    return this.load();
  }

  /** Run every overdue revert on file. Exposed for tests. */
  async sweep(): Promise<void> {
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
  exemption(entry: RosterEntry): string | undefined {
    const nick = fold(entry.nickname);
    if (this.exempt.some((name) => name && nick.includes(name))) {
      return `${entry.nickname} is off limits.`;
    }
    if ((entry.serverGroups ?? []).some((g) => this.exemptGroups.includes(g.toLowerCase()))) {
      return `${entry.nickname} is one of the bots.`;
    }
    return undefined;
  }

  sentence(target: VillainTarget, minutes: number): Outcome {
    if (target.channelId === this.jailChannelId) {
      return { ok: false, error: `${target.nickname} is already in Bot Jail.` };
    }
    if (this.busy(target.clientId, "jail") || this.busy(target.clientId, "summon")) {
      return { ok: false, error: `${target.nickname} is already serving a sentence.` };
    }
    const mins = clamp(minutes, 1, MAX_SENTENCE_MINUTES);
    const revert: PendingRevert = {
      kind: "jail",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      jailChannelId: this.jailChannelId,
      returnChannelId: target.channelId,
      dueAt: this.now() + mins * 60_000,
    };
    this.add(revert);
    this.deps.moveClient(target.clientId, this.jailChannelId);
    return { ok: true, nickname: target.nickname, minutes: mins, jailChannelId: this.jailChannelId };
  }

  silence(target: VillainTarget, seconds: number): Outcome {
    if (this.busy(target.clientId, "mute")) {
      return { ok: false, error: `${target.nickname} is already silenced.` };
    }
    const secs = clamp(seconds, MIN_SILENCE_SECONDS, MAX_SILENCE_SECONDS);
    const revert: PendingRevert = {
      kind: "mute",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      dueAt: this.now() + secs * 1_000,
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
  async summon(target: VillainTarget, minutes: number): Promise<Outcome> {
    if (this.load().some((p) => p.kind === "summon")) {
      return { ok: false, error: "The Board Room is already in session." };
    }
    if (this.busy(target.clientId, "jail")) {
      return { ok: false, error: `${target.nickname} is in Bot Jail. One sentence at a time.` };
    }
    const mins = clamp(minutes, 1, MAX_SUMMON_MINUTES);
    const revert: PendingRevert = {
      kind: "summon",
      id: this.nextId(),
      clientId: target.clientId,
      nickname: target.nickname,
      roomName: this.boardRoomName,
      returnChannelId: target.channelId,
      homeChannel: this.homeChannel,
      dueAt: this.now() + mins * 60_000,
    };
    // Persisted first: if the room gets made and we die before the move, the
    // revert still sends Lexton home and the empty room deletes itself.
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

  private async run(revert: PendingRevert): Promise<void> {
    let tree: ChannelInfo[] = [];
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
        // Lexton leaving is what empties the room, so TeamSpeak deletes it.
        this.deps.moveToChannel(revert.homeChannel);
        this.deps.log?.(`villain: board room adjourned for ${revert.nickname}`);
        break;
      }
    }
    this.remove(revert.id);
  }

  private busy(clientId: TeamSpeakClientId, kind: PendingRevert["kind"]): boolean {
    return this.load().some((p) => p.kind === kind && p.clientId === clientId);
  }

  private add(revert: PendingRevert): void {
    this.save([...this.load(), revert]);
  }

  private remove(id: string): void {
    this.save(this.load().filter((p) => p.id !== id));
  }

  private load(): PendingRevert[] {
    return readState(this.stateFile, this.deps.log);
  }

  private save(pending: PendingRevert[]): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`);
      renameSync(tmp, this.stateFile);
    } catch (error) {
      this.deps.log?.(`villain: could not persist pending reverts: ${String(error)}`);
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `${this.now().toString(36)}-${process.pid}-${this.seq}`;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function readState(path: string, log: ((message: string) => void) | undefined): PendingRevert[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingRevert) : [];
  } catch {
    log?.(`villain: ${path} is not valid JSON; ignoring it`);
    return [];
  }
}

function isPendingRevert(value: unknown): value is PendingRevert {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "jail" || v.kind === "mute" || v.kind === "summon") &&
    typeof v.id === "string" &&
    typeof v.clientId === "number" &&
    typeof v.nickname === "string" &&
    typeof v.dueAt === "number"
  );
}

function locate(tree: ChannelInfo[], clientId: TeamSpeakClientId, nickname: string): ChannelInfo | undefined {
  // Same client id *and* nick: an id TeamSpeak has since reused for someone
  // else must not get moved.
  return tree.find((channel) =>
    channel.occupants.some((entry) => entry.clientId === clientId && entry.nickname === nickname),
  );
}

function findChannel(tree: ChannelInfo[], name: string): ChannelInfo | undefined {
  const wanted = name.trim().toLowerCase();
  return tree.find((channel) => channel.name.trim().toLowerCase() === wanted);
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

// --- dossier ------------------------------------------------------------------

export type DossierLine = { at: string; lane: string; text: string };

export type DossierHistory = { lines: DossierLine[]; firstSeen: string | undefined; total: number };

/**
 * Everything this bot has heard from one person, out of its own transcript
 * (`openclaw-agent.sqlite`, `transcript_events`). User turns arrive prefixed
 * `[teamspeak voice] <nick> said:` / `[teamspeak channel] <nick> wrote:` /
 * `[teamspeak private message] <nick> wrote:`, so speaker and lane come free.
 * Opened read-only per call; the gateway owns the file.
 */
export async function readTranscriptHistory(
  dbPath: string,
  nickname: string,
  limit: number,
): Promise<DossierHistory> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("select created_at, event_json from transcript_events where event_json like ? order by created_at")
      .all(`%${nickname.replace(/[%_]/gu, "")}%`) as Array<{ created_at: number; event_json: string }>;
    const wanted = nickname.trim().toLowerCase();
    const hits: DossierLine[] = [];
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

export function parseTranscriptUserLine(
  eventJson: string,
): { lane: string; nickname: string; text: string } | undefined {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return undefined;
  }
  const message = (event as { type?: unknown; message?: { role?: unknown; content?: unknown } }).message;
  if ((event as { type?: unknown }).type !== "message" || message?.role !== "user") {
    return undefined;
  }
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part?.text === "string" ? (part.text as string) : ""))
            .join("\n")
        : "";
  for (const line of text.split("\n")) {
    const match = USER_LINE.exec(line.trim());
    if (match) {
      return { lane: match[1]!, nickname: match[2]!, text: match[3]!.trim() };
    }
  }
  return undefined;
}
