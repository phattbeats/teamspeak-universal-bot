/**
 * MiniMax `asr-1.0`, the hosted transcriber (PHA-3428 item 3, PHA-3790).
 *
 * `whisper-local.ts` explains why the default transcriber is a local sidecar:
 * $0 marginal cost and a hot mic that never leaves the house, promised to the
 * channel out loud. This file is the deliberate, opt-in exception to the second
 * half of that promise, and nothing else in the lane may quietly become one —
 * it registers as `kind: "hosted"`, so the registry refuses it in the *primary*
 * slot unless that account sets `transcription.allowHosted: true` (see
 * `stt-provider.ts`). In the secondary slot it is reached on escalation only.
 *
 * It exists because whisper has two failure modes a bigger model does not: it
 * returns nothing at all for quiet or accented speech, and it degrades on long
 * monologues. Both are rare, so as a secondary it costs nothing on an ordinary
 * turn.
 *
 * Wire facts, probed against the live key from inside the container rather than
 * taken from docs (2026-09-13):
 *   - endpoint  POST {baseUrl}/v1/speech_to_text
 *   - body      multipart/form-data, the audio under `file`
 *   - model     must be exactly "asr-1.0" — the API rejects every other id
 *   - success   200 {"text","duration","trace_id"}, ~2.3-3.3s for a 3.3s clip
 *   - NO confidence field comes back, and no prompt parameter goes out.
 *     `SttResult.confidence` is therefore always absent from this provider, and
 *     `SttRequest.prompt` is ignored rather than rejected.
 *
 * `stream=true` is never sent: PHA-3428 records content filter 1027 firing on
 * ordinary chat in streaming mode, and a filtered stream is indistinguishable
 * from a dead one here.
 */
import { DEFAULT_MINIMAX_ASR_BASE_URL, DEFAULT_MINIMAX_ASR_MODEL } from "../config.js";
import { convertBridgePcm48kMonoToSttPcm16k, encodeWavPcm16Mono } from "./audio.js";
import {
  elapsedMs,
  MINIMAX_ASR_PROVIDER_ID,
  type ResolvedSttProviderConfig,
  type SttProvider,
  type SttProviderFactory,
  type SttRequest,
  type SttResult,
} from "./stt-provider.js";
import { normalizeTranscript } from "./whisper-local.js";

export { MINIMAX_ASR_PROVIDER_ID };

/** Injectable for tests; production uses the global fetch. */
export type MiniMaxFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type MiniMaxAsrTranscriberParams = {
  config: ResolvedSttProviderConfig;
  /** API base and credential, already defaulted and checked by the factory. */
  baseUrl: string;
  apiKey: string;
  fetchFn?: MiniMaxFetch | undefined;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
};

/**
 * Provider-side conditions that mean "stop asking for a while" rather than
 * "this segment failed": quota, rate limit, and the content filter are all
 * account state, and retrying them per-utterance just burns latency on every
 * escalation until someone notices.
 */
const BACKOFF_HTTP_STATUSES = new Set([402, 429]);
const BACKOFF_API_STATUS_CODES = new Set([1027, 1008, 1002]);

export class MiniMaxAsrTranscriber implements SttProvider {
  readonly kind = "hosted" as const;
  private readonly fetchFn: MiniMaxFetch;
  private readonly now: () => number;
  /** Epoch ms until which this provider is parked; 0 when healthy. */
  private backoffUntil = 0;

  constructor(private readonly params: MiniMaxAsrTranscriberParams) {
    this.fetchFn = params.fetchFn ?? (defaultMiniMaxFetch as MiniMaxFetch);
    this.now = params.now ?? Date.now;
  }

  get id(): string {
    return MINIMAX_ASR_PROVIDER_ID;
  }

  /** True when the last failure parked this provider and the park has not expired. */
  isBackedOff(): boolean {
    return this.now() < this.backoffUntil;
  }

