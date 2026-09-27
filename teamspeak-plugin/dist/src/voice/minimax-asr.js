import { DEFAULT_MINIMAX_ASR_BASE_URL, DEFAULT_MINIMAX_ASR_MODEL } from "../config.js";
import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
import {
  elapsedMs,
  MINIMAX_ASR_PROVIDER_ID
} from "./stt-provider.js";
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
  kind = "hosted";
  fetchFn;
  now;
  /** Epoch ms until which this provider is parked; 0 when healthy. */
  backoffUntil = 0;
  get id() {
    return MINIMAX_ASR_PROVIDER_ID;
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
    const startedAt = this.now();
    const pcm16k = convertBridgePcm48kMonoToSttPcm16k(request.pcm48kMono);
    if (pcm16k.length === 0) {
      return { text: "", provider: this.id, ms: elapsedMs(startedAt, this.now) };
    }
    const config = this.params.config;
    const wav = encodeWavPcm16Mono(pcm16k);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("model", config.model?.trim() || DEFAULT_MINIMAX_ASR_MODEL);
    form.append("response_format", "json");
    const language = request.lang?.trim() || config.language;
    if (language && language !== "auto") {
      form.append("language", language);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.params.baseUrl}/v1/speech_to_text`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.params.apiKey}` },
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
      const elapsed = elapsedMs(startedAt, this.now);
      if (elapsed > config.slowMs) {
        this.enterBackoff(`slow response ${Math.round(elapsed)}ms > ${config.slowMs}ms`);
      } else {
        this.backoffUntil = 0;
      }
      return { text: normalizeTranscript(parsed.text), provider: this.id, ms: elapsed };
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
      `teamspeak voice: minimax-asr backing off ${Math.round(this.params.config.backoffMs / 1e3)}s (${reason})`
    );
  }
}
const miniMaxAsrFactory = {
  id: MINIMAX_ASR_PROVIDER_ID,
  kind: "hosted",
  aliases: ["minimax"],
  create: (context) => {
    const apiKey = context.config.apiKey?.trim() || context.env.MINIMAX_API_KEY?.trim() || "";
    if (!apiKey) {
      return {
        ok: false,
        reason: `stt provider "${MINIMAX_ASR_PROVIDER_ID}" needs an apiKey (set it on the config block or as MINIMAX_API_KEY).`
      };
    }
    return {
      ok: true,
      provider: new MiniMaxAsrTranscriber({
        config: context.config,
        baseUrl: (context.config.baseUrl?.trim() || DEFAULT_MINIMAX_ASR_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, ""),
        apiKey,
        ...context.log ? { log: context.log } : {}
      })
    };
  }
};
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
  MINIMAX_ASR_PROVIDER_ID,
  MiniMaxAsrTranscriber,
  miniMaxAsrFactory,
  readMiniMaxAsrBody
};
