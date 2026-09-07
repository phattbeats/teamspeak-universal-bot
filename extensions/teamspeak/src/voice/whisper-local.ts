/**
 * Local speech-to-text over the whisper.cpp HTTP server (PHA-3228).
 *
 * OpenClaw registers four realtime transcription providers — deepgram, openai,
 * elevenlabs, mistral — and every one is metered and hosted. This lane's
 * constraint is the opposite on both axes: $0 marginal cost, and speaker audio
 * that never leaves the house, which is a promise the channel notice makes out
 * loud. So the transcriber is a whisper.cpp sidecar on the TS6 Docker network
 * and this file is its client.
 *
 * Scope note: PHA-3228 explicitly allows a teamspeak-local module here instead
 * of a general `realtimeTranscriptionProviders` entry, because the SDK's
 * provider contract is a *streaming* one (`connect`/`sendAudio`/`close`) and
 * whisper.cpp's server is request/response over finished segments. The seam is
 * the `SegmentTranscriber` interface below: lifting this to a real provider
 * later means implementing that interface elsewhere, not touching the lane.
 */
import type { ResolvedTeamSpeakTranscriptionConfig } from "../config.js";
import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";

export type TranscriptionRequest = {
  /** One closed utterance, in the bridge's native 48 kHz mono PCM16. */
  pcm48kMono: Buffer;
  /** Speaker label, for logs only; the transcriber is per-segment, not per-person. */
  label: string;
};

export type SegmentTranscriber = {
  /** Provider id, surfaced in `!sexton status` and asserted on in tests. */
  readonly id: string;
  /** Returns the transcript, or an empty string when the segment held no speech. */
  transcribe(request: TranscriptionRequest): Promise<string>;
};

/** Injectable for tests; production uses the global fetch. */
export type WhisperFetch = (
  url: string,
  init: { method: string; body: FormData; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type LocalWhisperTranscriberParams = {
  config: ResolvedTeamSpeakTranscriptionConfig;
  fetchFn?: WhisperFetch | undefined;
  log?: ((message: string) => void) | undefined;
};

/**
 * whisper.cpp emits these for silence, music, and room tone. They are not
 * transcripts; letting one through wakes the agent for a cough.
 */
const NON_SPEECH_TRANSCRIPTS = new Set([
  "[blank_audio]",
  "[ blank_audio ]",
  "(blank_audio)",
  "[silence]",
  "(silence)",
  "[music]",
  "(music)",
  "[inaudible]",
  "(inaudible)",
  "[sound]",
  "you",
  "thank you.",
  "thanks for watching!",
]);

export class LocalWhisperTranscriber implements SegmentTranscriber {
  private readonly fetchFn: WhisperFetch;

  constructor(private readonly params: LocalWhisperTranscriberParams) {
    this.fetchFn = params.fetchFn ?? (defaultWhisperFetch as WhisperFetch);
  }

  get id(): string {
    return this.params.config.provider;
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return "";
    }
    const wav = encodeWavPcm16Mono(pcm16k);
    const config = this.params.config;

    const form = new FormData();
    // `new Uint8Array(wav)` rather than the Buffer: Buffer is backed by
    // ArrayBufferLike, which BlobPart does not accept under strict lib types.
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (config.language && config.language !== "auto") {
      form.append("language", config.language);
    }
    if (config.model) {
      form.append("model", config.model);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      // Deliberately the plain fetch, not `fetchWithSsrFGuard`: the whole point
      // of this call is that it targets a private-network sidecar, which is
      // exactly what the SSRF guard exists to refuse.
      const response = await this.fetchFn(config.url, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `whisper-local HTTP ${response.status} from ${config.url}: ${firstLine(body)}`,
        );
      }
      return normalizeTranscript(readTranscriptText(body));
    } finally {
      clearTimeout(timeout);
    }
  }
}

const defaultWhisperFetch = (
  url: string,
  init: { method: string; body: FormData; signal: AbortSignal },
): Promise<Response> => fetch(url, init);

/**
 * whisper.cpp's server answers `/inference` with `{"text": "..."}`, and its
 * OpenAI-compatible `/v1/audio/transcriptions` route with the same key. Older
 * builds return the transcript as a bare body, so a non-JSON response is read
 * as text rather than treated as a failure.
 */
export function readTranscriptText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => readSegmentText(entry)).join(" ");
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.transcription)) {
      return record.transcription.map((entry) => readSegmentText(entry)).join(" ");
    }
    if (Array.isArray(record.segments)) {
      return record.segments.map((entry) => readSegmentText(entry)).join(" ");
    }
  }
  return "";
}

function readSegmentText(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const text = (entry as Record<string, unknown>).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

/** Collapse whitespace and drop whisper's non-speech placeholders. */
export function normalizeTranscript(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  // A transcript that is *only* an annotation is not speech, whatever the
  // annotation says — whisper invents these freely for room tone.
  const stripped = collapsed.replace(/^(?:\s*(?:\[[^\]]*\]|\([^)]*\)))+\s*/, "").trim();
  if (!stripped) {
    return "";
  }
  return NON_SPEECH_TRANSCRIPTS.has(stripped.toLowerCase()) ? "" : stripped;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.slice(0, 200) ?? "";
}
