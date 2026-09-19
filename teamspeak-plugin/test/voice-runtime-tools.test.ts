/**
 * The realtime tools end-to-end over the mock bridge (PHA-3176).
 *
 * A tool call enters where the provider would deliver it — the registration the
 * speaker sessions are given — and the assertions are on the frames that leave
 * for the bridge: `poke` (0x88), `music_audio` (0x82), `music_gain` (0x83).
 * The provider itself is absent; what is proven is that the plugin's half of
 * the round trip is wired to the right lane.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  TYPE_MUSIC_AUDIO,
  TYPE_MUSIC_GAIN,
  TYPE_POKE,
  type RosterEntry,
} from "../src/bridge/protocol.js";
import type { TeamSpeakAccountConfig } from "../src/config.js";
import { MUSIC_FRAME_BYTES, MusicPlayer, type MusicSink } from "../src/tools/music.js";
import type { RoomPlaybackQueue } from "../src/voice/room-playback.js";
import type { TeamSpeakRealtimeToolRegistration } from "../src/voice/realtime-speaker-session.js";
import {
  TeamSpeakVoiceRuntime,
  type VoiceSpeakerSession,
} from "../src/voice/voice-runtime.js";
import { MockBridge, rosterEntry } from "./mock-bridge.js";

class StubSpeakerSession implements VoiceSpeakerSession {
  label: string;
  wakeNameRequired = false;
  bargeInEnabled = true;

  constructor(
    readonly clientId: number,
    nickname: string,
    readonly tools: TeamSpeakRealtimeToolRegistration | undefined,
  ) {
    this.label = nickname;
  }

  async connect(): Promise<void> {}
  relabel(nickname: string): void {
    this.label = nickname;
  }
  close(): void {}
  sendInputAudio(): void {}
  handleSpeakerStart(): boolean {
    return false;
  }
}

/** A MusicPlayer on the runtime's real sink, with yt-dlp and ffmpeg faked out. */
function fakeMusicPlayer(sink: MusicSink, control: { ticks: (() => void)[]; clock: () => number }) {
  const stdoutListeners = new Map<string, ((...args: never[]) => void)[]>();
  const listen = (map: Map<string, ((...args: never[]) => void)[]>) => ({
    on(event: string, listener: (...args: never[]) => void): unknown {
      const existing = map.get(event) ?? [];
      existing.push(listener);
      map.set(event, existing);
      return this;
    },
    pause() {},
    resume() {},
  });
  const emit = (chunk: Buffer) => {
    for (const listener of stdoutListeners.get("data") ?? []) {
      (listener as (...rest: unknown[]) => void)(chunk);
    }
  };
  const player = new MusicPlayer({
    config: { prebufferMs: 40 },
    sink,
    run: async () => ({
      code: 0,
      stdout: "Smooth Jazz Radio\thttps://cdn.example/a.webm\n",
      stderr: "",
    }),
    spawnProcess: () => ({
      stdout: listen(stdoutListeners),
      stderr: listen(new Map()),
      on: () => undefined,
      kill: () => undefined,
    }),
    now: control.clock,
    setIntervalFn: (handler) => {
      control.ticks.push(handler);
      return handler;
    },
    clearIntervalFn: (handle) => {
      const index = control.ticks.indexOf(handle as () => void);
      if (index >= 0) {
        control.ticks.splice(index, 1);
      }
    },
  });
  return { player, emit };
}

type Harness = {
  bridge: MockBridge;
  runtime: TeamSpeakVoiceRuntime;
  sessions: Map<number, StubSpeakerSession>;
  tools: TeamSpeakRealtimeToolRegistration;
  emitPcm: (frames: number) => void;
  tick: () => void;
  advance: (ms: number) => void;
  call: (name: string, args?: unknown) => Promise<Record<string, unknown> & { ok: boolean }>;
  logs: string[];
};

