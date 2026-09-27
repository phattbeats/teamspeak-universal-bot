import { DEFAULT_WHISPER_URL } from "../config.js";
import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
import {
  elapsedMs,
  WHISPER_LOCAL_PROVIDER_ID
} from "./stt-provider.js";
const SPEAKER_CLIENT_ID_HEADER = "x-speaker-client-id";
const NON_SPEECH_TRANSCRIPTS = /* @__PURE__ */ new Set([
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
  "thanks for watching!"
]);
class LocalWhisperTranscriber {
  constructor(params) {
    this.params = params;
    this.fetchFn = params.fetchFn ?? defaultWhisperFetch;
    this.now = params.now ?? Date.now;
  }
  params;
  kind = "local";
  fetchFn;
  now;
  get id() {
    return WHISPER_LOCAL_PROVIDER_ID;
  }
  async transcribe(request) {
    const startedAt = this.now();
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return { text: "", provider: this.id, ms: elapsedMs(startedAt, this.now) };
    }
    const wav = encodeWavPcm16Mono(pcm16k);
    const config = this.params.config;
    const wantsConfidence = config.confidence;
    const form = new FormData();
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
    const prompt = request.prompt?.trim() || config.prompt?.trim();
    if (prompt) {
      form.append("prompt", prompt);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchFn(this.params.url, {
        method: "POST",
        body: form,
        signal: controller.signal,
        ...request.clientId !== void 0 ? { headers: { [SPEAKER_CLIENT_ID_HEADER]: String(request.clientId) } } : {}
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `whisper-local HTTP ${response.status} from ${this.params.url}: ${firstLine(body)}`
        );
      }
      const confidence = wantsConfidence ? readWhisperConfidence(body) : void 0;
      return {
        text: normalizeTranscript(readTranscriptText(body)),
        provider: this.id,
        ms: elapsedMs(startedAt, this.now),
        ...confidence !== void 0 ? { confidence } : {}
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
const whisperLocalFactory = {
  id: WHISPER_LOCAL_PROVIDER_ID,
  kind: "local",
  aliases: ["whisper", "whisper-cpp"],
  create: (context) => ({
    ok: true,
    provider: new LocalWhisperTranscriber({
      config: context.config,
      url: context.config.url?.trim() || context.env.TEAMSPEAK_WHISPER_URL?.trim() || DEFAULT_WHISPER_URL,
      ...context.log ? { log: context.log } : {}
    })
  })
};
const defaultWhisperFetch = (url, init) => fetch(url, init);
function readTranscriptText(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => readSegmentText(entry)).join(" ");
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed;
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
function readWhisperConfidence(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  const logprobs = [];
  for (const segment of collectSegments(parsed)) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    const value = segment.avg_logprob;
    if (typeof value === "number" && Number.isFinite(value)) {
      logprobs.push(value);
    }
  }
  if (logprobs.length === 0) {
    return void 0;
  }
  const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;
  return Math.min(1, Math.max(0, Math.exp(mean)));
}
function collectSegments(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed;
  for (const key of ["segments", "transcription"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return typeof record.avg_logprob === "number" ? [record] : [];
}
function readSegmentText(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const text = entry.text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}
function normalizeTranscript(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  const stripped = collapsed.replace(/^(?:\s*(?:\[[^\]]*\]|\([^)]*\)))+\s*/, "").trim();
  if (!stripped) {
    return "";
  }
  return NON_SPEECH_TRANSCRIPTS.has(stripped.toLowerCase()) ? "" : stripped;
}
function firstLine(text) {
  return text.split("\n", 1)[0]?.slice(0, 200) ?? "";
}
export {
  LocalWhisperTranscriber,
  SPEAKER_CLIENT_ID_HEADER,
  WHISPER_LOCAL_PROVIDER_ID,
  normalizeTranscript,
  readTranscriptText,
  readWhisperConfidence,
  whisperLocalFactory
};
