/**
 * The stt-tts lane end to end over the mock bridge (PHA-3228).
 *
 * Same harness PHA-3175 used: recorded frames in, bridge frames out, no
 * TeamSpeak server and no provider. What is being proved here is the lane's
 * contract rather than its plumbing —
 *
 *  - one transcript per speaker, keyed by clientId;
 *  - the wake gate off with one human in the room and on with two;
 *  - synthesized audio landing on `voice_audio`;
 *  - and no metered provider constructed anywhere in the path, which is the
 *    budget ceiling and the privacy promise both.
 */
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { TYPE_VOICE_AUDIO } from "../src/bridge/protocol.js";
import type { TeamSpeakAccountConfig } from "../src/config.js";
import { BRIDGE_FRAME_BYTES } from "../src/voice/audio.js";
import { createSttTtsLane, resolveTeamSpeakWakeNames } from "../src/voice/stt-tts-lane.js";
import type { SpeechSynthesisOutcome, SpeechSynthesizer } from "../src/voice/speech.js";
import type { TeamSpeakVoiceAgentTurn } from "../src/voice/stt-tts-speaker-session.js";
import { TeamSpeakVoiceRuntime, type VoiceSpeakerSession } from "../src/voice/voice-runtime.js";
import type { SttProvider, SttRequest, SttResult } from "../src/voice/stt-provider.js";
import { MockBridge, rosterEntry, toneFrame48k } from "./mock-bridge.js";

const FRAME_20MS = toneFrame48k();
const SELF_CLIENT_ID = 1;
const PHATT = 7;
const GUEST = 9;

/** A one-second reply, so a chunked enqueue is observable on the wire. */
const REPLY_PCM = Buffer.alloc(BRIDGE_FRAME_BYTES * 50, 3);

class FakeTranscriber implements SttProvider {
  readonly id = "whisper-local";
  readonly kind = "local" as const;
  readonly requests: SttRequest[] = [];
  /** Transcripts handed out in order; the last one repeats. */
  constructor(private readonly transcripts: string[]) {}

  async transcribe(request: SttRequest): Promise<SttResult> {
    this.requests.push(request);
    const index = Math.min(this.requests.length - 1, this.transcripts.length - 1);
    return { text: this.transcripts[index] ?? "", provider: this.id, ms: 11 };
  }
}

class FakeSynthesizer implements SpeechSynthesizer {
  readonly id = "minimax";
  readonly spoken: string[] = [];
  outcome: SpeechSynthesisOutcome = {
    status: "ok",
    pcm48kMono: REPLY_PCM,
    provider: "minimax",
    speakText: "",
  };

  /** When set, every synthesis call parks here until it resolves (queue tests). */
  hold: Promise<void> | undefined;

  async synthesize(text: string): Promise<SpeechSynthesisOutcome> {
    this.spoken.push(text);
    if (this.hold) {
      await this.hold;
    }
    return this.outcome;
  }
}

type Harness = {
  bridge: MockBridge;
  runtime: TeamSpeakVoiceRuntime;
  transcriber: FakeTranscriber;
  synthesizer: FakeSynthesizer;
  turns: Array<{ nickname: string; message: string; wakeName?: string }>;
  logs: string[];
  session: (clientId: number) => VoiceSpeakerSession;
};

function baseConfig(overrides: Partial<TeamSpeakAccountConfig> = {}): TeamSpeakAccountConfig {
  return {
    bridgeUrl: "ws://ts-bridge:9099",
    channel: "General Shit",
    voice: {
      mode: "stt-tts",
      streaming: {
        // Hangover 0 keeps `speaker_stop` synchronous, so the test asserts on
        // segmentation policy elsewhere and on the lane's wiring here.
        segmentation: { hangoverMs: 0, minSegmentMs: 0 },
      },
    },
    tools: { enabled: false },
    ...overrides,
  };
}

