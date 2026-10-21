/**
 * The voice kill switch (#4372): text-only mode.
 *
 * With voice off the bots stay in the channel and keep answering text, but no
 * speaker session is opened, no inbound frame reaches a transcriber, nothing
 * is synthesized and no `voice_audio` frame leaves for the bridge. Two ways
 * in: `voice.mode: "off"` (pinned at config time) and the live file the
 * summoner writes (`voice.offFile`), which flips a running lane both ways.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_SEND_TEXT, TYPE_VOICE_AUDIO } from "../src/bridge/protocol.js";
import type { RosterEntry } from "../src/bridge/protocol.js";
import { resolveTeamSpeakVoiceMode, resolveTeamSpeakVoiceOffFile } from "../src/config.js";
import type { RoomPlaybackQueue } from "../src/voice/room-playback.js";
import { TeamSpeakVoiceRuntime, type VoiceSpeakerSession } from "../src/voice/voice-runtime.js";
import { MockBridge, rosterEntry, toneFrame48k } from "./mock-bridge.js";

const FRAME_20MS = toneFrame48k();

/** A session that counts what it would have transcribed. */
class CountingSession implements VoiceSpeakerSession {
  readonly received: Buffer[] = [];
  readonly closedWith: string[] = [];
  label: string;
  wakeNameRequired = false;
  bargeInEnabled = true;
  constructor(readonly clientId: number, nickname: string, private readonly playback: RoomPlaybackQueue) {
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
  speak(): void {
    this.playback.enqueue(this.ownerKey, FRAME_20MS);
  }
  handleSpeakerStart(): boolean {
    return false;
  }
}

function harness(opts: {
  voiceOff?: boolean;
  voiceOffFile?: string;
  fileExists?: (path: string) => boolean;
  synthesize?: ReturnType<typeof vi.fn>;
  onChatMessage?: (message: { text: string }) => Promise<string | undefined>;
}) {
  const bridge = new MockBridge();
  const sessions = new Map<number, CountingSession>();
  let created = 0;
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: "sexton",
    config: {
      bridgeUrl: "ws://ts-bridge:9099",
      channel: "General Shit",
      voice: { wakeNames: ["Sexton"] },
      tools: { announce: { enabled: false } },
    },
    createSocket: bridge.createSocket,
    minBargeInAudioEndMs: 0,
    ...(opts.voiceOff !== undefined ? { voiceOff: opts.voiceOff } : {}),
    ...(opts.voiceOffFile ? { voiceOffFile: opts.voiceOffFile, voiceOffPollMs: 10 } : {}),
    ...(opts.fileExists ? { fileExists: opts.fileExists } : {}),
    ...(opts.synthesize ? { synthesize: opts.synthesize as never } : {}),
    ...(opts.onChatMessage ? { onChatMessage: opts.onChatMessage as never } : {}),
    createSpeakerSession: (client: RosterEntry, playback) => {
      created += 1;
      const session = new CountingSession(client.clientId, client.nickname, playback);
      sessions.set(client.clientId, session);
      return session;
    },
  });
  runtime.start();
  bridge.accept();
  bridge.deliver({ type: "state", state: { connected: true, channelId: 1, channelName: "General Shit", ownClientId: 1 } });
  return { bridge, runtime, sessions, createdCount: () => created };
}

describe("voice.mode resolution (#4372)", () => {
  it('"off" and listen=false both resolve to off; everything else is untouched', () => {
    expect(resolveTeamSpeakVoiceMode({ voice: { mode: "off" } })).toBe("off");
    expect(resolveTeamSpeakVoiceMode({ voice: { mode: "stt-tts", listen: false } })).toBe("off");
    expect(resolveTeamSpeakVoiceMode({ voice: { mode: "stt-tts" } })).toBe("stt-tts");
    expect(resolveTeamSpeakVoiceMode({ voice: { listen: true } })).toBe("agent-proxy");
    expect(resolveTeamSpeakVoiceMode(undefined)).toBe("agent-proxy");
  });

  it("reads the kill-switch file path only when set", () => {
    expect(resolveTeamSpeakVoiceOffFile({ voice: { offFile: "/config/.voice-off" } })).toBe("/config/.voice-off");
    expect(resolveTeamSpeakVoiceOffFile({ voice: { offFile: "  " } })).toBeUndefined();
    expect(resolveTeamSpeakVoiceOffFile({})).toBeUndefined();
  });
});

