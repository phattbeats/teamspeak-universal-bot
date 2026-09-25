import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
import { normalizeTranscript } from "./whisper-local.js";
const BACKOFF_HTTP_STATUSES = /* @__PURE__ */ new Set([402, 429]);
const BACKOFF_API_STATUS_CODES = /* @__PURE__ */ new Set([1027, 1008, 1002]);
class MiniMaxAsrTranscriber {
  constructor(params) {
    this.params = params;
    this.fetchFn = params.fetchFn ?? defaultMiniMaxFetch;
    this.now = params.now ?? Date.now;
  }
  params;
  fetchFn;
  now;
  /** Epoch ms until which this provider is parked; 0 when healthy. */
  backoffUntil = 0;
  get id() {
    return this.params.config.provider;
  }
  /** True when the last failure parked this provider and the park has not expired. */
  isBackedOff() {
    return this.now() < this.backoffUntil;
  }
  /** Remaining park time in ms, for the log and `!sexton status`. */
  backoffRemainingMs() {
    return Math.max(0, this.backoffUntil - this.now());
  }
  async transcribe(request) {
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return "";
    }
    const config = this.params.config;
    const wav = encodeWavPcm16Mono(pcm16k);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("model", config.model);
    form.append("response_format", "json");
    if (config.language && config.language !== "auto") {
      form.append("language", config.language);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = this.now();
    try {
      const response = await this.fetchFn(`${config.baseUrl}/v1/speech_to_text`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) {
        this.noteFailure({ httpStatus: response.status, body });
        throw new Error(`minimax-asr HTTP ${response.status}: ${firstLine(body)}`);
      }
      const parsed = readMiniMaxAsrBody(body);
      if (parsed.error) {
        this.noteFailure({ apiStatusCode: parsed.statusCode, body });
        throw new Error(`minimax-asr ${parsed.error}`);
      }
      const elapsed = this.now() - startedAt;
      if (elapsed > config.slowMs) {
        this.enterBackoff(`slow response ${Math.round(elapsed)}ms > ${config.slowMs}ms`);
      } else {
        this.backoffUntil = 0;
      }
      return normalizeTranscript(parsed.text);
    } catch (error) {
      if (isAbortError(error)) {
        this.enterBackoff(`timeout after ${config.timeoutMs}ms`);
        throw new Error(`minimax-asr timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  noteFailure(failure) {
    const { httpStatus, apiStatusCode } = failure;
    if (httpStatus !== void 0 && BACKOFF_HTTP_STATUSES.has(httpStatus) || apiStatusCode !== void 0 && BACKOFF_API_STATUS_CODES.has(apiStatusCode)) {
      this.enterBackoff(
        httpStatus !== void 0 ? `HTTP ${httpStatus}` : `status_code ${apiStatusCode}`
      );
    }
  }
  enterBackoff(reason) {
    this.backoffUntil = this.now() + this.params.config.backoffMs;
    this.params.log?.(
      `teamspeak voice: minimax-asr backing off ${Math.round(this.params.config.backoffMs / 1e3)}s (${reason}); whisper-local stays primary`
    );
  }
}
const defaultMiniMaxFetch = (url, init) => fetch(url, init);
function readMiniMaxAsrBody(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return { text: "", error: `unreadable response: ${firstLine(trimmed)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: "", error: `unparseable JSON: ${firstLine(trimmed)}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { text: "", error: "response was not an object" };
  }
  const record = parsed;
  const envelope = record.error;
  if (envelope && typeof envelope === "object") {
    const message = envelope.message;
    return { text: "", error: typeof message === "string" ? message : "error envelope" };
  }
  const baseResp = record.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = baseResp.status_code;
    const message = baseResp.status_msg;
    if (typeof code === "number" && code !== 0) {
      return {
        text: "",
        statusCode: code,
        error: `status_code ${code}${typeof message === "string" ? `: ${message}` : ""}`
      };
    }
  }
  const text = record.text;
  if (typeof text !== "string") {
    return { text: "", error: "response carried no text field" };
  }
  return { text };
}
function isAbortError(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
function firstLine(text) {
  return text.split("\n", 1)[0]?.slice(0, 200) ?? "";
}
export {
  MiniMaxAsrTranscriber,
  readMiniMaxAsrBody
};