  /** Remaining park time in ms, for the log and `!sexton status`. */
  backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
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
    // Never "stream": see the file header.
    form.append("response_format", "json");
    const language = request.lang?.trim() || config.language;
    if (language && language !== "auto") {
      form.append("language", language);
    }
    // `request.prompt` is deliberately dropped: asr-1.0 has no such parameter,
    // and sending an unknown field to a strict API is how an escalation turns
    // into a 400 on the one turn whisper already failed.

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.params.baseUrl}/v1/speech_to_text`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.params.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        this.noteFailure({ httpStatus: response.status, body });
        throw new Error(`minimax-asr HTTP ${response.status}: ${firstLine(body)}`);
      }
      // MiniMax can answer 200 with an error envelope, so an ok status is not
      // proof of a transcript (PHA-3428: "errors can arrive as HTTP 200").
      const parsed = readMiniMaxAsrBody(body);
      if (parsed.error) {
        this.noteFailure({ apiStatusCode: parsed.statusCode, body });
        throw new Error(`minimax-asr ${parsed.error}`);
      }
      // A slow success still counts against the provider: the whole reason to
      // escalate is latency we can afford, and >3s is not it.
      const elapsed = elapsedMs(startedAt, this.now);
      if (elapsed > config.slowMs) {
        this.enterBackoff(`slow response ${Math.round(elapsed)}ms > ${config.slowMs}ms`);
      } else {
        this.backoffUntil = 0;
      }
      return { text: normalizeTranscript(parsed.text), provider: this.id, ms: elapsed };
    } catch (error) {
      // An abort is the timeout firing, which is the condition the issue names.
      if (isAbortError(error)) {
        this.enterBackoff(`timeout after ${config.timeoutMs}ms`);
        throw new Error(`minimax-asr timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private noteFailure(failure: {
    httpStatus?: number | undefined;
    apiStatusCode?: number | undefined;
    body: string;
  }): void {
    const { httpStatus, apiStatusCode } = failure;
    if (
      (httpStatus !== undefined && BACKOFF_HTTP_STATUSES.has(httpStatus)) ||
      (apiStatusCode !== undefined && BACKOFF_API_STATUS_CODES.has(apiStatusCode))
    ) {
      this.enterBackoff(
        httpStatus !== undefined ? `HTTP ${httpStatus}` : `status_code ${apiStatusCode}`,
      );
    }
  }

  private enterBackoff(reason: string): void {
    this.backoffUntil = this.now() + this.params.config.backoffMs;
    this.params.log?.(
      `teamspeak voice: minimax-asr backing off ${Math.round(this.params.config.backoffMs / 1000)}s (${reason})`,
    );
  }
}

/**
 * Registry entry.
 *
 * The missing-key refusal lives here rather than in `config.ts` because it is
 * this provider's own precondition: a provider added later refuses on its own
 * missing pieces the same way, and the slot resolver stays generic. The `env`
 * fallback supplies the *key*; only the config block grants the *intent* (see
 * `resolveTeamSpeakSecondaryTranscriptionConfig`).
 */
export const miniMaxAsrFactory: SttProviderFactory = {
  id: MINIMAX_ASR_PROVIDER_ID,
  kind: "hosted",
  aliases: ["minimax"],
  create: (context) => {
    const apiKey = context.config.apiKey?.trim() || context.env.MINIMAX_API_KEY?.trim() || "";
    if (!apiKey) {
      return {
        ok: false,
        reason:
          `stt provider "${MINIMAX_ASR_PROVIDER_ID}" needs an apiKey ` +
          "(set it on the config block or as MINIMAX_API_KEY).",
      };
    }
    return {
      ok: true,
      provider: new MiniMaxAsrTranscriber({
        config: context.config,
        baseUrl: (context.config.baseUrl?.trim() || DEFAULT_MINIMAX_ASR_BASE_URL)
          .replace(/\/+$/, "")
          .replace(/\/v1$/, ""),
        apiKey,
        ...(context.log ? { log: context.log } : {}),
      }),
    };
  },
};

const defaultMiniMaxFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal },
): Promise<Response> => fetch(url, init);

export type MiniMaxAsrBody = {
  text: string;
  /** Set when the payload was an error envelope rather than a transcript. */
  error?: string;
  /** MiniMax's own status code, when it supplied one. */
  statusCode?: number;
};

/**
 * Read the two success shapes and the two error shapes MiniMax actually sends.
 *
 * Success is `{"text","duration","trace_id"}`. Errors arrive either as the
 * REST envelope `{"type":"error","error":{"message"}}` or as an in-band
 * `base_resp.status_code != 0` on an HTTP 200.
 */
export function readMiniMaxAsrBody(body: string): MiniMaxAsrBody {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return { text: "", error: `unreadable response: ${firstLine(trimmed)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: "", error: `unparseable JSON: ${firstLine(trimmed)}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { text: "", error: "response was not an object" };
  }
  const record = parsed as Record<string, unknown>;

  const envelope = record.error;
  if (envelope && typeof envelope === "object") {
    const message = (envelope as Record<string, unknown>).message;
    return { text: "", error: typeof message === "string" ? message : "error envelope" };
  }

  const baseResp = record.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = (baseResp as Record<string, unknown>).status_code;
    const message = (baseResp as Record<string, unknown>).status_msg;
    if (typeof code === "number" && code !== 0) {
      return {
        text: "",
        statusCode: code,
        error: `status_code ${code}${typeof message === "string" ? `: ${message}` : ""}`,
      };
    }
  }

  const text = record.text;
  if (typeof text !== "string") {
    // No transcript and no error is still not a transcript. Saying so beats
    // returning "" and having the router read it as "heard silence".
    return { text: "", error: "response carried no text field" };
  }
  return { text };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.slice(0, 200) ?? "";
}
