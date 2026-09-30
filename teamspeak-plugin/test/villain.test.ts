/**
 * Lexton's villain tools (PHA-3820). The part that matters most is that every
 * server change undoes itself, including across a gateway restart, and never
 * yanks someone who has since moved on. Timers are driven by hand.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelInfo, RosterEntry } from "../src/bridge/protocol.js";
import {
  DOSSIER_TOOL,
  KICK_CLIENT_TOOL,
  runTeamSpeakTool,
  SENTENCE_TOOL,
  SILENCE_TOOL,
  SUMMON_TOOL,
  type TeamSpeakToolDeps,
} from "../src/tools/registry.js";
import { parseTranscriptUserLine, readTranscriptHistory, VillainController } from "../src/tools/villain.js";

const person = (clientId: number, nickname: string, serverGroups = ["Normal"]): RosterEntry => ({
  clientId,
  nickname,
  muted: false,
  away: false,
  serverGroups,
});

function world() {
  const tree: ChannelInfo[] = [
    { channelId: 1, name: "General Shit", occupants: [person(10, "ty-c"), person(11, "Emily"), person(12, "Bexton", ["Sexton"]), person(99, "Lexton")] },
    { channelId: 7, name: "Bot Jail", occupants: [] },
  ];
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = 1_000_000;
  const where = (id: number) => tree.find((c) => c.occupants.some((o) => o.clientId === id));
  const move = (id: number, channelId: number) => {
    const from = where(id);
    const to = tree.find((c) => c.channelId === channelId);
    if (!from || !to) return;
    const entry = from.occupants.find((o) => o.clientId === id)!;
    from.occupants = from.occupants.filter((o) => o.clientId !== id);
    to.occupants.push(entry);
  };
  const deps = {
    listChannels: async () => tree,
    moveClient: (id: number, ch: number) => {
      calls.push(`move ${id}->${ch}`);
      move(id, ch);
    },
    muteClient: (id: number, muted: boolean) => calls.push(`${muted ? "mute" : "unmute"} ${id}`),
    createChannel: (name: string) => {
      calls.push(`create ${name}`);
      tree.push({ channelId: 50, name, occupants: [] });
    },
    moveToChannel: (channel: string) => {
      calls.push(`self->${channel}`);
      const target = tree.find((c) => String(c.channelId) === channel || c.name === channel);
      if (target) move(99, target.channelId);
    },
    now: () => now,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    sleep: async () => {},
  };
  const stateFile = join(mkdtempSync(join(tmpdir(), "villain-")), "pending.json");
  const advance = (ms: number) => {
    now += ms;
  };
  const fire = async (controller: VillainController) => {
    now += 11 * 60_000;
    await controller.sweep();
  };
  return { tree, calls, timers, deps, stateFile, fire, advance, move, where };
}

function toolDeps(w: ReturnType<typeof world>, villain: VillainController): TeamSpeakToolDeps {
  const noop = () => {};
  return {
    config: { villain: { enabled: true }, moderation: { kick: false, allowGroups: ["Normal"] } },
    music: undefined,
    roster: () => w.tree[0]!.occupants,
    channelName: () => "General Shit",
    poke: noop,
    sendText: noop,
    setParked: noop,
    isParked: () => false,
    kickClient: noop,
    banClient: noop,
    banDel: noop,
    banList: noop,
    moveClient: w.deps.moveClient,
    muteClient: w.deps.muteClient,
    editChannel: noop,
    createChannel: w.deps.createChannel,
    deleteChannel: noop,
    editServer: noop,
    addToServerGroup: noop,
    listChannels: w.deps.listChannels,
    moveToChannel: w.deps.moveToChannel,
    villain,
    readHistory: async () => ({ lines: [{ at: "t", lane: "voice", text: "hi" }], firstSeen: "t0", total: 1 }),
    logDir: "/nowhere",
  };
}

const call = (deps: TeamSpeakToolDeps, name: string, args: Record<string, unknown>) =>
  runTeamSpeakTool(deps, { itemId: "i", callId: "c", name, args }, { clientId: -1, nickname: "someone" });

describe("villain tools", () => {
  it("jails, then returns them to where they came from", async () => {
    const w = world();
    const v = new VillainController({}, w.stateFile, w.deps);
    const r = await call(toolDeps(w, v), SENTENCE_TOOL, { nickname: "ty-c", minutes: 99 });
    expect(r).toMatchObject({ ok: true, minutes: 10 });
    expect(w.where(10)?.channelId).toBe(7);
    expect(JSON.parse(readFileSync(w.stateFile, "utf8"))).toHaveLength(1);
    await v.sweep();
    expect(w.where(10)?.channelId).toBe(7); // not due yet
    await w.fire(v);
    expect(w.where(10)?.channelId).toBe(1);
    expect(JSON.parse(readFileSync(w.stateFile, "utf8"))).toEqual([]);
  });

  it("does not yank someone who already left jail", async () => {
    const w = world();
    const v = new VillainController({}, w.stateFile, w.deps);
    await call(toolDeps(w, v), SENTENCE_TOOL, { nickname: "ty-c" });
    w.move(10, 1);
    w.calls.length = 0;
    await w.fire(v);
    expect(w.calls).toEqual([]);
  });

  it("finishes the revert after a gateway restart", async () => {
    const w = world();
    const first = new VillainController({}, w.stateFile, w.deps);
    await call(toolDeps(w, first), SENTENCE_TOOL, { nickname: "ty-c", minutes: 1 });
    await call(toolDeps(w, first), SILENCE_TOOL, { nickname: "ty-c", seconds: 5 });
    // The old gateway died; a new controller only has the file.
    const second = new VillainController({}, w.stateFile, w.deps);
    second.start();
    expect(w.timers.at(-1)?.ms).toBe(5_000);
    expect(second.pendingReverts()).toHaveLength(2);
    await w.fire(second);
    expect(w.where(10)?.channelId).toBe(1);
    expect(w.calls).toContain("unmute 10");
    expect(second.pendingReverts()).toEqual([]);
  });

  it("refuses Emily and the bots", async () => {
    const w = world();
    const deps = toolDeps(w, new VillainController({}, w.stateFile, w.deps));
    expect(await call(deps, SENTENCE_TOOL, { nickname: "Emily" })).toMatchObject({ ok: false });
    expect(await call(deps, SILENCE_TOOL, { nickname: "Bexton" })).toMatchObject({ ok: false });
    expect(w.calls).toEqual([]);
  });

  it("clamps silence to 30-120s and unmutes", async () => {
    const w = world();
    const deps = toolDeps(w, new VillainController({}, w.stateFile, w.deps));
    expect(await call(deps, SILENCE_TOOL, { nickname: "ty-c", seconds: 5 })).toMatchObject({ ok: true, seconds: 30 });
    const v = deps.villain!;
    expect(v.pendingReverts()[0]!.dueAt).toBe(1_000_000 + 30_000);
    await w.fire(v);
    expect(w.calls).toEqual(["mute 10", "unmute 10"]);
  });

  it("summons into a temporary board room and adjourns", async () => {
    const w = world();
    const deps = toolDeps(w, new VillainController({}, w.stateFile, w.deps));
    expect(await call(deps, SUMMON_TOOL, { nickname: "ty-c" })).toMatchObject({ ok: true, room: "LexCorp Board Room" });
    expect(w.where(10)?.channelId).toBe(50);
    expect(w.where(99)?.channelId).toBe(50);
    await w.fire(deps.villain!);
    expect(w.where(10)?.channelId).toBe(1);
    expect(w.calls.at(-1)).toBe("self->General Shit");
  });

  it("returns a dossier", async () => {
    const w = world();
    const deps = toolDeps(w, new VillainController({}, w.stateFile, w.deps));
    expect(await call(deps, DOSSIER_TOOL, { nickname: "ty" })).toMatchObject({
      ok: true,
      nickname: "ty-c",
      channel: "General Shit",
      firstSeen: "t0",
      linesOnFile: 1,
    });
  });

  it("gates moderation tools on their flag at dispatch", async () => {
    const w = world();
    const deps = toolDeps(w, new VillainController({}, w.stateFile, w.deps));
    expect(await call(deps, KICK_CLIENT_TOOL, { nickname: "ty-c" })).toMatchObject({
      ok: false,
      error: "That moderation tool is not enabled here.",
    });
  });
});

describe("dossier transcript", () => {
  it("parses speaker-tagged user turns", () => {
    const row = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "[teamspeak voice] ty-c said: Lexton you fraud" }] } });
    expect(parseTranscriptUserLine(row)).toEqual({ lane: "voice", nickname: "ty-c", text: "Lexton you fraud" });
    expect(parseTranscriptUserLine(JSON.stringify({ type: "message", message: { role: "assistant", content: "x" } }))).toBeUndefined();
  });

  it("reads history and first-seen from the sqlite transcript", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(mkdtempSync(join(tmpdir(), "dossier-")), "t.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table transcript_events (session_id text, seq int, event_json text, created_at int)");
    const ins = db.prepare("insert into transcript_events values ('s', ?, ?, ?)");
    const line = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
    ins.run(1, line("[teamspeak voice] ty-c said: first"), 1_000);
    ins.run(2, line("[teamspeak channel] kyleonrye wrote: not me"), 2_000);
    ins.run(3, line("[teamspeak channel] ty-c wrote: second"), 3_000);
    db.close();
    const history = await readTranscriptHistory(path, "ty-c", 1);
    expect(history.total).toBe(2);
    expect(history.firstSeen).toBe(new Date(1_000).toISOString());
    expect(history.lines).toEqual([{ at: new Date(3_000).toISOString(), lane: "channel", text: "second" }]);
  });
});