describe("voice off, pinned by config (mode: off)", () => {
  let h: ReturnType<typeof harness>;
  let synthesize: ReturnType<typeof vi.fn>;
  let chat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    synthesize = vi.fn(async () => ({ status: "ok", pcm48kMono: FRAME_20MS }));
    chat = vi.fn(async () => "Still here, in text.");
    h = harness({ voiceOff: true, synthesize, onChatMessage: chat });
  });
  afterEach(() => h.runtime.stop());

  it("opens no speaker session and drops every inbound frame before a transcriber could see it", () => {
    h.bridge.replay([
      { type: "roster", roster: [rosterEntry(1, "Sexton"), rosterEntry(11, "brandon")] },
      { type: "speaker_start", clientId: 11 },
      { type: "speaker_audio", clientId: 11, nickname: "brandon", seq: 1, pcm48kMono: FRAME_20MS },
      { type: "speaker_audio", clientId: 11, nickname: "brandon", seq: 2, pcm48kMono: FRAME_20MS },
      { type: "speaker_stop", clientId: 11 },
    ]);
    expect(h.createdCount()).toBe(0);
    expect(h.runtime.snapshot().speakerSessions).toBe(0);
    expect(h.runtime.snapshot().voiceOff).toBe(true);
    // The roster is still known: who_is_here and the human count keep working.
    expect(h.runtime.humanParticipantCount()).toBe(1);
    expect(h.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
  });

  it("still answers an addressed text message over send_text", async () => {
    h.bridge.deliver({ type: "roster", roster: [rosterEntry(1, "Sexton"), rosterEntry(11, "brandon")] });
    h.bridge.deliver({ type: "text_message", clientId: 11, nickname: "brandon", text: "Sexton, you there?" });
    await vi.waitFor(() => expect(h.bridge.sentOfType(TYPE_SEND_TEXT)).toHaveLength(1));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(h.bridge.sentOfType(TYPE_SEND_TEXT)[0]?.header).toMatchObject({ text: "Still here, in text." });
    expect(h.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
  });

  it("stays off even when the live switch says on", () => {
    h.runtime.setVoiceOff(false, "test");
    expect(h.runtime.isVoiceOff).toBe(true);
    h.bridge.deliver({ type: "roster", roster: [rosterEntry(11, "brandon")] });
    expect(h.createdCount()).toBe(0);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("reports text-only in !sexton status", () => {
    h.bridge.deliver({ type: "text_message", clientId: 11, nickname: "brandon", text: "!sexton status" });
    const reply = h.bridge.sentOfType(TYPE_SEND_TEXT)[0]?.header as { text: string };
    expect(reply.text).toMatch(/voice off — text only/u);
  });
});

describe("the live kill switch (voice.offFile)", () => {
  let present = false;
  let h: ReturnType<typeof harness>;
  let synthesize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    present = false;
    synthesize = vi.fn(async () => ({ status: "ok", pcm48kMono: FRAME_20MS }));
    h = harness({ voiceOffFile: "/config/.voice-off", fileExists: () => present, synthesize });
  });
  afterEach(() => h.runtime.stop());

  it("closes the sessions when the file appears, drops frames meanwhile, and reopens them when it goes", async () => {
    h.bridge.deliver({ type: "roster", roster: [rosterEntry(1, "Sexton"), rosterEntry(11, "brandon"), rosterEntry(12, "guest")] });
    expect(h.runtime.snapshot().speakerSessions).toBe(2);
    h.sessions.get(11)?.speak();
    expect(h.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(1);

    present = true;
    await vi.waitFor(() => expect(h.runtime.isVoiceOff).toBe(true));
    expect(h.sessions.get(11)?.closedWith).toEqual(["voice-off:file:/config/.voice-off"]);
    expect(h.runtime.snapshot().speakerSessions).toBe(0);
    expect(h.runtime.humanParticipantCount()).toBe(2);

    h.bridge.clearSent();
    h.bridge.replay([
      { type: "speaker_audio", clientId: 11, nickname: "brandon", seq: 3, pcm48kMono: FRAME_20MS },
      // Someone new walks in while voice is off: no session for them either.
      { type: "roster", roster: [rosterEntry(1, "Sexton"), rosterEntry(11, "brandon"), rosterEntry(12, "guest"), rosterEntry(13, "late")] },
    ]);
    expect(h.sessions.get(11)?.received).toHaveLength(0);
    expect(h.sessions.has(13)).toBe(false);
    expect(h.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);

    present = false;
    await vi.waitFor(() => expect(h.runtime.isVoiceOff).toBe(false));
    // One fresh session per person in the roster, the latecomer included.
    expect(h.runtime.snapshot().speakerSessions).toBe(3);
    h.bridge.deliver({ type: "speaker_audio", clientId: 13, nickname: "late", seq: 1, pcm48kMono: FRAME_20MS });
    expect(h.sessions.get(13)?.received).toHaveLength(1);
  });

  it("voice on while parked waits for !vc join, then listens again", async () => {
    h.bridge.deliver({ type: "roster", roster: [rosterEntry(1, "Sexton"), rosterEntry(11, "brandon")] });
    h.bridge.deliver({ type: "text_message", clientId: 11, nickname: "brandon", text: "!vc leave" });
    expect(h.runtime.isParked).toBe(true);
    present = true;
    await vi.waitFor(() => expect(h.runtime.isVoiceOff).toBe(true));
    expect(h.runtime.snapshot().speakerSessions).toBe(0);
    present = false;
    await vi.waitFor(() => expect(h.runtime.isVoiceOff).toBe(false));
    expect(h.runtime.snapshot().speakerSessions).toBe(0); // still parked
    h.bridge.deliver({ type: "text_message", clientId: 11, nickname: "brandon", text: "!vc join" });
    expect(h.runtime.isParked).toBe(false);
    expect(h.runtime.snapshot().speakerSessions).toBe(1);
  });

  it("never calls the synthesizer for a room line while off", async () => {
    present = true;
    await vi.waitFor(() => expect(h.runtime.isVoiceOff).toBe(true));
    // The band leader / announcer path goes through the runtime's room speaker.
    const speak = (h.runtime as unknown as { createRoomSpeaker: (s: unknown, o: string) => (t: string) => Promise<unknown> })
      .createRoomSpeaker(synthesize, "test");
    expect(await speak("hello")).toBeUndefined();
    expect(synthesize).not.toHaveBeenCalled();
    expect(h.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
  });
});
