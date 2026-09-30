/**
 * The voice agent turn's two host entry points (PHA-3792).
 *
 * The streaming path is asserted on what it hands the host (the finalized
 * context, the forced block-streaming switch, the per-turn config copy) and
 * on what it does with what comes back (blocks spoken as they land, a final
 * that repeats them not spoken twice, a final that does not repeat them
 * spoken). The ingress path is asserted to be exactly what it was before.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildVoiceTurnConfig,
  createTeamSpeakAgentTurn,
  VOICE_BLOCK_STREAMING_CHUNK,
  VOICE_BLOCK_STREAMING_COALESCE,
  type TeamSpeakReplyPayload,
  type TeamSpeakReplyRuntime,
} from "../src/voice/agent-turn.js";

type Delivery = (payload: TeamSpeakReplyPayload, info: { kind: string }) => Promise<void> | void;

type FakeReply = TeamSpeakReplyRuntime & {
  calls: Array<Parameters<TeamSpeakReplyRuntime["dispatchReplyWithBufferedBlockDispatcher"]>[0]>;
  finalized: Record<string, unknown>[];
};

/** A host whose model "generates" the given deliveries in order. */
function fakeReply(
  script: (deliver: Delivery) => Promise<void>,
): FakeReply {
  const reply: FakeReply = {
    calls: [],
    finalized: [],
    finalizeInboundContext(ctx) {
      reply.finalized.push(ctx);
      return { ...ctx, __finalized: true };
    },
    async dispatchReplyWithBufferedBlockDispatcher(params) {
      reply.calls.push(params);
      await script(params.dispatcherOptions.deliver.bind(params.dispatcherOptions));
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    },
  };
  return reply;
}

const cfg = {
  agents: { defaults: { thinkingDefault: "medium", model: { primary: "litellm/minimax/MiniMax-M3" } } },
  channels: { teamspeak: { bridgeUrl: "ws://x" } },
} as unknown as OpenClawConfig;

const utterance = { clientId: 7, nickname: "phatt", message: "what did I miss" };

