import { describe, expect, it } from "vitest";
import type { TextMessageHeader } from "../src/bridge/protocol.js";
import { formatStatusReply, parseTeamSpeakCommand, VC_USAGE } from "../src/voice/commands.js";

function message(text: string, overrides: Partial<TextMessageHeader> = {}): TextMessageHeader {
  return { clientId: 11, nickname: "brandon", text, target: "channel", ...overrides };
}

describe("parseTeamSpeakCommand", () => {
  it("parses the !vc subcommands", () => {
    expect(parseTeamSpeakCommand(message("!vc join"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-join" } },
    });
    expect(parseTeamSpeakCommand(message("!vc join Gaming Room"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-join", channel: "Gaming Room" } },
    });
    expect(parseTeamSpeakCommand(message("!vc leave"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-leave" } },
    });
  });

  it("parses !sexton status, with a bare !sexton meaning status", () => {
    expect(parseTeamSpeakCommand(message("!sexton status"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "status" } },
    });
    expect(parseTeamSpeakCommand(message("!sexton"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "status" } },
    });
  });

  it("resolves mute explicitly and by toggle", () => {
    expect(parseTeamSpeakCommand(message("!vc mute on"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-mute", muted: true } },
    });
    expect(parseTeamSpeakCommand(message("!vc mute off"))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-mute", muted: false } },
    });
    expect(parseTeamSpeakCommand(message("!vc mute"), { currentlyMuted: true })).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-mute", muted: false } },
    });
  });

  it("is tolerant of case and extra whitespace", () => {
    expect(parseTeamSpeakCommand(message("  !VC   Leave  "))).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-leave" } },
    });
  });

  it("stays silent on text that is not a command", () => {
    for (const text of ["hello", "vc join", "", "  "]) {
      const result = parseTeamSpeakCommand(message(text));
      expect(result).toMatchObject({ ok: false, failure: { reason: "not-a-command" } });
      expect(result.ok === false && result.failure.reply).toBeFalsy();
    }
  });

  it("stays silent on an unrelated prefixed command", () => {
    // Another bot's `!roll` must not draw a usage reply from the Sexton.
    const result = parseTeamSpeakCommand(message("!roll 2d6"));
    expect(result).toMatchObject({ ok: false, failure: { reason: "unknown-command" } });
    expect(result.ok === false && result.failure.reply).toBeUndefined();
  });

  it("returns usage for a malformed !vc", () => {
    const result = parseTeamSpeakCommand(message("!vc dance"));
    expect(result).toMatchObject({ ok: false, failure: { reason: "bad-arguments", reply: VC_USAGE } });
  });

  it("returns usage for an unparseable mute argument", () => {
    expect(parseTeamSpeakCommand(message("!vc mute sideways"))).toMatchObject({
      ok: false,
      failure: { reason: "bad-arguments" },
    });
  });

  it("honors a custom prefix", () => {
    expect(parseTeamSpeakCommand(message(".vc leave"), { prefix: "." })).toMatchObject({
      ok: true,
      parsed: { command: { kind: "vc-leave" } },
    });
    expect(parseTeamSpeakCommand(message("!vc leave"), { prefix: "." })).toMatchObject({
      ok: false,
      failure: { reason: "not-a-command" },
    });
  });

  it("rejects a client outside the allowlist but stays silent on non-commands", () => {
    expect(parseTeamSpeakCommand(message("!vc leave"), { allowFrom: [99] })).toMatchObject({
      ok: false,
      failure: { reason: "not-allowed" },
    });
    // Authorization is checked only after the text is known to address us.
    expect(parseTeamSpeakCommand(message("hello"), { allowFrom: [99] })).toMatchObject({
      ok: false,
      failure: { reason: "not-a-command" },
    });
  });
});

describe("formatStatusReply", () => {
  it("reports the room state in one readable block", () => {
    const reply = formatStatusReply({
      bridgeConnected: true,
      channelName: "General Shit",
      humanParticipants: 2,
      speakerSessions: 2,
      voiceMode: "agent-proxy",
      providerId: "openai",
      wakeNameRequired: true,
      wakeNames: ["sexton"],
      bargeInEnabled: false,
      muted: false,
      playbackActive: false,
    });

    expect(reply).toContain("Sexton — connected to General Shit");
    expect(reply).toContain("voice: agent-proxy via openai");
    expect(reply).toContain("listening to 2 of 2 in channel");
    expect(reply).toContain("wake name required (sexton)");
    expect(reply).toContain("barge-in off, playback idle");
  });

  it("says so when disconnected and muted", () => {
    const reply = formatStatusReply({
      bridgeConnected: false,
      channelName: "",
      humanParticipants: 0,
      speakerSessions: 0,
      voiceMode: "agent-proxy",
      wakeNameRequired: false,
      wakeNames: [],
      bargeInEnabled: true,
      muted: true,
      playbackActive: false,
    });

    expect(reply).toContain("Sexton — disconnected");
    expect(reply).toContain("(muted)");
    expect(reply).toContain("wake name not required");
  });
});