function createHarness(params: {
  config?: TeamSpeakAccountConfig;
  transcripts?: string[];
  reply?: string;
  /**
   * A streaming turn (PHA-3792): each entry is delivered through `onBlock`,
   * then the turn parks on `streamGate` before resolving with the joined text
   * -- the model is "still generating" until the test releases it.
   */
  stream?: string[];
  streamGate?: Promise<void>;
} = {}): Harness {
  const config = params.config ?? baseConfig();
  const bridge = new MockBridge();
  const transcriber = new FakeTranscriber(params.transcripts ?? ["what did I miss"]);
  const synthesizer = new FakeSynthesizer();
  const turns: Array<{ nickname: string; message: string; wakeName?: string }> = [];
  const logs: string[] = [];
  const runAgentTurn: TeamSpeakVoiceAgentTurn = async (turn, hooks) => {
    turns.push({
      nickname: turn.nickname,
      message: turn.message,
      ...(turn.wakeName ? { wakeName: turn.wakeName } : {}),
    });
    if (params.stream) {
      for (const block of params.stream) {
        hooks.onBlock?.(block);
      }
      await params.streamGate;
      return { text: params.stream.join("\n"), path: "block-stream", blocks: params.stream.length };
    }
    return params.reply ?? "nothing much";
  };

  let runtime: TeamSpeakVoiceRuntime | undefined;
  const lane = createSttTtsLane({
    cfg: {} as never,
    config,
    accountId: "default",
    agentId: "sexton",
    sessionKey: "teamspeak:default",
    runtime: {
      agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
      tts: {
        prepareTtsRequest: () => {
          throw new Error("the fake synthesizer owns synthesis in this test");
        },
        textToSpeech: async () => {
          throw new Error("the fake synthesizer owns synthesis in this test");
        },
      },
    },
    humanParticipantCount: () => runtime?.humanParticipantCount() ?? 0,
    log: (message) => logs.push(message),
    deps: {
      createTranscriber: () => transcriber,
      createSynthesizer: () => synthesizer,
      runAgentTurn,
    },
  });
  if (!lane.ok) {
    throw new Error(`lane refused: ${lane.reason}`);
  }

  runtime = new TeamSpeakVoiceRuntime({
    accountId: "default",
    config,
    createSocket: bridge.createSocket,
    minBargeInAudioEndMs: 0,
    providerId: () => `${lane.lane.transcriberId}+${lane.lane.speechProviderId}`,
    log: (message) => logs.push(message),
    createSpeakerSession: (client, playback) => lane.lane.createSpeakerSession(client, playback),
  });
  const live = runtime;
  runtime.start();
  bridge.accept();

  return {
    bridge,
    runtime: live,
    transcriber,
    synthesizer,
    turns,
    logs,
    session: (clientId) =>
      (live as unknown as { sessions: { get(id: number): VoiceSpeakerSession } }).sessions.get(
        clientId,
      ),
  };
}

/** Join the room with `humans` people besides the bot. */
function joinRoom(harness: Harness, humans: number[]): void {
  harness.bridge.deliver({
    type: "state",
    state: {
      connected: true,
      channelId: 3,
      channelName: "General Shit",
      ownClientId: SELF_CLIENT_ID,
    },
  });
  harness.bridge.deliver({
    type: "roster",
    roster: [
      rosterEntry(SELF_CLIENT_ID, "Sexton"),
      ...humans.map((clientId) => rosterEntry(clientId, `human-${clientId}`)),
    ],
  });
}

/** Replay one talk burst for a speaker. */
function speak(harness: Harness, clientId: number, frames = 50): void {
  harness.bridge.deliver({ type: "speaker_start", clientId });
  for (let index = 0; index < frames; index += 1) {
    harness.bridge.deliver({
      type: "speaker_audio",
      clientId,
      nickname: `human-${clientId}`,
      seq: index,
      pcm48kMono: FRAME_20MS,
    });
  }
  harness.bridge.deliver({ type: "speaker_stop", clientId });
}