describe("createTeamSpeakAgentTurn (block stream)", () => {
  it("hands blocks to onBlock as they arrive and returns the joined reply", async () => {
    const reply = fakeReply(async (deliver) => {
      await deliver({ text: "First sentence lands." }, { kind: "block" });
      await deliver({ text: "Second sentence lands." }, { kind: "block" });
      // A tool progress line has no business on a voice line.
      await deliver({ text: "[tool] did a thing" }, { kind: "tool" });
    });
    const agent = { runCommandFromIngress: async () => ({ payloads: [] }) };
    const turn = createTeamSpeakAgentTurn({
      agent,
      reply,
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "agent:sexton:teamspeak:default",
      thinking: "off",
      now: () => 1_000,
    });

    const blocks: string[] = [];
    const result = await turn(utterance, { onBlock: (text) => blocks.push(text) });

    expect(blocks).toEqual(["First sentence lands.", "Second sentence lands."]);
    expect(result).toEqual({
      text: "First sentence lands.\nSecond sentence lands.",
      path: "block-stream",
      blocks: 2,
    });

    // What the host was asked for.
    const call = reply.calls[0];
    expect(call?.replyOptions).toMatchObject({
      disableBlockStreaming: false,
      thinkingLevelOverride: "off",
      suppressTyping: true,
    });
    expect(call?.ctx).toMatchObject({ __finalized: true });
    expect(reply.finalized[0]).toMatchObject({
      Body: "[teamspeak voice · Wed 7:00 PM ET] phatt said: what did I miss",
      SessionKey: "agent:sexton:teamspeak:default",
      AgentId: "sexton",
      AccountId: "default",
      Provider: "teamspeak",
      Surface: "teamspeak",
      OriginatingChannel: "teamspeak",
      ChatType: "direct",
      SenderName: "phatt",
      CommandAuthorized: false,
      InboundAccessAuthorized: true,
      Timestamp: 1_000,
    });
    // The per-turn config copy: voice-sized chunking, host config untouched.
    const turnCfg = call?.cfg as unknown as { agents: { defaults: Record<string, unknown> } };
    expect(turnCfg.agents.defaults.blockStreamingChunk).toEqual(VOICE_BLOCK_STREAMING_CHUNK);
    expect(turnCfg.agents.defaults.blockStreamingCoalesce).toEqual(VOICE_BLOCK_STREAMING_COALESCE);
    expect(turnCfg.agents.defaults.thinkingDefault).toBe("medium");
    expect(turnCfg.agents.defaults.model).toEqual({ primary: "litellm/minimax/MiniMax-M3" });
    expect(
      (cfg as unknown as { agents: { defaults: Record<string, unknown> } }).agents.defaults
        .blockStreamingChunk,
    ).toBeUndefined();
    // Nothing went near the ingress path.
    expect(reply.calls).toHaveLength(1);
  });

  it("does not speak a final payload that repeats the streamed blocks", async () => {
    const reply = fakeReply(async (deliver) => {
      await deliver({ text: "One thing." }, { kind: "block" });
      await deliver({ text: "Another thing." }, { kind: "block" });
      await deliver({ text: "One thing.\n\nAnother thing." }, { kind: "final" });
    });
    const turn = createTeamSpeakAgentTurn({
      agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
      reply,
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "k",
    });
    const blocks: string[] = [];
    const result = await turn(utterance, { onBlock: (text) => blocks.push(text) });
    expect(blocks).toEqual(["One thing.", "Another thing."]);
    expect(result.text).toBe("One thing.\nAnother thing.");
  });

  it("speaks a final payload the blocks did not cover (aborted stream)", async () => {
    const reply = fakeReply(async (deliver) => {
      await deliver({ text: "Fallback whole answer." }, { kind: "final" });
    });
    const turn = createTeamSpeakAgentTurn({
      agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
      reply,
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "k",
    });
    const blocks: string[] = [];
    const result = await turn(utterance, { onBlock: (text) => blocks.push(text) });
    expect(blocks).toEqual(["Fallback whole answer."]);
    expect(result).toMatchObject({ text: "Fallback whole answer.", blocks: 0 });
  });

  it("skips error payloads and reports an empty turn", async () => {
    const logs: string[] = [];
    const reply = fakeReply(async (deliver) => {
      await deliver({ text: "model exploded", isError: true }, { kind: "final" });
    });
    const turn = createTeamSpeakAgentTurn({
      agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
      reply,
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "k",
      log: (line) => logs.push(line),
    });
    const result = await turn(utterance, {});
    expect(result.text).toBe("");
    expect(logs.some((line) => line.includes("error payload"))).toBe(true);
    expect(logs.some((line) => line.includes("no speakable blocks"))).toBe(true);
  });

  it("puts voice.model on the turn config, not the session", () => {
    const turnCfg = buildVoiceTurnConfig(cfg, "minimax/MiniMax-M2.5") as unknown as {
      agents: { defaults: Record<string, unknown> };
    };
    expect(turnCfg.agents.defaults.model).toBe("minimax/MiniMax-M2.5");
    expect(
      (cfg as unknown as { agents: { defaults: Record<string, unknown> } }).agents.defaults.model,
    ).toEqual({ primary: "litellm/minimax/MiniMax-M3" });
  });
});

describe("createTeamSpeakAgentTurn (ingress fallback)", () => {
  it("runs the whole-reply ingress call when block streaming is off, with no delivery", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const agent = {
      runCommandFromIngress: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return { payloads: [{ text: "Whole reply." }, { text: "oops", isError: true }] };
      },
    };
    const reply = fakeReply(async () => {
      throw new Error("the streaming path must not run");
    });
    const turn = createTeamSpeakAgentTurn({
      agent,
      reply,
      blockStreaming: false,
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "k",
      model: "minimax/MiniMax-M2.5",
      thinking: "off",
    });
    const blocks: string[] = [];
    const result = await turn(utterance, { onBlock: (text) => blocks.push(text) });
    expect(blocks).toEqual([]);
    expect(result).toEqual({ text: "Whole reply.", path: "ingress", blocks: 0 });
    expect(calls[0]).toMatchObject({
      message: expect.stringMatching(/^\[teamspeak voice · \w{3} \d{1,2}:\d{2} [AP]M ET\] phatt said: what did I miss$/),
      sessionKey: "k",
      agentId: "sexton",
      messageChannel: "teamspeak",
      messageProvider: "teamspeak-voice",
      allowModelOverride: true,
      model: "minimax/MiniMax-M2.5",
      thinking: "off",
      deliver: false,
    });
  });

  it("falls back to ingress when the host has no reply runtime", async () => {
    let ingressCalls = 0;
    const turn = createTeamSpeakAgentTurn({
      agent: {
        runCommandFromIngress: async () => {
          ingressCalls += 1;
          return { payloads: [{ text: "ok" }] };
        },
      },
      cfg,
      accountId: "default",
      agentId: "sexton",
      sessionKey: "k",
    });
    expect((await turn(utterance, {})).path).toBe("ingress");
    expect(ingressCalls).toBe(1);
  });
});
