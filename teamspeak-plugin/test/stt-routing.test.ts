/**
 * Primary/secondary transcription routing (#3428 item 3).
 *
 * The load-bearing claim here is not "MiniMax works" — it is that turning the
 * secondary on cannot make the lane worse: an ordinary turn must not touch the
 * network, a provider failure must not cost the utterance, and a sick provider
 * must stop being asked.
 */
import { describe, expect, it } from "vitest";

import { resolveTeamSpeakSecondaryTranscriptionConfig } from "../src/config.js";
import { MiniMaxAsrTranscriber, readMiniMaxAsrBody } from "../src/voice/minimax-asr.js";
import { RoutingTranscriber } from "../src/voice/stt-routing.js";
import type { SttProvider } from "../src/voice/stt-provider.js";
import { sttSlotConfig } from "./stt-fixtures.js";

const CONFIG = sttSlotConfig({
  provider: "minimax-asr",
  model: "asr-1.0",
  timeoutMs: 8_000,
  allowHosted: true,
});
const ROUTING = {
  longSegmentMs: 8_000,
  emptyEscalationMinMs: 1_500,
  maxFruitlessEscalations: 3,
  fruitlessCooldownMs: 120_000,
};

/** One second of non-silent 48 kHz mono PCM16, which is what the bridge hands over. */
function segmentPcm(): Buffer {
  const pcm = Buffer.alloc(48_000 * 2);
  for (let i = 0; i < pcm.length; i += 2) {
    pcm.writeInt16LE(((i % 1000) - 500) * 10, i);
  }
  return pcm;
}

const whisperHearing = (text: string): SttProvider => ({
  id: "whisper-local",
  kind: "local",
  transcribe: async () => ({ text, provider: "whisper-local", ms: 1 }),
});

const body = (text: string): string => JSON.stringify({ text, duration: 1, trace_id: "t" });
const response = (status: number, payload: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => payload,
});

function harness(options: {
  whisper: string;
  reply?: () => { ok: boolean; status: number; text(): Promise<string> };
  onCall?: () => void;
}) {
  let clock = 1_000_000;
  const logs: string[] = [];
  const calls: { url: string; body: FormData }[] = [];
  const secondary = new MiniMaxAsrTranscriber({
    config: CONFIG,
    baseUrl: "https://api.minimax.io",
    apiKey: "test-key",
    now: () => clock,
    log: (message) => logs.push(message),
    fetchFn: async (url, init) => {
      calls.push({ url, body: init.body });
      options.onCall?.();
      return options.reply?.() ?? response(200, body("the second opinion"));
    },
  });
  const router = new RoutingTranscriber({
    primary: whisperHearing(options.whisper),
    secondary,
    config: ROUTING,
    now: () => clock,
    log: (message) => logs.push(message),
  });
  return {
    router,
    secondary,
    calls,
    logs,
    tick: (ms: number) => {
      clock += ms;
    },
    hear: (durationMs: number, prefer?: "secondary", label = "Brandon") =>
      router.transcribe({
        pcm48kMono: segmentPcm(),
        label,
        durationMs,
        ...(prefer ? { prefer } : {}),
      }),
  };
}

describe("MiniMax ASR response parsing", () => {
  it("reads a transcript out of the success shape", () => {
    expect(readMiniMaxAsrBody(body("hello there")).text).toBe("hello there");
  });

  it("reads the REST error envelope", () => {
    const parsed = readMiniMaxAsrBody(
      JSON.stringify({ type: "error", error: { message: "invalid params (2013)" } }),
    );
    expect(parsed.text).toBe("");
    expect(parsed.error).toMatch(/invalid params/);
  });

  it("treats an in-band base_resp failure on an HTTP 200 as an error", () => {
    // MiniMax really does answer 200 with this; reading only the status would
    // hand the lane an empty transcript and call it silence.
    const parsed = readMiniMaxAsrBody(
      JSON.stringify({ base_resp: { status_code: 1027, status_msg: "content filtered" } }),
    );
    expect(parsed.statusCode).toBe(1027);
    expect(parsed.error).toMatch(/1027/);
  });

  it("refuses to read a missing text field as silence", () => {
    expect(readMiniMaxAsrBody(JSON.stringify({ duration: 1 })).error).toMatch(/no text field/);
  });
});

