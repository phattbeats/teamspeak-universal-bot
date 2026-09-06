/**
 * End-to-end over the mock bridge: recorded frames in, bridge frames out.
 *
 * This is the "test without a server" path from PHA-3175 — the mock bridge
 * replays the same binary protocol the Rust sidecar speaks, so roster
 * lifecycle, audio routing, barge-in, and chat commands are all exercised
 * through the real frame codec.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  TYPE_CLEAR_VOICE,
  TYPE_JOIN,
  TYPE_MUTE,
  TYPE_SEND_TEXT,
  TYPE_VOICE_AUDIO,
} from "../src/bridge/protocol.js";
import type { RosterEntry } from "../src/bridge/protocol.js";
import type { TeamSpeakAccountConfig } from "../src/config.js";
import type { RoomPlaybackQueue } from "../src/voice/room-playback.js";
import {
  TeamSpeakVoiceRuntime,
  type VoiceSpeakerSession,
} from "../src/voice/voice-runtime.js";
import { MockBridge, rosterEntry, toneFrame48k } from "./mock-bridge.js";

const FRAME_20MS = toneFrame48k();

type Harness = {
  bridge: MockBridge;
  runtime: TeamSpeakVoiceRuntime;
  sessions: Map<number, FakeSpeakerSession>;
  silentEvents: string[];
};

class FakeSpeakerSession implements VoiceSpeakerSession {
  readonly received: Buffer[] = [];
  readonly closedWith: string[] = [];
  label: string;
  wakeNameRequired = false;
  bargeInEnabled = true;

  constructor(
    readonly clientId: number,
    nickname: string,
    private readonly playback: RoomPlaybackQueue,
  ) {
    this.label = nickname;
  }

  get ownerKey(): string {
    return `client:${this.clientId}`;
  }

  async connect(): Promise<void> {}

  relabel(nickname: string): void {
    this.label = nickname;
  }

  close(reason: string): void {
    this.closedWith.push(reason);
    this.playback.release(this.ownerKey);
  }

  sendInputAudio(pcm48kMono: Buffer): void {
    this.received.push(pcm48kMono);
  }

  /** Stand-in for the provider speaking into the room. */
  speak(pcm48kMono: Buffer = FRAME_20MS): void {
    this.playback.enqueue(this.ownerKey, pcm48kMono);
  }

  handleSpeakerStart(reason?: string): boolean {
    if (!this.bargeInEnabled || this.playback.activeOwner !== this.ownerKey) {
      return false;
    }
    return this.playback.handleBargeIn(reason ?? "speaker-start");
  }
}

function createHarness(config: Partial<TeamSpeakAccountConfig> = {}): Harness {
  const bridge = new MockBridge();
  const sessions = new Map<number, FakeSpeakerSession>();
  const silentEvents: string[] = [];
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: "default",
    config: { bridgeUrl: "ws://ts-bridge:9099", channel: "General Shit", ...config },
    createSocket: bridge.createSocket,
    minBargeInAudioEndMs: 0,
    deliverSilentEvent: (text) => silentEvents.push(text),
    createSpeakerSession: (client: RosterEntry, playback) => {
      const session = new FakeSpeakerSession(client.clientId, client.nickname, playback);
      sessions.set(client.clientId, session);
      return session;
    },
  });
  runtime.start();
  bridge.accept();
  return { bridge, runtime, sessions, silentEvents };
}

