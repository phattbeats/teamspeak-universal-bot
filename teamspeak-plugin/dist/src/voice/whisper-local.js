import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
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
  }
  params;
  fetchFn;
  get id() {
    return this.params.config.provider;
  }
  async transcribe(request) {
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return "";
    }
    const wav = encodeWavPcm16Mono(pcm16k);
    const config = this.params.config;
    const form = new FormData();
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
      const response = await this.fetchFn(config.url, {
        method: "POST",
        body: form,
        signal: controller.signal,
        ...request.clientId !== void 0 ? { headers: { [SPEAKER_CLIENT_ID_HEADER]: String(request.clientId) } } : {}
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `whisper-local HTTP ${response.status} from ${config.url}: ${firstLine(body)}`
        );
      }
      return normalizeTranscript(readTranscriptText(body));
    } finally {
      clearTimeout(timeout);
    }
  }
}
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
  normalizeTranscript,
  readTranscriptText
};