function createHarness(config: Partial<TeamSpeakAccountConfig> = {}): Harness {
  const bridge = new MockBridge();
  const sessions = new Map<number, StubSpeakerSession>();
  const logs: string[] = [];
  const ticks: (() => void)[] = [];
  let clock = 1_000;
  let emitPcm: (frames: number) => void = () => undefined;

  const runtime = new TeamSpeakVoiceRuntime({
    accountId: "default",
    config: { bridgeUrl: "ws://ts-bridge:9099", channel: "General Shit", ...config },
    createSocket: bridge.createSocket,
    minBargeInAudioEndMs: 0,
    log: (message) => logs.push(message),
    toolOverrides: {
      createMusic: (sink) => {
        const fake = fakeMusicPlayer(sink, { ticks, clock: () => clock });
        emitPcm = (frames: number) => fake.emit(Buffer.alloc(frames * MUSIC_FRAME_BYTES, 3));
        return fake.player;
      },
      readLog: async () => ({
        entries: [
          {
            time: "18:01",
            nickname: "Kai",
            text: "we start at nine",
            line: "18:01  Kai: we start at nine",
            at: new Date(2026, 8, 6, 18, 1),
          },
        ],
        lines: ["18:01  Kai: we start at nine"],
        filesRead: [],
        skippedLines: 0,
      }),
    },
    createSpeakerSession: (client: RosterEntry, _playback: RoomPlaybackQueue, tools) => {
      const session = new StubSpeakerSession(client.clientId, client.nickname, tools);
      sessions.set(client.clientId, session);
      return session;
    },
  });
  runtime.start();
  bridge.accept();

  const tools = runtime.toolRegistration;
  if (!tools) {
    throw new Error("expected the runtime to register tools");
  }
  return {
    bridge,
    runtime,
    sessions,
    tools,
    logs,
    emitPcm: (frames) => emitPcm(frames),
    tick: () => {
      for (const handler of [...ticks]) {
        handler();
      }
    },
    advance: (ms) => {
      clock += ms;
    },
    call: async (name, args) =>
      (await tools.handle(
        { itemId: "item", callId: `call-${name}`, name, args: args ?? {} },
        { clientId: 11, nickname: "brandon" },
      )) as Record<string, unknown> & { ok: boolean },
  };
}

