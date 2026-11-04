/**
 * PHA-4917: a human DM to the bot always gets a reply. Either the agent
 * answers, or one of two fixed lines goes out, at most once per person per
 * 10 minutes, and never to a bot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPE_SEND_TEXT } from "../src/bridge/protocol.js";
import type { RosterEntry } from "../src/bridge/protocol.js";
import type { TeamSpeakAccountConfig } from "../src/config.js";
import { DM_DOWN_REPLY, DM_VOICE_REPLY, TeamSpeakVoiceRuntime } from "../src/voice/voice-runtime.js";
import { MockBridge } from "./mock-bridge.js";

function make(opts: {
  onChatMessage?: (m: { text: string }) => Promise<string | undefined>;
  voiceOff?: boolean;
  config?: Partial<TeamSpeakAccountConfig>;
  dmReplyTimeoutMs?: number;
}) {
  const bridge = new MockBridge();
  let clock = 1_000_000;
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: "sexton",
    config: { bridgeUrl: "ws://x:9099", channel: "General", voice: { wakeNames: ["Sexton"] }, tools: { announce: { enabled: false } }, ...opts.config },
    createSocket: bridge.createSocket,
    ...(opts.voiceOff !== undefined ? { voiceOff: opts.voiceOff } : {}),
    ...(opts.onChatMessage ? { onChatMessage: opts.onChatMessage as never } : {}),
    ...(opts.dmReplyTimeoutMs !== undefined ? { dmReplyTimeoutMs: opts.dmReplyTimeoutMs } : {}),
    now: () => clock,
    createSpeakerSession: (_c: RosterEntry) => {
      throw new Error("no voice in this test");
    },
  });
  runtime.start();
  bridge.accept();
  bridge.deliver({ type: "state", state: { connected: true, channelId: 1, channelName: "General", ownClientId: 1 } });
  const dm = (text: string, nickname = "brandon", clientId = 11) =>
    bridge.deliver({ type: "text_message", clientId, nickname, text, target: "client" });
  const sent = () => bridge.sentOfType(TYPE_SEND_TEXT).map((f) => (f.header as { text: string }).text);
  return { bridge, runtime, dm, sent, advance: (ms: number) => (clock += ms) };
}

describe("DM always-reply (PHA-4917)", () => {
  let h: ReturnType<typeof make>;
  afterEach(() => {
    h.runtime.stop();
    vi.useRealTimers();
  });

  it("the agent's answer goes out when there is one", async () => {
    h = make({ onChatMessage: async () => "Two of you are in Normie Chat." });
    h.dm("who is here");
    await vi.waitFor(() => expect(h.sent()).toEqual(["Two of you are in Normie Chat."]));
  });

  it("an agent that throws, or says nothing, gets the can't-answer line", async () => {
    h = make({ onChatMessage: async () => { throw new Error("rate limited"); } });
    h.dm("why u no repsond");
    await vi.waitFor(() => expect(h.sent()).toEqual([DM_DOWN_REPLY]));
    h.runtime.stop();
    h = make({ onChatMessage: async () => undefined });
    h.dm("hello");
    await vi.waitFor(() => expect(h.sent()).toEqual([DM_DOWN_REPLY]));
  });

  it("no agent wired at all still replies", () => {
    h = make({});
    h.dm("hello?");
    expect(h.sent()).toEqual([DM_DOWN_REPLY]);
  });

  it("an agent that hangs gets the fallback at the timeout, and its late answer still lands", async () => {
    let finish: (v: string) => void = () => {};
    h = make({ onChatMessage: () => new Promise<string>((r) => (finish = r)), dmReplyTimeoutMs: 20 });
    h.dm("hello");
    await vi.waitFor(() => expect(h.sent()).toEqual([DM_DOWN_REPLY]));
    finish("sorry, slow");
    await vi.waitFor(() => expect(h.sent()).toEqual([DM_DOWN_REPLY, "sorry, slow"]));
  });

  it("two DMs in a row while the agent is down get one fallback, not two", async () => {
    h = make({ onChatMessage: async () => { throw new Error("down"); } });
    h.dm("one");
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    h.dm("two");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent()).toEqual([DM_DOWN_REPLY]);
    h.advance(10 * 60 * 1000 + 1);
    h.dm("three");
    await vi.waitFor(() => expect(h.sent()).toHaveLength(2));
  });

  it("an ask that needs voice gets the voice line while voice is off, and never reaches the agent", () => {
    const agent = vi.fn(async () => "sure, talking now");
    h = make({ voiceOff: true, onChatMessage: agent });
    h.dm("can you hear me?");
    expect(h.sent()).toEqual([DM_VOICE_REPLY]);
    expect(agent).not.toHaveBeenCalled();
  });

  it("with voice on, a voice-sounding ask is the agent's to answer", async () => {
    h = make({ voiceOff: false, onChatMessage: async () => "loud and clear" });
    h.dm("can you hear me?");
    await vi.waitFor(() => expect(h.sent()).toEqual(["loud and clear"]));
  });

  it("never sends a fallback to a bot, and dmFallback:false turns it off", async () => {
    h = make({ onChatMessage: async () => undefined });
    h.dm("ping", "Ledger [BOT]", 12);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent()).toEqual([]);
    h.runtime.stop();
    h = make({ onChatMessage: async () => undefined, config: { dmFallback: false } });
    h.dm("hello");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent()).toEqual([]);
  });
});
