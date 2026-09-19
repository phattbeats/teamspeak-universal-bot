/**
 * Reply text -> bridge PCM (PHA-3228).
 *
 * The two things worth pinning: the TTS override the host runtime is handed
 * (pinning the model id is what keeps a MiniMax Coding Plan key working), and
 * that fallback is off — a silent fallback would move this lane onto a metered
 * provider, which is the one thing it may not do.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { resolveTeamSpeakSpeechConfig } from "../src/config.js";
import {
  buildTtsOverride,
  RuntimeSpeechSynthesizer,
  splitIntoSpeechChunks,
  type AudioDecodeChildProcess,
  type AudioDecodeSpawn,
  type TeamSpeakTtsRuntime,
} from "../src/voice/speech.js";

const SPEECH_CONFIG = resolveTeamSpeakSpeechConfig({
  voice: { mode: "stt-tts", streaming: { speech: { voiceId: "English_expressive_narrator" } } },
});

type FakeChild = AudioDecodeChildProcess & {
  emitStdout: (chunk: Buffer) => void;
  emitStderr: (chunk: string) => void;
  exit: (code: number | null) => void;
  fail: (error: Error) => void;
};

function createFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const process = new EventEmitter();
  return {
    stdout: stdout as unknown as AudioDecodeChildProcess["stdout"],
    stderr: stderr as unknown as AudioDecodeChildProcess["stderr"],
    on: (event, listener) => process.on(event, listener as (...args: unknown[]) => void),
    kill: () => {},
    emitStdout: (chunk) => stdout.emit("data", chunk),
    emitStderr: (chunk) => stderr.emit("data", chunk),
    exit: (code) => process.emit("exit", code),
    fail: (error) => process.emit("error", error),
  };
}

type TtsCall = { params: Record<string, unknown>; kind: "prepare" | "synthesize" };

function createTtsRuntime(
  result: { success: boolean; audioPath?: string; provider?: string; error?: string },
): { tts: TeamSpeakTtsRuntime; calls: TtsCall[] } {
  const calls: TtsCall[] = [];
  const tts: TeamSpeakTtsRuntime = {
    prepareTtsRequest: (params) => {
      calls.push({ kind: "prepare", params: params as unknown as Record<string, unknown> });
      return {
        cfg: { prepared: true },
        directives: { cleanedText: params.text, overrides: {} },
      };
    },
    textToSpeech: async (params) => {
      calls.push({ kind: "synthesize", params: params as unknown as Record<string, unknown> });
      return result;
    },
  };
  return { tts, calls };
}

describe("buildTtsOverride", () => {
  it("pins the provider, the model, and the free-form voice id", () => {
    expect(buildTtsOverride(SPEECH_CONFIG)).toEqual({
      provider: "minimax",
      providers: { minimax: { model: "speech-2.8-hd", voiceId: "English_expressive_narrator" } },
      timeoutMs: 20_000,
    });
  });

  it("defaults to the new-version model id, because old ids return 2056", () => {
    // MiniMax Coding Plan keys route by model version: speech-2.8-hd resolves,
    // speech-2.6-hd does not (MiniMax-AI/MiniMax-MCP#80).
    expect(resolveTeamSpeakSpeechConfig(undefined).model).toBe("speech-2.8-hd");
  });

  it("omits voiceId when unset so the provider default applies", () => {
    const override = buildTtsOverride(resolveTeamSpeakSpeechConfig(undefined));
    expect(override.providers.minimax).toEqual({ model: "speech-2.8-hd" });
  });
});

describe("RuntimeSpeechSynthesizer", () => {
  it("synthesizes, decodes to 48 kHz PCM, and deletes the file", async () => {
    const { tts, calls } = createTtsRuntime({
      success: true,
      audioPath: "/tmp/reply.mp3",
      provider: "minimax",
    });
    const child = createFakeChild();
    const spawned: Array<{ command: string; args: string[] }> = [];
    const spawnProcess: AudioDecodeSpawn = (command, args) => {
      spawned.push({ command, args });
      queueMicrotask(() => {
        child.emitStdout(Buffer.alloc(1920, 1));
        child.exit(0);
      });
      return child;
    };
    const removed: string[] = [];

    const synthesizer = new RuntimeSpeechSynthesizer({
      config: SPEECH_CONFIG,
      cfg: { host: true },
      tts,
      spawnProcess,
      removeFile: (path) => {
        removed.push(path);
      },
    });

    const result = await synthesizer.synthesize("the Sexton hears you");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.pcm48kMono.length).toBe(1920);
    expect(result.provider).toBe("minimax");
    expect(removed).toEqual(["/tmp/reply.mp3"]);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["-i", "/tmp/reply.mp3", "-ac", "1", "-ar", "48000", "-f", "s16le"]),
    );

    const synthesize = calls.find((call) => call.kind === "synthesize");
    // Fallback off: a fallback here would silently be a metered provider.
    expect(synthesize?.params.disableFallback).toBe(true);
    expect(synthesize?.params.channel).toBe("teamspeak");
    expect(synthesize?.params.timeoutMs).toBe(20_000);
    const prepare = calls.find((call) => call.kind === "prepare");
    expect(prepare?.params.override).toEqual(buildTtsOverride(SPEECH_CONFIG));
  });

  it("reports a synthesis failure instead of enqueueing silence", async () => {
    const { tts } = createTtsRuntime({ success: false, error: "MiniMax TTS auth missing" });
    const synthesizer = new RuntimeSpeechSynthesizer({
      config: SPEECH_CONFIG,
      cfg: {},
      tts,
      spawnProcess: () => createFakeChild(),
    });

    expect(await synthesizer.synthesize("hello")).toEqual({
      status: "failed",
      error: "MiniMax TTS auth missing",
    });
  });

  it("surfaces ffmpeg's last stderr line when the decode fails", async () => {
    const { tts } = createTtsRuntime({ success: true, audioPath: "/tmp/reply.mp3" });
    const child = createFakeChild();
    const synthesizer = new RuntimeSpeechSynthesizer({
      config: SPEECH_CONFIG,
      cfg: {},
      tts,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emitStderr("Invalid data found when processing input\n");
          child.exit(1);
        });
        return child;
      },
    });

    await expect(synthesizer.synthesize("hello")).rejects.toThrow(
      /ffmpeg exited code=1: Invalid data found/,
    );
  });

  it("skips synthesis when the reply has no speakable text", async () => {
    const { tts, calls } = createTtsRuntime({ success: true, audioPath: "/tmp/reply.mp3" });
    const synthesizer = new RuntimeSpeechSynthesizer({
      config: SPEECH_CONFIG,
      cfg: {},
      tts,
      spawnProcess: () => createFakeChild(),
    });

    expect(await synthesizer.synthesize("   ")).toEqual({ status: "empty" });
    expect(calls.some((call) => call.kind === "synthesize")).toBe(false);
  });
});

describe("splitIntoSpeechChunks", () => {
  it("keeps a single-sentence reply as one chunk", () => {
    expect(splitIntoSpeechChunks("Yeah, that's right.")).toEqual(["Yeah, that's right."]);
  });

  it("returns nothing for a blank reply", () => {
    expect(splitIntoSpeechChunks("   ")).toEqual([]);
  });

  it("splits a multi-sentence reply so the first sentence stands alone", () => {
    // Each of these clears the trailing-merge threshold on its own, so all
    // three come back as separate chunks rather than folding together.
    expect(
      splitIntoSpeechChunks(
        "This is the first full sentence of the reply. Here comes a second full sentence about the plan. And then a third one closes the whole thing out.",
      ),
    ).toEqual([
      "This is the first full sentence of the reply.",
      "Here comes a second full sentence about the plan.",
      "And then a third one closes the whole thing out.",
    ]);
  });

  it("never grows the first chunk, however short, so it stays fast to synthesize", () => {
    const chunks = splitIntoSpeechChunks(
      "Yes. That is a much longer follow-up sentence that goes well past the merge threshold on its own.",
    );
    expect(chunks[0]).toBe("Yes.");
  });

  it("merges short trailing fragments together instead of costing a round trip each", () => {
    const chunks = splitIntoSpeechChunks(
      "Here is the long first sentence that explains the whole plan in detail. Yeah. Right. Okay then.",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe("Yeah. Right. Okay then.");
  });

  it("handles a reply with no sentence-ending punctuation as one chunk", () => {
    expect(splitIntoSpeechChunks("just vibing in the channel")).toEqual([
      "just vibing in the channel",
    ]);
  });
});