describe("TeamSpeakVoiceRuntime realtime tools", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    harness.bridge.replay([
      { type: "state", state: { connected: true, channelId: 1, channelName: "General Shit" } },
      { type: "roster", roster: [rosterEntry(11, "brandon"), rosterEntry(12, "Kai")] },
    ]);
  });

  it("hands the same registration to every speaker session", () => {
    expect(harness.sessions.get(11)?.tools).toBe(harness.tools);
    expect(harness.sessions.get(12)?.tools).toBe(harness.tools);
  });

  it("play_music puts paced frames on the music lane, not the voice lane", async () => {
    harness.bridge.clearSent();
    const result = await harness.call("play_music", { query: "smooth jazz" });
    expect(result).toMatchObject({ ok: true, title: "Smooth Jazz Radio" });

    // The gain is announced before any audio, so the first frame is not louder
    // than whatever the last set_volume asked for.
    expect(harness.bridge.sentOfType(TYPE_MUSIC_GAIN)[0]?.header).toEqual({ gain: 0.6 });

    harness.emitPcm(20);
    harness.tick();
    const framesAtStart = harness.bridge.sentOfType(TYPE_MUSIC_AUDIO);
    expect(framesAtStart).toHaveLength(2); // prebuffer only
    expect(framesAtStart[0]?.payload.length).toBe(MUSIC_FRAME_BYTES);

    harness.advance(200);
    harness.tick();
    expect(harness.bridge.sentOfType(TYPE_MUSIC_AUDIO)).toHaveLength(12);
  });

  it("stop_music ends the stream and the lane goes quiet", async () => {
    await harness.call("play_music", { query: "smooth jazz" });
    harness.emitPcm(50);
    harness.tick();
    harness.bridge.clearSent();

    expect(await harness.call("stop_music")).toMatchObject({ ok: true, wasPlaying: true });
    harness.advance(1_000);
    harness.tick();
    expect(harness.bridge.sentOfType(TYPE_MUSIC_AUDIO)).toHaveLength(0);
  });

  it("set_volume reaches the bridge as music_gain", async () => {
    harness.bridge.clearSent();
    expect(await harness.call("set_volume", { volume: 0.25 })).toMatchObject({ volume: 0.25 });
    expect(harness.bridge.sentOfType(TYPE_MUSIC_GAIN)[0]?.header).toEqual({ gain: 0.25 });
  });

  it("who_is_here answers from the bridge's roster", async () => {
    const result = await harness.call("who_is_here");
    expect(result).toMatchObject({ ok: true, count: 2, channel: "General Shit" });
    expect((result.people as { nickname: string }[]).map((person) => person.nickname)).toEqual([
      "brandon",
      "Kai",
    ]);
  });

  it("poke sends a poke frame for the named client", async () => {
    harness.bridge.clearSent();
    const result = await harness.call("poke", { nickname: "kai", text: "you're up" });

    expect(result).toMatchObject({ ok: true, clientId: 12 });
    expect(harness.bridge.sentOfType(TYPE_POKE)[0]?.header).toEqual({
      clientId: 12,
      text: "you're up",
    });
  });

  it("what_did_i_miss reads the log for the channel the bridge reports", async () => {
    const result = await harness.call("what_did_i_miss", {});
    expect(result).toMatchObject({ ok: true, channel: "General Shit", count: 1 });
    expect(result.text).toBe("18:01  Kai: we start at nine");
  });

  it("stops the music on !vc leave, !vc mute and a bridge drop", async () => {
    for (const trigger of ["!vc leave", "!vc mute on"]) {
      await harness.call("play_music", { query: "smooth jazz" });
      expect(harness.runtime.musicController?.isPlaying).toBe(true);
      harness.bridge.deliver({
        type: "text_message",
        clientId: 11,
        nickname: "brandon",
        text: trigger,
      });
      expect(harness.runtime.musicController?.isPlaying).toBe(false);
    }

    await harness.call("play_music", { query: "smooth jazz" });
    harness.bridge.drop("bridge-restart");
    expect(harness.runtime.musicController?.isPlaying).toBe(false);
  });

  it("shows the music state in !sexton status", async () => {
    expect(harness.runtime.snapshot().music).toBe("idle (volume 60%)");
    await harness.call("play_music", { query: "smooth jazz" });
    expect(harness.runtime.snapshot().music).toBe('playing "Smooth Jazz Radio" at 60%');
  });

  it("registers no tools at all when tools are disabled", () => {
    const bridge = new MockBridge();
    const runtime = new TeamSpeakVoiceRuntime({
      accountId: "default",
      config: { bridgeUrl: "ws://ts-bridge:9099", tools: { enabled: false } },
      createSocket: bridge.createSocket,
      createSpeakerSession: (client, _playback, tools) =>
        new StubSpeakerSession(client.clientId, client.nickname, tools),
    });
    expect(runtime.toolRegistration).toBeUndefined();
    runtime.stop();
  });

  it("keeps the non-music tools when only music is disabled", () => {
    const bridge = new MockBridge();
    const runtime = new TeamSpeakVoiceRuntime({
      accountId: "default",
      config: { bridgeUrl: "ws://ts-bridge:9099", tools: { music: { enabled: false } } },
      createSocket: bridge.createSocket,
      createSpeakerSession: (client, _playback, tools) =>
        new StubSpeakerSession(client.clientId, client.nickname, tools),
    });
    expect(runtime.musicController).toBeUndefined();
    expect(runtime.toolRegistration?.tools.map((tool) => tool.name)).toEqual([
      "what_did_i_miss",
      "who_is_here",
      "poke",
      "leave_voice",
      "join_voice",
    ]);
    runtime.stop();
  });
});
