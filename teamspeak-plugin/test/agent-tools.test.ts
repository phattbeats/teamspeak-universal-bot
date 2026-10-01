/**
 * The channel tools as agent tools (PHA-3428 item 4).
 *
 * The realtime lane's half of these is covered by `voice-runtime-tools.test.ts`,
 * which enters at the registration the speaker sessions hold. This file enters
 * at the other face — the tool `execute` the host calls during an agent turn —
 * and proves the three things that face has to get right: the turn context
 * reaches the tool, two concurrent turns do not read each other's speaker, and
 * a call with no connected channel fails in words rather than throwing.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamSpeakAgentTools, TEAMSPEAK_AGENT_TOOL_NAMES } from "../src/tools/agent-tools.js";
import {
  clearTeamSpeakToolAccess,
  registerTeamSpeakToolAccess,
  resolveTeamSpeakToolAccess,
  runWithTeamSpeakTurnContext,
  unregisterTeamSpeakToolAccess,
  type TeamSpeakToolAccess,
} from "../src/tools/turn-context.js";

type Call = { name: string; args: Record<string, unknown>; clientId: number; nickname: string };

/** An access that records what it was asked to do, with a controllable delay. */
function recordingAccess(calls: Call[], delayMs = 0): TeamSpeakToolAccess {
  return {
    run: async (name, args, context) => {
      calls.push({ name, args, clientId: context.clientId, nickname: context.nickname });
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return { ok: true, name, sawClientId: context.clientId, sawNickname: context.nickname };
    },
  };
}

/** Tool results come back as a text content block wrapping the JSON payload. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function toolNamed(name: string) {
  const tool = createTeamSpeakAgentTools().find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`no agent tool named ${name}`);
  }
  return tool;
}

afterEach(() => {
  clearTeamSpeakToolAccess();
});

describe("teamspeak agent tools", () => {
  it("registers exactly the tools the manifest declares", () => {
    // The host refuses the whole registration when a registered name is not in
    // `contracts.tools`, so this list and openclaw.plugin.json must not drift.
    // PHA-3820: moderation and villain tools are on this face too, so check
    // against the manifest rather than restating 40 names.
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts: { tools: string[] };
    };
    expect(manifest.contracts.tools).toEqual(expect.arrayContaining([...TEAMSPEAK_AGENT_TOOL_NAMES]));
    expect(TEAMSPEAK_AGENT_TOOL_NAMES).toEqual(expect.arrayContaining(["kick_client", "sentence", "dossier"]));
  });

  it("offers the music tools even though the runtime may not have music", () => {
    // Whether music works is a runtime property that can change after the
    // gateway starts; the tools answer for themselves rather than vanishing.
    const names = createTeamSpeakAgentTools().map((tool) => tool.name);
    expect(names).toContain("play_music");
  });

  it("carries the speaking client through to the tool", async () => {
    const calls: Call[] = [];
    registerTeamSpeakToolAccess("default", recordingAccess(calls));
    const result = await runWithTeamSpeakTurnContext(
      { accountId: "default", clientId: 42, nickname: "Brandon" },
      () => toolNamed("poke").execute("call-1", { nickname: "Sexton", text: "oi" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "poke", clientId: 42, nickname: "Brandon" });
    expect(payloadOf(result)).toMatchObject({ ok: true, sawClientId: 42 });
  });

  it("accepts arguments as a JSON string, the way some providers send them", async () => {
    const calls: Call[] = [];
    registerTeamSpeakToolAccess("default", recordingAccess(calls));
    await runWithTeamSpeakTurnContext(
      { accountId: "default", clientId: 1, nickname: "A" },
      () => toolNamed("set_volume").execute("call-1", '{"volume":0.4}'),
    );
    expect(calls[0]?.args).toEqual({ volume: 0.4 });
  });

  it("keeps two concurrent turns from reading each other's speaker", async () => {
    // The reason the turn context is an AsyncLocalStorage and not a module
    // field: the lanes gate one turn per speaker, not one globally.
    const calls: Call[] = [];
    registerTeamSpeakToolAccess("default", recordingAccess(calls, 20));
    const [first, second] = await Promise.all([
      runWithTeamSpeakTurnContext({ accountId: "default", clientId: 7, nickname: "Alice" }, () =>
        toolNamed("who_is_here").execute("call-a", {}),
      ),
      runWithTeamSpeakTurnContext({ accountId: "default", clientId: 9, nickname: "Bob" }, () =>
        toolNamed("who_is_here").execute("call-b", {}),
      ),
    ]);
    expect(payloadOf(first)).toMatchObject({ sawClientId: 7, sawNickname: "Alice" });
    expect(payloadOf(second)).toMatchObject({ sawClientId: 9, sawNickname: "Bob" });
  });

  it("answers in words when no channel is connected", async () => {
    const logs: string[] = [];
    const tool = createTeamSpeakAgentTools({ log: (message) => logs.push(message) }).find(
      (entry) => entry.name === "who_is_here",
    )!;
    const payload = payloadOf(await tool.execute("call-1", {}));
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("Not connected");
    expect(logs.join("\n")).toContain("no connected channel");
  });

  it("falls back to the only connected account when a call has no turn context", async () => {
    const calls: Call[] = [];
    registerTeamSpeakToolAccess("default", recordingAccess(calls));
    await toolNamed("who_is_here").execute("call-1", {});
    expect(calls).toHaveLength(1);
    // No context means nobody asked, so "poke me" cannot resolve to a person.
    expect(calls[0]?.clientId).toBe(-1);
  });

  it("refuses to guess when several accounts are connected and there is no context", async () => {
    registerTeamSpeakToolAccess("a", recordingAccess([]));
    registerTeamSpeakToolAccess("b", recordingAccess([]));
    expect(resolveTeamSpeakToolAccess()).toBeUndefined();
    expect(resolveTeamSpeakToolAccess("b")).toBeDefined();
  });

  it("does not let a stopping runtime withdraw its replacement", () => {
    // A reconnecting account registers the new access before the old one's
    // stop() lands; an unconditional delete there would strand the account.
    const old = recordingAccess([]);
    const replacement = recordingAccess([]);
    registerTeamSpeakToolAccess("default", old);
    registerTeamSpeakToolAccess("default", replacement);
    unregisterTeamSpeakToolAccess("default", old);
    expect(resolveTeamSpeakToolAccess("default")).toBe(replacement);
    unregisterTeamSpeakToolAccess("default", replacement);
    expect(resolveTeamSpeakToolAccess("default")).toBeUndefined();
  });
});
