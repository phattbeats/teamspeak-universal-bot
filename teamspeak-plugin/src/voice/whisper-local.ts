/**
 * Local speech-to-text over the whisper.cpp HTTP server (PHA-3228).
 *
 * OpenClaw registers four realtime transcription providers — deepgram, openai,
 * elevenlabs, mistral — and every one is metered and hosted. This lane's
 * constraint is the opposite on both axes: $0 marginal cost, and speaker audio
 * that never leaves the house, which is a promise the channel notice makes out
 * loud. So the transcriber is a whisper.cpp sidecar on the TS6 Docker network
 * and this file is its client. Since PHA-3598/3607 that sidecar is the shared
 * `whisper` pool container, one server per bot.
 *
 * Scope note: PHA-3228 explicitly allows a teamspeak-local module here instead
 * of a general `realtimeTranscriptionProviders` entry, because the SDK's
 * provider contract is a *streaming* one (`connect`/`sendAudio`/`close`) and
 * whisper.cpp's server is request/response over finished segments. The seam is
 * the `SttProvider` contract in `stt-provider.ts` (PHA-3790): lifting this to a
 * real host provider later means implementing that interface elsewhere, not
 * touching the lane.
 *
 * ## Confidence costs 1.8 seconds a turn
 *
 * whisper.cpp will score a transcript — `avg_logprob`, `no_speech_prob` — but
 * only under `response_format=verbose_json`, and that format is not free.
 * Measured on the live container against one 3.29s clip, alternating formats:
 *
 *     json          1664ms   1939ms   2085ms
 *     verbose_json  3417ms   3727ms
 *
 * Roughly +1.8s on EVERY turn. So `json` is the default and `SttResult.confidence`
 * is normally absent; `transcription.confidence: true` buys the score back for an
 * operator who wants it, at that price. `stt-routing.ts` documents why the router
 * does not take the trade.
 */
import { DEFAULT_WHISPER_URL } from "../config.js";
import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
import {
  elapsedMs,
  WHISPER_LOCAL_PROVIDER_ID,
  type ResolvedSttProviderConfig,
  type SttProvider,
  type SttProviderFactory,
  type SttRequest,
  type SttResult,
} from "./stt-provider.js";

export { WHISPER_LOCAL_PROVIDER_ID };

/** Injectable for tests; production uses the global fetch. */
export type WhisperFetch = (
  url: string,
  init: { method: string; body: FormData; signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Header the coalescing whisper proxy keys on (PHA-3607). */
export const SPEAKER_CLIENT_ID_HEADER = "x-speaker-client-id";

export type LocalWhisperTranscriberParams = {
  config: ResolvedSttProviderConfig;
  /** Endpoint, already defaulted by the factory. */
  url: string;
  fetchFn?: WhisperFetch | undefined;
  now?: (() => number) | undefined;
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

export class LocalWhisperTranscriber implements SttProvider {
  readonly kind = "local" as const;
  private readonly fetchFn: WhisperFetch;
  private readonly now: () => number;

  constructor(private readonly params: LocalWhisperTranscriberParams) {
    this.fetchFn = params.fetchFn ?? (defaultWhisperFetch as WhisperFetch);
    this.now = params.now ?? Date.now;
  }

  get id(): string {
    return WHISPER_LOCAL_PROVIDER_ID;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    const startedAt = this.now();
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return { text: "", provider: this.id, ms: elapsedMs(startedAt, this.now) };
    }
    const wav = encodeWavPcm16Mono(pcm16k);
    const config = this.params.config;
    const wantsConfidence = config.confidence;

    const form = new FormData();
    // `new Uint8Array(wav)` rather than the Buffer: Buffer is backed by
    // ArrayBufferLike, which BlobPart does not accept under strict lib types.
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("response_format", wantsConfidence ? "verbose_json" : "json");
    form.append("temperature", "0");
    const language = request.lang?.trim() || config.language;
    if (language && language !== "auto") {
      form.append("language", language);
    }
    if (config.model) {
      form.append("model", config.model);
    }
    // whisper.cpp takes an initial prompt to prime the decoder with names and
    // jargon. A build that does not know the field ignores it, so this is safe
    // to send whenever one is configured.
    const prompt = request.prompt?.trim() || config.prompt?.trim();
    if (prompt) {
      form.append("prompt", prompt);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      // Deliberately the plain fetch, not `fetchWithSsrFGuard`: the whole point
      // of this call is that it targets a private-network sidecar, which is
      // exactly what the SSRF guard exists to refuse.
      const response = await this.fetchFn(this.params.url, {
        method: "POST",
        body: form,
        signal: controller.signal,
        ...(request.clientId !== undefined
          ? { headers: { [SPEAKER_CLIENT_ID_HEADER]: String(request.clientId) } }
          : {}),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `whisper-local HTTP ${response.status} from ${this.params.url}: ${firstLine(body)}`,
        );
      }
      const confidence = wantsConfidence ? readWhisperConfidence(body) : undefined;
      return {
        text: normalizeTranscript(readTranscriptText(body)),
        provider: this.id,
        ms: elapsedMs(startedAt, this.now),
        ...(confidence !== undefined ? { confidence } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Registry entry. The whisper URL is defaulted here rather than in `config.ts`
 * because it is whisper's own knowledge — a provider added later brings its own
 * defaults the same way, without a config change.
 */
export const whisperLocalFactory: SttProviderFactory = {
  id: WHISPER_LOCAL_PROVIDER_ID,
  kind: "local",
  aliases: ["whisper", "whisper-cpp"],
  create: (context) => ({
    ok: true,
    provider: new LocalWhisperTranscriber({
      config: context.config,
      url:
        context.config.url?.trim() ||
        context.env.TEAMSPEAK_WHISPER_URL?.trim() ||
        DEFAULT_WHISPER_URL,
      ...(context.log ? { log: context.log } : {}),
    }),
  }),
};

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

/**
 * Turn `verbose_json`'s per-segment `avg_logprob` into one 0..1 confidence.
 *
 * `avg_logprob` is the mean log probability of the chosen tokens, so `exp` of it
 * is the geometric-mean token probability — the closest thing whisper gives to
 * "how sure was it". Segments are averaged unweighted: a long utterance whose
 * middle went to mush should read as unsure even when the ends were clean.
 * Returns undefined when the build answered without the field, because a
 * missing score is not a low one.
 */
export function readWhisperConfidence(body: string): number | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const logprobs: number[] = [];
  for (const segment of collectSegments(parsed)) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    const value = (segment as Record<string, unknown>).avg_logprob;
    if (typeof value === "number" && Number.isFinite(value)) {
      logprobs.push(value);
    }
  }
  if (logprobs.length === 0) {
    return undefined;
  }
  const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;
  return Math.min(1, Math.max(0, Math.exp(mean)));
}

function collectSegments(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["segments", "transcription"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  // A single-segment verbose response carries the fields at the top level.
  return typeof record.avg_logprob === "number" ? [record] : [];
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