describe("routing to the secondary transcriber", () => {
  it("never calls the hosted provider on an ordinary turn", async () => {
    const h = harness({ whisper: "sexton what time is it" });
    await expect(h.hear(2_000)).resolves.toMatchObject({
      text: "sexton what time is it",
      provider: "whisper-local",
      escalated: false,
    });
    expect(h.calls).toHaveLength(0);
  });

  it("does not escalate a short empty segment, which is room tone", async () => {
    const h = harness({ whisper: "" });
    const heard = await h.hear(900);
    expect(heard.escalated).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("escalates a long segment, where whisper degrades", async () => {
    const h = harness({ whisper: "the worse transcript" });
    await expect(h.hear(9_000)).resolves.toMatchObject({
      text: "the second opinion",
      provider: "minimax-asr",
      escalated: true,
    });
  });

  it("rescues an empty transcript on a segment long enough to have held speech", async () => {
    // The exact symptom #3428 opened with: `empty transcript segmentMs=2120`.
    const h = harness({ whisper: "" });
    await expect(h.hear(2_120)).resolves.toMatchObject({
      text: "the second opinion",
      provider: "minimax-asr",
      escalated: true,
    });
  });

  it("keeps silence when both providers hear nothing", async () => {
    const h = harness({ whisper: "", reply: () => response(200, body("")) });
    expect((await h.hear(2_120)).text).toBe("");
  });

  it("honours prefer:secondary for the history tools", async () => {
    const h = harness({ whisper: "partial" });
    expect((await h.hear(1_000, "secondary")).text).toBe("the second opinion");
    expect(h.calls).toHaveLength(1);
  });

  it("sends multipart asr-1.0 json with bearer auth, and never stream", async () => {
    const h = harness({ whisper: "" });
    await h.hear(9_000);
    expect(h.calls[0]?.url).toBe("https://api.minimax.io/v1/speech_to_text");
    expect(h.calls[0]?.body.get("model")).toBe("asr-1.0");
    expect(h.calls[0]?.body.get("response_format")).toBe("json");
    // stream=true trips content filter 1027 on ordinary chat (#3428).
    expect(h.calls[0]?.body.get("stream")).toBeNull();
    expect(h.calls[0]?.body.get("file")).toBeTruthy();
  });
});

describe("the secondary failing never costs the turn", () => {
  it("keeps whisper's transcript when MiniMax errors", async () => {
    const h = harness({ whisper: "whisper still heard this", reply: () => response(500, "boom") });
    await expect(h.hear(9_000)).resolves.toMatchObject({
      text: "whisper still heard this",
      provider: "whisper-local",
      escalated: true,
    });
  });

  for (const [label, reply] of [
    ["a 429", () => response(429, "rate limited")],
    ["a 402", () => response(402, "out of quota")],
    [
      "content filter 1027 on a 200",
      () => response(200, JSON.stringify({ base_resp: { status_code: 1027, status_msg: "no" } })),
    ],
  ] as const) {
    it(`parks the provider for ten minutes after ${label}`, async () => {
      const h = harness({ whisper: "kept", reply });
      await h.hear(9_000);
      expect(h.secondary.isBackedOff()).toBe(true);

      // The whole point of a backoff: the next escalation must not go out.
      await h.hear(9_000);
      expect(h.calls).toHaveLength(1);
      expect(h.logs.join(" ")).toMatch(/backing off|escalation skipped/);

      h.tick(600_001);
      expect(h.secondary.isBackedOff()).toBe(false);
      await h.hear(9_000);
      expect(h.calls).toHaveLength(2);
    });
  }

  it("parks a provider that succeeds too slowly to be worth escalating to", async () => {
    // A 3.5s round trip, simulated by moving the clock inside the call.
    const slow = harness({
      whisper: "w",
      reply: () => response(200, body("late but correct")),
      onCall: () => slow.tick(3_500),
    });
    const heard = await slow.hear(9_000);
    expect(heard.text).toBe("late but correct"); // this turn still benefits
    expect(slow.secondary.isBackedOff()).toBe(true); // the next one will not wait
  });
});

describe("the secondary is off unless it is deliberately configured", () => {
  // The key-missing and unknown-name refusals moved to the registry and the
  // provider factory with #3790; they are covered in stt-registry.test.ts.
  // What belongs to config, and only to config, is the opt-in itself.
  it("stays off when no block is present, even with MINIMAX_API_KEY in scope", () => {
    // The key IS exported on the live container for TTS. Sending channel audio
    // to a third party must not switch itself on as a side effect of that.
    const resolved = resolveTeamSpeakSecondaryTranscriptionConfig({});
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toBeUndefined();
  });

  it("defaults to minimax-asr once the block opts in, with no key of its own", () => {
    const resolved = resolveTeamSpeakSecondaryTranscriptionConfig({
      voice: { streaming: { secondaryTranscription: {} } },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.config.provider).toBe("minimax-asr");
    // The env fallback is the factory's job, so config leaves this unset rather
    // than reading process.env behind the caller's back.
    expect(resolved.ok === true && resolved.config.apiKey).toBeUndefined();
  });

  it("carries a different provider name straight through for the registry to resolve", () => {
    const resolved = resolveTeamSpeakSecondaryTranscriptionConfig({
      voice: { streaming: { secondaryTranscription: { provider: "deepgram" } } },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.config.provider).toBe("deepgram");
  });
});

describe("a speaker who is only ever silence stops being escalated", () => {
  // Observed live: one mic emitting 1.6-1.9s of nothing, every segment
  // escalating, every escalation coming back empty from MiniMax too.
  const alwaysEmpty = () => response(200, body(""));

  it("suppresses after three fruitless escalations in a row", async () => {
    const h = harness({ whisper: "", reply: alwaysEmpty });
    for (let i = 0; i < 3; i++) {
      await h.hear(1_800);
    }
    expect(h.calls).toHaveLength(3);
    expect(h.logs.join(" ")).toMatch(/escalation suppressed for Brandon/);

    await h.hear(1_800);
    await h.hear(1_800);
    expect(h.calls).toHaveLength(3); // still three: the noise is now free
  });

  it("suppresses only the speaker who was silent", async () => {
    const h = harness({ whisper: "", reply: alwaysEmpty });
    for (let i = 0; i < 3; i++) {
      await h.hear(1_800, undefined, "NoisyMic");
    }
    expect(h.calls).toHaveLength(3);
    await h.hear(1_800, undefined, "NoisyMic");
    expect(h.calls).toHaveLength(3);

    // A different speaker is unaffected.
    await h.hear(1_800, undefined, "Brandon");
    expect(h.calls).toHaveLength(4);
  });

  it("escalates again once the cooldown passes", async () => {
    const h = harness({ whisper: "", reply: alwaysEmpty });
    for (let i = 0; i < 3; i++) {
      await h.hear(1_800);
    }
    expect(h.calls).toHaveLength(3);
    h.tick(120_001);
    await h.hear(1_800);
    expect(h.calls).toHaveLength(4);
  });

  it("forgives a speaker the moment they actually say something", async () => {
    let heard = "";
    const h = harness({ whisper: "", reply: () => response(200, body(heard)) });
    await h.hear(1_800);
    await h.hear(1_800);
    expect(h.calls).toHaveLength(2); // two strikes

    heard = "I was here the whole time";
    expect((await h.hear(1_800)).text).toBe("I was here the whole time");

    // The streak is cleared, so the next two empties do not trip the limit.
    heard = "";
    await h.hear(1_800);
    await h.hear(1_800);
    expect(h.calls).toHaveLength(5);
    expect(h.logs.join(" ")).not.toMatch(/escalation suppressed/);
  });
});
