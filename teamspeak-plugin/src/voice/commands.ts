/**
 * In-channel chat commands.
 *
 * TeamSpeak has no slash-command registry, so the Discord slash commands
 * (`/vc join`, `/vc leave`, `/vc mute`, status) are expressed as prefixed text
 * commands parsed out of `text_message` frames. Parsing is separated from
 * execution so the grammar can be tested without a bridge.
 */
import type { TeamSpeakClientId, TextMessageHeader } from "../bridge/protocol.js";

export type TeamSpeakCommand =
  | { kind: "vc-join"; channel?: string }
  | { kind: "vc-leave" }
  /** Clock a bot out through ts-summoner (#3823). No name = this bot. */
  | { kind: "vc-dismiss"; bot?: string }
  | { kind: "vc-mute"; muted: boolean }
  | { kind: "status" };

export type ParsedCommand = {
  command: TeamSpeakCommand;
  clientId: TeamSpeakClientId;
  nickname: string;
};

export type CommandParseFailure = {
  reason: "not-a-command" | "unknown-command" | "not-allowed" | "bad-arguments";
  /** User-facing text, when the sender deserves an answer. */
  reply?: string;
};

export type CommandParseResult =
  | { ok: true; parsed: ParsedCommand }
  | { ok: false; failure: CommandParseFailure };

export const VC_USAGE = "usage: !vc join [channel] | !vc leave | !vc dismiss [bot] | !vc mute [on|off]";

export type CommandParseParams = {
  prefix?: string | undefined;
  /** Client ids allowed to run commands. Unset allows anyone in the channel. */
  allowFrom?: number[] | undefined;
};

function normalizeMuteArgument(argument: string | undefined): boolean | undefined {
  if (argument === undefined || argument === "" || argument === "toggle") {
    return undefined;
  }
  if (["on", "true", "yes", "1", "mute", "muted"].includes(argument)) {
    return true;
  }
  if (["off", "false", "no", "0", "unmute"].includes(argument)) {
    return false;
  }
  return undefined;
}

/**
 * Parse a `text_message` into a command.
 *
 * `currentlyMuted` resolves the bare `!vc mute` toggle; the caller owns that
 * state because the bridge, not this module, knows whether output is muted.
 */
export function parseTeamSpeakCommand(
  message: TextMessageHeader,
  params: CommandParseParams & { currentlyMuted?: boolean } = {},
): CommandParseResult {
  const prefix = params.prefix ?? "!";
  const text = message.text.trim();
  if (!text.startsWith(prefix)) {
    return { ok: false, failure: { reason: "not-a-command" } };
  }
  const tokens = text.slice(prefix.length).trim().split(/\s+/u).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (!head) {
    return { ok: false, failure: { reason: "not-a-command" } };
  }
  if (head !== "vc" && head !== "sexton") {
    return { ok: false, failure: { reason: "unknown-command" } };
  }

  // Authorization is checked only once the text is known to address us, so an
  // unrelated `!roll` from a non-allowlisted client stays silent.
  if (params.allowFrom && !params.allowFrom.includes(message.clientId)) {
    return {
      ok: false,
      failure: {
        reason: "not-allowed",
        reply: "You are not allowed to run Sexton voice commands.",
      },
    };
  }

  const subcommand = tokens[1]?.toLowerCase();
  const base = { clientId: message.clientId, nickname: message.nickname };

  if (head === "sexton") {
    if (subcommand === "status" || subcommand === undefined) {
      return { ok: true, parsed: { ...base, command: { kind: "status" } } };
    }
    return {
      ok: false,
      failure: { reason: "unknown-command", reply: "usage: !sexton status" },
    };
  }

  switch (subcommand) {
    case "join":
      return {
        ok: true,
        parsed: {
          ...base,
          command: { kind: "vc-join", ...(tokens[2] ? { channel: tokens.slice(2).join(" ") } : {}) },
        },
      };
    case "leave":
      return { ok: true, parsed: { ...base, command: { kind: "vc-leave" } } };
    case "dismiss":
      return {
        ok: true,
        parsed: {
          ...base,
          command: { kind: "vc-dismiss", ...(tokens[2] ? { bot: tokens.slice(2).join(" ") } : {}) },
        },
      };
    case "mute": {
      const requested = normalizeMuteArgument(tokens[2]?.toLowerCase());
      if (tokens[2] !== undefined && requested === undefined && tokens[2].toLowerCase() !== "toggle") {
        return {
          ok: false,
          failure: { reason: "bad-arguments", reply: VC_USAGE },
        };
      }
      const muted = requested ?? !(params.currentlyMuted ?? false);
      return { ok: true, parsed: { ...base, command: { kind: "vc-mute", muted } } };
    }
    default:
      return { ok: false, failure: { reason: "bad-arguments", reply: VC_USAGE } };
  }
}

export type StatusSnapshot = {
  bridgeConnected: boolean;
  channelName: string;
  humanParticipants: number;
  speakerSessions: number;
  voiceMode: string;
  providerId?: string | undefined;
  wakeNameRequired: boolean;
  wakeNames: string[];
  bargeInEnabled: boolean;
  muted: boolean;
  /** Sitting out: deaf on both lanes until `!vc join`. */
  parked?: boolean | undefined;
  playbackActive: boolean;
  /** Music lane summary, omitted when the music tools are disabled. */
  music?: string | undefined;
};

/** `!sexton status` reply. One line per fact so it stays readable in TS chat. */
export function formatStatusReply(snapshot: StatusSnapshot): string {
  return [
    `Sexton — ${snapshot.bridgeConnected ? "connected" : "disconnected"}${snapshot.channelName ? ` to ${snapshot.channelName}` : ""}`,
    `voice: ${snapshot.voiceMode}${snapshot.providerId ? ` via ${snapshot.providerId}` : ""}${snapshot.muted ? " (muted)" : ""}`,
    snapshot.parked
      ? `sitting out — not listening (${snapshot.humanParticipants} in channel); !vc join brings me back`
      : `listening to ${snapshot.speakerSessions} of ${snapshot.humanParticipants} in channel`,
    `wake name ${snapshot.wakeNameRequired ? `required (${snapshot.wakeNames.join(", ") || "none configured"})` : "not required"}`,
    `barge-in ${snapshot.bargeInEnabled ? "on" : "off"}, playback ${snapshot.playbackActive ? "active" : "idle"}`,
    ...(snapshot.music ? [`music: ${snapshot.music}`] : []),
  ].join("\n");
}
