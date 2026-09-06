/**
 * The per-speaker session's own wiring: resampling in/out, the room queue, and
 * the tool-call -> submitToolResult path.
 *
 * The harness and provider resolution are injected (`deps`), so this covers
 * the plugin's glue rather than the SDK. The live provider path is only
 * exercisable on a real gateway.
 */
import type { RealtimeVoiceSessionHarness } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { BRIDGE_FRAME_BYTES } from "../src/voice/audio.js";
import { RoomPlaybackQueue, type RoomPlaybackSink } from "../src/voice/room-playback.js";
import {
  TeamSpeakRealtimeSpeakerSession,
  type TeamSpeakRealtimeSessionParams,
} from "../src/voice/realtime-speaker-session.js";
import { rosterEntry, toneFrame48k } from "./mock-bridge.js";

const FRAME_20MS_48K = toneFrame48k();

type BridgeParams = Parameters<RealtimeVoiceSessionHarness["createBridge"]>[0];

function createFakeHarness() {
  const state = {
    bridgeParams: undefined as BridgeParams | undefined,
    sentAudio: [] as Buffer[],
    recordedOutput: [] as Buffer[],
    toolResults: [] as Array<{ callId: string; result: unknown }>,
    bargeIns: 0,
    closed: false,
    recordInputAudioResult: true,
  };
  const session = {
    connect: async () => {},
    close: () => {},
    sendAudio: (audio: Buffer) => state.sentAudio.push(audio),
    handleBargeIn: () => {
      state.bargeIns += 1;
    },
    submitToolResult: (callId: string, result: unknown) => {
      state.toolResults.push({ callId, result });
    },
  };
  const harness = {
    close: () => {
      state.closed = true;
    },
    createBridge: (params: BridgeParams) => {
      state.bridgeParams = params;
      return session;
    },
    flushOutput: (flush: () => void) => flush(),
    handleBargeIn: (_options: unknown, flush: () => void) => flush(),
    recordInputAudio: (audio: Buffer) => {
      void audio;
      return state.recordInputAudioResult;
    },
    recordOutputAudio: (audio: Buffer) => state.recordedOutput.push(audio),
  };
  return { state, harness, session };
}

function createSession(overrides: Partial<TeamSpeakRealtimeSessionParams> = {}) {
  const fake = createFakeHarness();
  const sink: RoomPlaybackSink & { written: Buffer[]; cleared: number } = {
    written: [],
    cleared: 0,
    writeVoiceAudio(pcm) {
      this.written.push(pcm);
    },
    clearVoice() {
      this.cleared += 1;
    },
  };
  const playback = new RoomPlaybackQueue({ sink, minBargeInAudioEndMs: 0 });
  const onTerminalError = vi.fn();
  const session = new TeamSpeakRealtimeSpeakerSession({
    client: rosterEntry(11, "brandon"),
    sessionId: "session-1",
    accountId: "default",
    agentId: "sexton",
    cfg: {},
    mode: "agent-proxy",
    realtimeConfig: { provider: "openai" },
    playback,
    humanParticipantCount: () => 1,
    onTerminalError,
    deps: {
      createHarness: (() => fake.harness) as never,
    },
    ...overrides,
  });
  return { session, fake, playback, sink, onTerminalError };
}