describe("TeamSpeakVoiceRuntime over a mock bridge", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("joins the configured channel on connect", () => {
    const join = harness.bridge.sentOfType(TYPE_JOIN);
    expect(join).toHaveLength(1);
    expect(join[0]?.header).toEqual({ channel: "General Shit" });
  });

  it("opens and closes speaker sessions as the replayed roster changes", () => {
    harness.bridge.replay([
      { type: "state", state: { connected: true, channelId: 1, channelName: "General Shit" } },
      { type: "roster", roster: [rosterEntry(11, "brandon")] },
      { type: "roster", roster: [rosterEntry(11, "brandon"), rosterEntry(12, "guest")] },
    ]);
    expect(harness.runtime.snapshot().speakerSessions).toBe(2);

    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    expect(harness.runtime.snapshot().speakerSessions).toBe(1);
    expect(harness.sessions.get(12)?.closedWith).toEqual(["left-channel"]);
  });

  it("routes speaker_audio to the session that owns that clientId", () => {
    harness.bridge.replay([
      { type: "roster", roster: [rosterEntry(11, "brandon"), rosterEntry(12, "guest")] },
      { type: "speaker_audio", clientId: 11, nickname: "brandon", seq: 1, pcm48kMono: FRAME_20MS },
      { type: "speaker_audio", clientId: 11, nickname: "brandon", seq: 2, pcm48kMono: FRAME_20MS },
      { type: "speaker_audio", clientId: 12, nickname: "guest", seq: 1, pcm48kMono: FRAME_20MS },
    ]);

    // Per-speaker frames must not cross sessions; that mislabelling was defect
    // (3) fixed on the bridge side in PHA-3174.
    expect(harness.sessions.get(11)?.received).toHaveLength(2);
    expect(harness.sessions.get(12)?.received).toHaveLength(1);
    expect(harness.sessions.get(11)?.received[0]?.equals(FRAME_20MS)).toBe(true);
  });

  it("ignores speaker_audio for a client with no session", () => {
    harness.bridge.deliver({
      type: "speaker_audio",
      clientId: 77,
      nickname: "stranger",
      seq: 1,
      pcm48kMono: FRAME_20MS,
    });
    expect(harness.sessions.size).toBe(0);
  });

  it("clears the room queue and tells the bridge to drop audio on speaker_start", () => {
    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    harness.sessions.get(11)?.speak();
    harness.sessions.get(11)?.speak();
    expect(harness.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(2);

    harness.bridge.deliver({ type: "speaker_start", clientId: 11 });

    expect(harness.bridge.sentOfType(TYPE_CLEAR_VOICE)).toHaveLength(1);
    expect(harness.runtime.snapshot().playbackActive).toBe(false);
  });

  it("does not send clear_voice when nothing is playing", () => {
    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    harness.bridge.deliver({ type: "speaker_start", clientId: 11 });
    expect(harness.bridge.sentOfType(TYPE_CLEAR_VOICE)).toHaveLength(0);
  });

  it("delivers roster changes as silent events for the agent session", () => {
    harness.bridge.replay([
      { type: "roster", roster: [rosterEntry(11, "brandon")] },
      { type: "roster", roster: [rosterEntry(11, "brandon"), rosterEntry(12, "guest")] },
      { type: "roster", roster: [rosterEntry(11, "brandon|afk"), rosterEntry(12, "guest")] },
      { type: "roster", roster: [rosterEntry(12, "guest")] },
    ]);

    expect(harness.silentEvents).toEqual([
      "[teamspeak] brandon joined the channel.",
      "[teamspeak] guest joined the channel.",
      "[teamspeak] brandon is now known as brandon|afk.",
      "[teamspeak] brandon|afk left the channel.",
    ]);
  });

  // The bridge's roster is the channel's, bot included. Counting ourselves as a
  // participant is what turns the wake gate on with one human in the room and
  // barge-in off with it, so the exclusion is load-bearing for the whole
  // "Brandon alone can just talk" behavior, not bookkeeping.
  it("excludes the bridge's own client from sessions and the human count", () => {
    harness.bridge.replay([
      {
        type: "state",
        state: { connected: true, channelId: 1, channelName: "General Shit", ownClientId: 9 },
      },
      { type: "roster", roster: [rosterEntry(9, "Sexton"), rosterEntry(11, "brandon")] },
    ]);

    expect(harness.runtime.snapshot().humanParticipants).toBe(1);
    expect(harness.runtime.snapshot().speakerSessions).toBe(1);
    expect(harness.sessions.has(9)).toBe(false);
  });

  it("retires a session opened on itself once the state names its own client", () => {
    // Roster before state: the bridge normally sends state first, but a
    // reconnect mid-roster can invert them, and the wake gate must not stay
    // wedged on for the life of the process when it does.
    harness.bridge.deliver({
      type: "roster",
      roster: [rosterEntry(9, "Sexton"), rosterEntry(11, "brandon")],
    });
    expect(harness.runtime.snapshot().humanParticipants).toBe(2);

    harness.bridge.deliver({
      type: "state",
      state: { connected: true, channelId: 1, channelName: "General Shit", ownClientId: 9 },
    });

    expect(harness.runtime.snapshot().humanParticipants).toBe(1);
    expect(harness.sessions.get(9)?.closedWith).toEqual(["left-channel"]);
  });

  it("tears down every session when the bridge drops, and rebuilds from the next roster", () => {
    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    expect(harness.runtime.snapshot().speakerSessions).toBe(1);

    harness.bridge.drop("bridge-restart");
    expect(harness.sessions.get(11)?.closedWith).toEqual(["bridge-disconnected:bridge-restart"]);
    expect(harness.runtime.snapshot().speakerSessions).toBe(0);

    harness.bridge.accept();
    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    expect(harness.runtime.snapshot().speakerSessions).toBe(1);
  });

  it("survives a malformed frame without dropping the connection", () => {
    harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    harness.bridge.deliverRaw(Buffer.from([0x01, 0x00]));
    harness.bridge.deliverRaw(Buffer.from([0x7f, 0x00, 0x00, 0x00, 0x00]));

    harness.bridge.deliver({
      type: "speaker_audio",
      clientId: 11,
      nickname: "brandon",
      seq: 1,
      pcm48kMono: FRAME_20MS,
    });
    expect(harness.sessions.get(11)?.received).toHaveLength(1);
  });

  describe("chat commands", () => {
    it("answers !sexton status in the channel", () => {
      harness.bridge.replay([
        { type: "state", state: { connected: true, channelId: 1, channelName: "General Shit" } },
        { type: "roster", roster: [rosterEntry(11, "brandon")] },
      ]);
      harness.bridge.clearSent();

      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!sexton status",
      });

      const replies = harness.bridge.sentOfType(TYPE_SEND_TEXT);
      expect(replies).toHaveLength(1);
      const header = replies[0]?.header as { target: string; text: string };
      expect(header.target).toBe("channel");
      expect(header.text).toContain("Sexton — connected to General Shit");
      expect(header.text).toContain("listening to 1 of 1 in channel");
    });

    it("answers a private status request privately", () => {
      harness.bridge.clearSent();
      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!sexton status",
        target: "client",
      });

      const header = harness.bridge.sentOfType(TYPE_SEND_TEXT)[0]?.header as { target: number };
      expect(header.target).toBe(11);
    });

    it("mutes and unmutes the outbound lane with !vc mute", () => {
      harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
      harness.sessions.get(11)?.speak();
      harness.bridge.clearSent();

      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!vc mute",
      });
      expect(harness.bridge.sentOfType(TYPE_MUTE)[0]?.header).toEqual({ muted: true });
      // Muting must also drop audio already queued, or the Sexton keeps talking.
      expect(harness.bridge.sentOfType(TYPE_CLEAR_VOICE)).toHaveLength(1);
      expect(harness.runtime.snapshot().muted).toBe(true);

      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!vc mute",
      });
      expect(harness.bridge.sentOfType(TYPE_MUTE)[1]?.header).toEqual({ muted: false });
      expect(harness.runtime.snapshot().muted).toBe(false);
    });

    it("joins a named channel with !vc join", () => {
      harness.bridge.clearSent();
      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!vc join Gaming Room",
      });
      expect(harness.bridge.sentOfType(TYPE_JOIN)[0]?.header).toEqual({ channel: "Gaming Room" });
    });

    it("closes sessions on !vc leave", () => {
      harness.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "!vc leave",
      });
      expect(harness.runtime.snapshot().speakerSessions).toBe(0);
      expect(harness.sessions.get(11)?.closedWith).toEqual(["vc-leave"]);
    });

    it("ignores ordinary chat", () => {
      harness.bridge.clearSent();
      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: "anyone up for cs later",
      });
      expect(harness.bridge.sentOfType(TYPE_SEND_TEXT)).toHaveLength(0);
    });

    it("refuses commands from a client outside commandAllowFrom", () => {
      const restricted = createHarness({ commandAllowFrom: [11] });
      restricted.bridge.clearSent();

      restricted.bridge.deliver({
        type: "text_message",
        clientId: 12,
        nickname: "guest",
        text: "!vc leave",
      });

      const header = restricted.bridge.sentOfType(TYPE_SEND_TEXT)[0]?.header as { text: string };
      expect(header.text).toContain("not allowed");
      expect(restricted.bridge.sentOfType(TYPE_MUTE)).toHaveLength(0);
    });
  });
});
