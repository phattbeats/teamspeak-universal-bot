/**
 * Acceptance: "wake-name gating with 1 vs 2 humans" (PHA-3175).
 *
 * The policy function under test is the SDK's own
 * `isRealtimeVoiceWakeNameRequired`, copied verbatim into the standalone stub,
 * so these assertions describe real shared behavior rather than a local rule.
 */
import { describe, expect, it } from "vitest";
import type { TeamSpeakVoiceRealtimeConfig } from "../src/config.js";
import { WakeGate } from "../src/voice/wake-gate.js";

function createGate(options: {
  policy: "always" | "automatic" | "never";
  humans: number;
  realtime?: TeamSpeakVoiceRealtimeConfig;
}) {
  return new WakeGate({
    wakeNamePolicy: () => options.policy,
    humanParticipantCount: () => options.humans,
    realtimeConfig: () => options.realtime,
    providerId: () => "openai",
  });
}

describe("WakeGate", () => {
  it("does not require a wake name with one human under the automatic policy", () => {
    // One human in the channel: everything said is addressed to the Sexton.
    expect(createGate({ policy: "automatic", humans: 1 }).isWakeNameRequired()).toBe(false);
  });

  it("requires a wake name once a second human joins", () => {
    // Two humans: the Sexton must not answer people talking to each other.
    expect(createGate({ policy: "automatic", humans: 2 }).isWakeNameRequired()).toBe(true);
    expect(createGate({ policy: "automatic", humans: 5 }).isWakeNameRequired()).toBe(true);
  });

  it("honors an explicit always/never policy regardless of headcount", () => {
    expect(createGate({ policy: "always", humans: 1 }).isWakeNameRequired()).toBe(true);
    expect(createGate({ policy: "never", humans: 4 }).isWakeNameRequired()).toBe(false);
  });

  it("treats an empty channel as not requiring a wake name", () => {
    expect(createGate({ policy: "automatic", humans: 0 }).isWakeNameRequired()).toBe(false);
  });

  it("disables barge-in whenever the wake gate is active", () => {
    // Matching Discord: an ungated interrupt would let one person's crosstalk
    // cut off an answer addressed to someone else.
    const gated = createGate({ policy: "automatic", humans: 2, realtime: { bargeIn: true } });
    expect(gated.isWakeNameRequired()).toBe(true);
    expect(gated.isBargeInEnabled()).toBe(false);
  });

  it("enables barge-in for a single human by default", () => {
    expect(createGate({ policy: "automatic", humans: 1 }).isBargeInEnabled()).toBe(true);
  });

  it("lets an explicit bargeIn=false win over the default", () => {
    const gate = createGate({ policy: "never", humans: 1, realtime: { bargeIn: false } });
    expect(gate.isBargeInEnabled()).toBe(false);
  });

  it("falls back to the provider's interruptResponseOnInputAudio when bargeIn is unset", () => {
    const gate = createGate({
      policy: "never",
      humans: 1,
      realtime: { providers: { openai: { interruptResponseOnInputAudio: false } } },
    });
    expect(gate.isBargeInEnabled()).toBe(false);
  });
});

describe("follow-up window default (PHA-3783)", () => {
  it("leaves the conversation open for well over ten seconds of dead air after the bot finishes speaking", async () => {
    const { DEFAULT_FOLLOW_UP_SILENCE_MS } = await import("../src/voice/stt-tts-speaker-session.js");
    // Brandon, 2026-09-24: 8-10 s was too short; people answered the bot's
    // own question and got nothing unless they said the name again.
    expect(DEFAULT_FOLLOW_UP_SILENCE_MS).toBeGreaterThanOrEqual(15_000);
  });
});