describe("TeamSpeakRealtimeSpeakerSession", () => {
  it("keys the room lane by clientId, not nickname", async () => {
    const { session } = createSession();
    expect(session.playbackOwnerKey).toBe("client:11");

    // TeamSpeak nicknames change mid-session and are not unique.
    session.relabel("brandon|afk");
    expect(session.label).toBe("brandon|afk");
    expect(session.playbackOwnerKey).toBe("client:11");
  });

  it("resamples bridge audio to 24k before handing it to the provider", async () => {
    const { session, fake } = createSession();
    await session.connect();

    session.sendInputAudio(FRAME_20MS_48K);

    expect(fake.state.sentAudio).toHaveLength(1);
    expect(fake.state.sentAudio[0]?.length).toBe(BRIDGE_FRAME_BYTES / 2);
  });

  it("does not forward input the harness suppressed as echo", async () => {
    const { session, fake } = createSession();
    await session.connect();
    fake.state.recordInputAudioResult = false;

    session.sendInputAudio(FRAME_20MS_48K);
    expect(fake.state.sentAudio).toHaveLength(0);
  });

  it("resamples provider output to 48k and queues it on the room lane", async () => {
    const { session, fake, sink } = createSession();
    await session.connect();

    // 480 samples @24k = 20 ms, the provider's native chunk.
    fake.state.bridgeParams?.audioSink.sendAudio(Buffer.alloc(480 * 2));

    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]?.length).toBe(BRIDGE_FRAME_BYTES);
    expect(fake.state.recordedOutput).toHaveLength(1);
  });

  it("registers the configured realtime tools on the provider session", async () => {
    const tools = [
      {
        type: "function" as const,
        name: "sexton_play_music",
        description: "play music",
        parameters: { type: "object" as const, properties: {} },
      },
    ];
    const { session, fake } = createSession({
      toolRegistration: { tools, handle: () => ({ ok: true }) },
    });
    await session.connect();

    expect(fake.state.bridgeParams?.tools).toEqual(tools);
  });

  it("runs a tool call and submits its result back to the provider", async () => {
    const handle = vi.fn(() => ({ ok: true, played: "smooth jazz" }));
    const { session, fake } = createSession({
      toolRegistration: { tools: [], handle },
    });
    await session.connect();

    await fake.state.bridgeParams?.onToolCall?.(
      { itemId: "i1", callId: "call-1", name: "sexton_play_music", args: { query: "jazz" } },
      fake.session as never,
    );

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", name: "sexton_play_music" }),
      { clientId: 11, nickname: "brandon" },
    );
    expect(fake.state.toolResults).toEqual([
      { callId: "call-1", result: { ok: true, played: "smooth jazz" } },
    ]);
  });

  it("settles a tool call whose handler threw, instead of stranding the turn", async () => {
    const { session, fake } = createSession({
      toolRegistration: {
        tools: [],
        handle: () => {
          throw new Error("music lane offline");
        },
      },
    });
    await session.connect();

    await fake.state.bridgeParams?.onToolCall?.(
      { itemId: "i1", callId: "call-2", name: "sexton_play_music", args: {} },
      fake.session as never,
    );

    // The provider blocks its turn until every outstanding call is answered.
    expect(fake.state.toolResults).toEqual([
      { callId: "call-2", result: { ok: false, error: "music lane offline" } },
    ]);
  });

  it("answers an unregistered tool call rather than leaving it pending", async () => {
    const { session, fake } = createSession();
    await session.connect();

    await fake.state.bridgeParams?.onToolCall?.(
      { itemId: "i1", callId: "call-3", name: "sexton_unknown", args: {} },
      fake.session as never,
    );

    expect(fake.state.toolResults[0]?.callId).toBe("call-3");
    expect(fake.state.toolResults[0]?.result).toMatchObject({ ok: false });
  });

  it("interrupts its own playback on speaker_start when it owns the lane", async () => {
    const { session, fake, playback, sink } = createSession();
    await session.connect();
    fake.state.bridgeParams?.audioSink.sendAudio(Buffer.alloc(480 * 2));
    expect(playback.activeOwner).toBe("client:11");

    expect(session.handleSpeakerStart()).toBe(true);
    expect(sink.cleared).toBe(1);
    expect(fake.state.bargeIns).toBe(1);
  });

  it("does not interrupt when another speaker owns the lane", async () => {
    const { session, playback, sink } = createSession();
    await session.connect();
    playback.enqueue("client:12", FRAME_20MS_48K);

    expect(session.handleSpeakerStart()).toBe(false);
    expect(sink.cleared).toBe(0);
  });

  it("does not interrupt while the wake gate is active", async () => {
    // Two humans under the automatic policy: barge-in is off, so one person's
    // crosstalk cannot cut off an answer addressed to someone else.
    const { session, fake, playback, sink } = createSession({
      humanParticipantCount: () => 2,
    });
    await session.connect();
    expect(session.wakeNameRequired).toBe(true);
    expect(session.bargeInEnabled).toBe(false);

    fake.state.bridgeParams?.audioSink.sendAudio(Buffer.alloc(480 * 2));
    expect(playback.activeOwner).toBe("client:11");

    expect(session.handleSpeakerStart()).toBe(false);
    expect(sink.cleared).toBe(0);
  });

  it("releases the room lane and closes the harness on close", async () => {
    const { session, fake, playback } = createSession();
    await session.connect();
    fake.state.bridgeParams?.audioSink.sendAudio(Buffer.alloc(480 * 2));
    expect(playback.activeOwner).toBe("client:11");

    session.close("left-channel");

    expect(playback.activeOwner).toBeUndefined();
    expect(fake.state.closed).toBe(true);
  });

  it("reports an unexpected provider close as a terminal error", async () => {
    const { session, fake, onTerminalError } = createSession();
    await session.connect();

    fake.state.bridgeParams?.onClose?.("provider-hangup");
    expect(onTerminalError).toHaveBeenCalledOnce();
    expect(onTerminalError.mock.calls[0]?.[0]?.message).toContain("provider-hangup");
  });

  it("stays quiet after close instead of pushing more audio", async () => {
    const { session, fake, sink } = createSession();
    await session.connect();
    session.close("left-channel");

    session.sendInputAudio(FRAME_20MS_48K);
    fake.state.bridgeParams?.audioSink.sendAudio(Buffer.alloc(480 * 2));

    expect(fake.state.sentAudio).toHaveLength(0);
    expect(sink.written).toHaveLength(0);
  });
});