/** Let the transcribe -> agent -> synthesize chain settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe("stt-tts lane over the mock bridge", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("turns one talk burst into one transcript, one agent turn, and voice_audio", async () => {
    joinRoom(harness, [PHATT]);
    harness.bridge.clearSent();
    speak(harness, PHATT);
    await settle();

    expect(harness.transcriber.requests).toHaveLength(1);
    expect(harness.transcriber.requests[0]?.pcm48kMono.length).toBe(FRAME_20MS.length * 50);
    expect(harness.turns).toEqual([{ nickname: "human-7", message: "what did I miss" }]);
    expect(harness.synthesizer.spoken).toEqual(["nothing much"]);

    const voiceFrames = harness.bridge.sentOfType(TYPE_VOICE_AUDIO);
    expect(voiceFrames).toHaveLength(50);
    expect(Buffer.concat(voiceFrames.map((frame) => frame.payload))).toEqual(REPLY_PCM);
  });

  it("keeps one segment per speaker rather than merging the room", async () => {
    joinRoom(harness, [PHATT, GUEST]);
    harness.bridge.clearSent();
    // Two people talking at once, interleaved on the wire the way the bridge
    // delivers them. The session map is keyed by clientId for exactly this.
    harness.bridge.deliver({ type: "speaker_start", clientId: PHATT });
    harness.bridge.deliver({ type: "speaker_start", clientId: GUEST });
    for (let index = 0; index < 50; index += 1) {
      for (const clientId of [PHATT, GUEST]) {
        harness.bridge.deliver({
          type: "speaker_audio",
          clientId,
          nickname: `human-${clientId}`,
          seq: index,
          pcm48kMono: FRAME_20MS,
        });
      }
    }
    harness.bridge.deliver({ type: "speaker_stop", clientId: PHATT });
    harness.bridge.deliver({ type: "speaker_stop", clientId: GUEST });
    await settle();

    expect(harness.transcriber.requests).toHaveLength(2);
    for (const request of harness.transcriber.requests) {
      expect(request.pcm48kMono.length).toBe(FRAME_20MS.length * 50);
    }
    expect(harness.transcriber.requests.map((request) => request.label).sort()).toEqual([
      "human-7",
      "human-9",
    ]);
  });

  it("answers an unaddressed utterance when one human is in the channel", async () => {
    joinRoom(harness, [PHATT]);
    expect(harness.session(PHATT).wakeNameRequired).toBe(false);

    speak(harness, PHATT);
    await settle();
    expect(harness.turns).toHaveLength(1);
  });

  it("requires a wake name once a second human joins", async () => {
    joinRoom(harness, [PHATT, GUEST]);
    expect(harness.session(PHATT).wakeNameRequired).toBe(true);
    harness.bridge.clearSent();

    speak(harness, PHATT);
    await settle();

    expect(harness.transcriber.requests).toHaveLength(1);
    expect(harness.turns).toHaveLength(0);
    expect(harness.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
    expect(harness.logs.some((line) => line.includes("wake gate declined"))).toBe(true);
  });

  it("answers a wake-named utterance in a two-human room, with the name stripped", async () => {
    // `wakeName` echoes the configured spelling, not the heard one: here the
    // default routed-agent name "sexton", matched against a capitalised hearing.
    const gated = createHarness({ transcripts: ["Sexton, what did I miss"] });
    joinRoom(gated, [PHATT, GUEST]);
    gated.bridge.clearSent();

    speak(gated, PHATT);
    await settle();

    expect(gated.turns).toEqual([
      { nickname: "human-7", message: "what did I miss", wakeName: "sexton" },
    ]);
    expect(gated.bridge.sentOfType(TYPE_VOICE_AUDIO).length).toBeGreaterThan(0);
  });

  it("stays silent on an empty transcript instead of waking the agent", async () => {
    const silent = createHarness({ transcripts: [""] });
    joinRoom(silent, [PHATT]);
    silent.bridge.clearSent();

    speak(silent, PHATT);
    await settle();

    expect(silent.transcriber.requests).toHaveLength(1);
    expect(silent.turns).toHaveLength(0);
    expect(silent.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
  });

  it("stays silent when the agent turn produces nothing speakable", async () => {
    const quiet = createHarness({ reply: "   " });
    joinRoom(quiet, [PHATT]);
    quiet.bridge.clearSent();

    speak(quiet, PHATT);
    await settle();

    expect(quiet.turns).toHaveLength(1);
    expect(quiet.synthesizer.spoken).toHaveLength(0);
    expect(quiet.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(0);
  });

  it("records the latency budget for the turn it just spoke", async () => {
    joinRoom(harness, [PHATT]);
    speak(harness, PHATT);
    await settle();

    const session = harness.session(PHATT) as unknown as {
      timings?: { segmentMs: number; firstAudioMs: number };
    };
    expect(session.timings?.segmentMs).toBe(1_000);
    expect(session.timings?.firstAudioMs).toBeGreaterThanOrEqual(0);
    expect(harness.logs.some((line) => line.includes("firstAudioMs="))).toBe(true);
  });

  it("pipelines a multi-sentence reply as separate synthesis calls, not one (PHA-3607)", async () => {
    const chatty = createHarness({
      reply:
        "This is the first full sentence of the reply. Here comes a second full sentence about the plan.",
    });
    joinRoom(chatty, [PHATT]);
    chatty.bridge.clearSent();

    speak(chatty, PHATT);
    await settle();

    // Two T2A round trips, not one for the whole reply -- that is the whole
    // point of pipelining: playback of the first sentence can start before
    // the second sentence has even started synthesizing.
    expect(chatty.synthesizer.spoken).toEqual([
      "This is the first full sentence of the reply.",
      "Here comes a second full sentence about the plan.",
    ]);
    // Both chunks land on the wire, in order, and the lane holds the room for
    // the whole turn rather than releasing it between chunks.
    const voiceFrames = chatty.bridge.sentOfType(TYPE_VOICE_AUDIO);
    expect(voiceFrames).toHaveLength(100);
    expect(Buffer.concat(voiceFrames.map((frame) => frame.payload))).toEqual(
      Buffer.concat([REPLY_PCM, REPLY_PCM]),
    );
    expect(chatty.logs.some((line) => line.includes("ttsChunks=2/2"))).toBe(true);
  });

  it("starts speaking the first block while the agent turn is still running (PHA-3792)", async () => {
    let finishGenerating: () => void = () => undefined;
    const streaming = createHarness({
      stream: ["The first block is a whole sentence.", "The second block is another one."],
      streamGate: new Promise<void>((resolve) => {
        finishGenerating = resolve;
      }),
    });
    joinRoom(streaming, [PHATT]);
    streaming.bridge.clearSent();

    speak(streaming, PHATT);
    await settle();
    // The agent turn has not resolved, and the first block is already on the
    // wire: synthesized and enqueued during agentMs, not after it.
    expect(streaming.turns).toHaveLength(1);
    expect(streaming.synthesizer.spoken).toEqual([
      "The first block is a whole sentence.",
      "The second block is another one.",
    ]);
    expect(streaming.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(100);
    expect(streaming.logs.some((line) => line.includes("stt-tts turn "))).toBe(false);

    finishGenerating();
    await settle();
    await settle();
    // The returned text matched the blocks, so nothing was spoken twice.
    expect(streaming.synthesizer.spoken).toHaveLength(2);
    expect(streaming.bridge.sentOfType(TYPE_VOICE_AUDIO)).toHaveLength(100);
    const line = streaming.logs.find((entry) => entry.includes("stt-tts turn "));
    expect(line).toContain("ttsChunks=2/2");
    expect(line).toContain("replyPath=block-stream blocks=2");
    expect(line).toMatch(/firstBlockMs=\d+/);
  });

  it("transcribes the next utterance while the previous answer is still synthesizing (PHA-3789)", async () => {
    const busy = createHarness({ transcripts: ["first thing", "second thing"] });
    joinRoom(busy, [PHATT]);
    let release: () => void = () => undefined;
    busy.synthesizer.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    speak(busy, PHATT);
    await settle();
    // Turn one is parked inside synthesis, holding the serialized queue.
    expect(busy.synthesizer.spoken).toHaveLength(1);
    expect(busy.transcriber.requests).toHaveLength(1);

    speak(busy, PHATT);
    await settle();
    // STT for utterance two has already been issued: it does not wait behind
    // the first turn's synthesis the way the agent turn and playback must.
    expect(busy.transcriber.requests).toHaveLength(2);
    expect(busy.turns).toHaveLength(1);

    release();
    await settle();
    await settle();
    expect(busy.turns.map((turn) => turn.message)).toEqual(["first thing", "second thing"]);
    expect(busy.synthesizer.spoken).toHaveLength(2);
    expect(busy.logs.some((line) => /queueWaitMs=\d+/.test(line))).toBe(true);
  });

  it("reports the lane it is running in !sexton status", async () => {
    joinRoom(harness, [PHATT]);
    const snapshot = harness.runtime.snapshot();
    expect(snapshot.voiceMode).toBe("stt-tts");
    expect(snapshot.providerId).toBe("whisper-local+minimax");
  });
});

describe("stt-tts lane construction", () => {
  it("refuses a hosted transcription provider rather than silently metering", () => {
    const refused = createSttTtsLane({
      cfg: {} as never,
      config: baseConfig({
        voice: {
          mode: "stt-tts",
          streaming: { transcription: { provider: "deepgram" } },
        },
      }),
      accountId: "default",
      agentId: "sexton",
      sessionKey: "teamspeak:default",
      runtime: {
        agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
        tts: {
          prepareTtsRequest: () => ({ cfg: {}, directives: { cleanedText: "", overrides: {} } }),
          textToSpeech: async () => ({ success: false }),
        },
      },
      humanParticipantCount: () => 1,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.reason).toContain("deepgram");
    expect(refused.reason).toContain("whisper-local");
  });

  it("refuses at startup when the TTS provider is not configured on the gateway", () => {
    const asked: string[] = [];
    const refused = createSttTtsLane({
      cfg: {} as never,
      config: baseConfig({ voice: { mode: "stt-tts" } }),
      accountId: "default",
      agentId: "sexton",
      sessionKey: "teamspeak:default",
      runtime: {
        agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
        tts: {
          prepareTtsRequest: () => ({ cfg: {}, directives: { cleanedText: "", overrides: {} } }),
          textToSpeech: async () => ({ success: false }),
        },
      },
      humanParticipantCount: () => 1,
      deps: {
        isSpeechProviderConfigured: (provider) => {
          asked.push(provider);
          return false;
        },
      },
    });

    expect(asked).toEqual(["minimax"]);
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.reason).toContain('TTS provider "minimax" is not configured');
  });

  /** The lane with no fake transcriber injected, so the registry does the choosing. */
  const laneFromConfig = (
    voice: NonNullable<TeamSpeakAccountConfig["voice"]>,
    env: Record<string, string | undefined> = {},
    log?: (message: string) => void,
  ) =>
    createSttTtsLane({
      cfg: {} as never,
      config: baseConfig({ voice }),
      accountId: "default",
      agentId: "sexton",
      sessionKey: "teamspeak:default",
      runtime: {
        agent: { runCommandFromIngress: async () => ({ payloads: [] }) },
        tts: {
          prepareTtsRequest: () => ({ cfg: {}, directives: { cleanedText: "", overrides: {} } }),
          textToSpeech: async () => ({ success: false }),
        },
      },
      humanParticipantCount: () => 1,
      env,
      ...(log ? { log } : {}),
      deps: { createSynthesizer: () => new FakeSynthesizer() },
    });

  it("refuses a hosted primary until the persona opts in, then builds it (PHA-3790)", () => {
    const refused = laneFromConfig(
      { mode: "stt-tts", streaming: { transcription: { provider: "minimax", apiKey: "k" } } },
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/allowHosted/);

    // Same config plus the one explicit key. No code change in between: that is
    // the whole claim of §4.7.
    const allowed = laneFromConfig({
      mode: "stt-tts",
      streaming: {
        transcription: { provider: "minimax", apiKey: "k", allowHosted: true },
      },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.ok === true && allowed.lane.transcriberId).toBe("minimax-asr");
  });

  it("swaps the primary by name with no other config change", () => {
    const lane = laneFromConfig({
      mode: "stt-tts",
      streaming: { transcription: { provider: "whisper" } },
    });
    expect(lane.ok === true && lane.lane.transcriberId).toBe("whisper-local");
  });

  it("wires the router when the secondary builds, and reports both ids", () => {
    const lane = laneFromConfig(
      {
        mode: "stt-tts",
        streaming: { secondaryTranscription: {} },
      },
      { MINIMAX_API_KEY: "sk-cp-live-key" },
    );
    expect(lane.ok === true && lane.lane.transcriberId).toBe("whisper-local+minimax-asr");
  });

  it("warns but keeps the lane when the secondary cannot be built", () => {
    // Losing the upgrade must not lose the channel: the primary on its own is a
    // complete transcriber, so an unbuildable secondary is a log line.
    const logs: string[] = [];
    const lane = laneFromConfig(
      { mode: "stt-tts", streaming: { secondaryTranscription: {} } },
      {},
      (message) => logs.push(message),
    );
    expect(lane.ok).toBe(true);
    expect(lane.ok === true && lane.lane.transcriberId).toBe("whisper-local");
    expect(logs.join(" ")).toMatch(/secondary transcription disabled.*needs an apiKey/);
  });

  it("leaves the secondary off entirely when no block asked for it", () => {
    const logs: string[] = [];
    const lane = laneFromConfig(
      { mode: "stt-tts" },
      { MINIMAX_API_KEY: "sk-cp-live-key" },
      (message) => logs.push(message),
    );
    expect(lane.ok === true && lane.lane.transcriberId).toBe("whisper-local");
    expect(logs.join(" ")).not.toMatch(/secondary/);
  });

  it("defaults wake names to the routed agent name plus OpenClaw", () => {
    expect(resolveTeamSpeakWakeNames({ config: baseConfig(), agentId: "sexton" })).toEqual([
      "sexton",
      "OpenClaw",
    ]);
    expect(
      resolveTeamSpeakWakeNames({
        config: baseConfig({ voice: { mode: "stt-tts", wakeNames: ["Sexton", " "] } }),
        agentId: "sexton",
      }),
    ).toEqual(["Sexton"]);
  });

  it("reads wake config from voice, and still honours the PHA-3175 spelling", () => {
    expect(
      resolveTeamSpeakWakeNames({
        config: baseConfig({ voice: { mode: "stt-tts", realtime: { wakeNames: ["Verger"] } } }),
        agentId: "sexton",
      }),
    ).toEqual(["Verger"]);
  });

  it("constructs no realtime voice provider anywhere in the lane", async () => {
    // The budget ceiling stated structurally: every provider OpenClaw resolves
    // through these two entry points is metered, so the lane must not name them.
    const modules = [
      "stt-tts-lane.ts",
      "stt-tts-speaker-session.ts",
      "speech.ts",
      "whisper-local.ts",
      "segmenter.ts",
      "agent-turn.ts",
    ];
    for (const module of modules) {
      const source = await readFile(
        new URL(`../src/voice/${module}`, import.meta.url),
        "utf8",
      );
      expect(source, module).not.toMatch(/resolveConfiguredRealtimeVoiceProvider|createRealtimeVoiceSessionHarness/);
    }
  });
});
