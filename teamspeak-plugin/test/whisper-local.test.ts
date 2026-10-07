/**
 * The local STT client (#3228).
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
  readWhisperConfidence,
  SPEAKER_CLIENT_ID_HEADER,
  type WhisperFetch,
} from "../src/voice/whisper-local.js";
import { toneFrame48k } from "./mock-bridge.js";
import { sttSlotConfig } from "./stt-fixtures.js";

const URL = "http://whisper:8080/inference";
const CONFIG = sttSlotConfig();

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
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    const heard = await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });

    expect(heard.text).toBe("what did I miss");
    expect(heard.provider).toBe("whisper-local");
    expect(heard.ms).toBeGreaterThanOrEqual(0);
    // json, not verbose_json: the score is not worth +1.8s a turn by default.
    expect(calls[0]?.form.get("response_format")).toBe("json");
    expect(heard.confidence).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL);

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

  it("sends the speaker's clientId as a header for a coalescing proxy to key on (#3607)", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hey" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt", clientId: 42 });

    expect(calls[0]?.headers).toEqual({ [SPEAKER_CLIENT_ID_HEADER]: "42" });
  });

  it("omits the header when no clientId is known", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hey" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });

    expect(calls[0]?.headers).toBeUndefined();
  });

  it("omits the language field when the operator asked for auto-detect", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hola" }));
    const transcriber = new LocalWhisperTranscriber({
      config: sttSlotConfig({ language: "auto" }),
      url: URL,
      fetchFn,
    });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });
    expect(calls[0]?.form.get("language")).toBeNull();
  });

  it("reports the provider id used by the lane and by !sexton status", () => {
    expect(new LocalWhisperTranscriber({ config: CONFIG, url: URL }).id).toBe("whisper-local");
  });

  it("raises the server's own message on a non-2xx response", async () => {
    const { fetchFn } = stubFetch("model not loaded\nstack...", { ok: false, status: 500 });
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    await expect(transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" })).rejects.toThrow(
      /whisper-local HTTP 500 .*model not loaded/,
    );
  });

  it("returns nothing for a segment with no samples", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "should not be asked" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    expect((await transcriber.transcribe({ pcm48kMono: Buffer.alloc(0), label: "phatt" })).text).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("primes the decoder with the configured prompt, and lets a request override it", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "sexton" }));
    const transcriber = new LocalWhisperTranscriber({
      config: sttSlotConfig({ prompt: "Sexton, Bexton, Trixie" }),
      url: URL,
      fetchFn,
    });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });
    expect(calls[0]?.form.get("prompt")).toBe("Sexton, Bexton, Trixie");

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt", prompt: "just this" });
    expect(calls[1]?.form.get("prompt")).toBe("just this");
  });

  it("omits the prompt field entirely when none is configured", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hi" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });
    expect(calls[0]?.form.get("prompt")).toBeNull();
  });

  it("takes a per-request language over the configured one", async () => {
    const { fetchFn, calls } = stubFetch(JSON.stringify({ text: "hola" }));
    const transcriber = new LocalWhisperTranscriber({ config: CONFIG, url: URL, fetchFn });

    await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt", lang: "es" });
    expect(calls[0]?.form.get("language")).toBe("es");
  });

  it("asks for verbose_json and scores the transcript only when confidence is on", async () => {
    const { fetchFn, calls } = stubFetch(
      JSON.stringify({
        text: "what did I miss",
        segments: [{ text: "what did I miss", avg_logprob: -0.2231435513 }],
      }),
    );
    const transcriber = new LocalWhisperTranscriber({
      config: sttSlotConfig({ confidence: true }),
      url: URL,
      fetchFn,
    });

    const heard = await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" });
    expect(calls[0]?.form.get("response_format")).toBe("verbose_json");
    // exp(-0.2231435513) = 0.8
    expect(heard.confidence).toBeCloseTo(0.8, 5);
  });

  it("leaves confidence undefined when the build answered without a score", async () => {
    const { fetchFn } = stubFetch(JSON.stringify({ text: "what did I miss" }));
    const transcriber = new LocalWhisperTranscriber({
      config: sttSlotConfig({ confidence: true }),
      url: URL,
      fetchFn,
    });

    // A missing score is not a low one, so it must not arrive as 0.
    expect(
      (await transcriber.transcribe({ pcm48kMono: speech(), label: "phatt" })).confidence,
    ).toBeUndefined();
  });
});

describe("readWhisperConfidence", () => {
  it("averages avg_logprob across segments", () => {
    // exp((-0.1 + -0.3) / 2) = exp(-0.2)
    const score = readWhisperConfidence(
      JSON.stringify({ segments: [{ avg_logprob: -0.1 }, { avg_logprob: -0.3 }] }),
    );
    expect(score).toBeCloseTo(Math.exp(-0.2), 6);
  });

  it("reads a single-segment verbose response off the top level", () => {
    expect(readWhisperConfidence(JSON.stringify({ text: "hi", avg_logprob: 0 }))).toBe(1);
  });

  it("returns undefined rather than a number it does not have", () => {
    expect(readWhisperConfidence(JSON.stringify({ text: "hi" }))).toBeUndefined();
    expect(readWhisperConfidence("plain text body")).toBeUndefined();
    expect(readWhisperConfidence("{not json")).toBeUndefined();
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
