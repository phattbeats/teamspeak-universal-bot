/**
 * The local STT client (PHA-3228).
 *
 * The assertions worth having here are the ones that would otherwise only fail
 * on a live channel: that the audio reaches whisper as a 16 kHz WAV it can
 * actually decode, and that its non-speech placeholders never become a turn.
 */
import { describe, expect, it } from "vitest";
import { encodeWavPcm16Mono, STT_SAMPLE_RATE } from "../src/voice/audio.js";
import {
  LocalWhisperTranscriber,
  normalizeTranscript,
  readTranscriptText,
  SPEAKER_CLIENT_ID_HEADER,
  type WhisperFetch,
} from "../src/voice/whisper-local.js";
import { toneFrame48k } from "./mock-bridge.js";

const CONFIG = {
  provider: "whisper-local" as const,
  url: "http://whisper:8080/inference",
  model: undefined,
  language: "en",
  timeoutMs: 15_000,
};

function speech(frames = 50): Buffer {
  return Buffer.concat(Array.from({ length: frames }, () => toneFrame48k()));
}

function stubFetch(
  body: string,
  options: { ok?: boolean; status?: number } = {},
): {
  fetchFn: WhisperFetch;
  calls: Array<{ url: string; form: FormData; headers: Record<string, string> | undefined }>;
} {
  const calls: Array<{ url: string; form: FormData; headers: Record<string, string> | undefined }> =
    [];
  const fetchFn: WhisperFetch = async (url, init) => {
    calls.push({ url, form: init.body, headers: init.headers });
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      text: async () => body,
    };
  };
  return { fetchFn, calls };
}

describe("LocalWhisperTranscriber", () => {
  it("posts a 16 kHz mono WAV and returns the transcript", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: " what did I miss " }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, fetchFn });

    const text = await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });

    expect(text).toBe("what did I miss");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CONFIG.url);

    const file = calls[0]?.form.get("file");
    expect(file).toBeInstanceOf(Blob);
    const wav = Buffer.from(await (file as Blob).arrayBuffer());
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(STT_SAMPLE_RATE);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    // 1000 ms at 48 kHz resampled to 16 kHz: a third of the samples, 2 bytes each.
    expect(wav.readUInt32LE(40)).toBeCloseTo(16_000 * 2, -3);
    expect(calls[0]?.form.get("language")).toBe("en");
  });

  it("sends the speaker's clientId as a header for a coalescing proxy to key on (PHA-3607)", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hey" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt", clientId: 42 });

    expect(calls[0]?.headers).toEqual({ [SPEAKER_CLIENT_ID_HEADER]: "42" });
  });

  it("omits the header when no clientId is known", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hey" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });

    expect(calls[0]?.headers).toBeUndefined();
  });

  it("omits the language field when the operator asked for auto-detect", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hola" }));
    const transcriber = new LocalWhisperTranscriber({
      config: { ...CONFIG, language: "auto" },
      fetchFn,
    });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });
    expect(calls[0]?.form.get("language")).toBeNull();
  });

  it("reports the provider id used by the lane and by !sexton status", () => {
    expect(new LocalWhisperTranscriber({ config: CONFIG }).id).toBe("whisper-local");
  });

  it("raises the server's own message on a non-2xx response", async () => {
    const { fetchFn } = stubFetch("model not loaded\nstack...", { ok: false, status: 500 });
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, fetchFn });

    await expect(transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" })).rejects.toThrow(
      /whisper-local HTTP 500 .*model not loaded/,
    );
  });

  it("returns nothing for a segment with no samples", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "should not be asked" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, fetchFn });

    expect(await transcriber.transcribe({ pcm48kMono: Buffer.alloc(0), label: "phatt" })).toBe("");
    expect(calls).toHaveLength(0);
  });
});

describe("readTranscriptText", () => {
  it("reads the /inference and OpenAI-compatible json shape", () => {
    expect(readTranscriptText('{"text":"hello there"}')).toBe("hello there");
  });

  it("joins whisper.cpp segment arrays", () => {
    expect(
      readTranscriptText('{"transcription":[{"text":"hello"},{"text":" there"}]}'),
    ).toBe("hello  there");
    expect(readTranscriptText('[{"text":"a"},{"text":"b"}]')).toBe("a b");
  });

  it("falls back to the raw body for builds that answer in plain text", () => {
    expect(readTranscriptText("  hello there\n")).toBe("hello there");
    expect(readTranscriptText("{not json")).toBe("{not json");
  });
});

describe("normalizeTranscript", () => {
  it("collapses whitespace", () => {
    expect(normalizeTranscript("  what   did\n I miss ")).toBe("what did I miss");
  });

  it("drops whisper's non-speech placeholders rather than waking the agent", () => {
    for (const placeholder of ["[BLANK_AUDIO]", "(silence)", "[Music]", " [ Inaudible ] "]) {
      expect(normalizeTranscript(placeholder)).toBe("");
    }
  });

  it("strips a leading annotation but keeps the speech after it", () => {
    expect(normalizeTranscript("[MUSIC] sexton, what did I miss")).toBe(
      "sexton, what did I miss",
    );
  });
});

describe("encodeWavPcm16Mono", () => {
  it("declares the byte counts a decoder reads", () => {
    const pcm = Buffer.alloc(320);
    const wav = encodeWavPcm16Mono(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt32LE(28)).toBe(STT_SAMPLE_RATE * 2);
  });
});
