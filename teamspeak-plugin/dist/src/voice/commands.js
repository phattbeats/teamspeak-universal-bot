const VC_USAGE = "usage: !vc join [channel] | !vc leave | !vc mute [on|off]";
function normalizeMuteArgument(argument) {
  if (argument === void 0 || argument === "" || argument === "toggle") {
    return void 0;
  }
  if (["on", "true", "yes", "1", "mute", "muted"].includes(argument)) {
    return true;
  }
  if (["off", "false", "no", "0", "unmute"].includes(argument)) {
    return false;
  }
  return void 0;
}
function parseTeamSpeakCommand(message, params = {}) {
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
  if (params.allowFrom && !params.allowFrom.includes(message.clientId)) {
    return {
      ok: false,
      failure: {
        reason: "not-allowed",
        reply: "You are not allowed to run Sexton voice commands."
      }
    };
  }
  const subcommand = tokens[1]?.toLowerCase();
  const base = { clientId: message.clientId, nickname: message.nickname };
  if (head === "sexton") {
    if (subcommand === "status" || subcommand === void 0) {
      return { ok: true, parsed: { ...base, command: { kind: "status" } } };
    }
    return {
      ok: false,
      failure: { reason: "unknown-command", reply: "usage: !sexton status" }
    };
  }
  switch (subcommand) {
    case "join":
      return {
        ok: true,
        parsed: {
          ...base,
          command: { kind: "vc-join", ...tokens[2] ? { channel: tokens.slice(2).join(" ") } : {} }
        }
      };
    case "leave":
      return { ok: true, parsed: { ...base, command: { kind: "vc-leave" } } };
    case "mute": {
      const requested = normalizeMuteArgument(tokens[2]?.toLowerCase());
      if (tokens[2] !== void 0 && requested === void 0 && tokens[2].toLowerCase() !== "toggle") {
        return {
          ok: false,
          failure: { reason: "bad-arguments", reply: VC_USAGE }
        };
      }
      const muted = requested ?? !(params.currentlyMuted ?? false);
      return { ok: true, parsed: { ...base, command: { kind: "vc-mute", muted } } };
    }
    default:
      return { ok: false, failure: { reason: "bad-arguments", reply: VC_USAGE } };
  }
}
function formatStatusReply(snapshot) {
  return [
    `Sexton \u2014 ${snapshot.bridgeConnected ? "connected" : "disconnected"}${snapshot.channelName ? ` to ${snapshot.channelName}` : ""}`,
    `voice: ${snapshot.voiceMode}${snapshot.providerId ? ` via ${snapshot.providerId}` : ""}${snapshot.muted ? " (muted)" : ""}`,
    snapshot.parked ? `sitting out \u2014 not listening (${snapshot.humanParticipants} in channel); !vc join brings me back` : `listening to ${snapshot.speakerSessions} of ${snapshot.humanParticipants} in channel`,
    `wake name ${snapshot.wakeNameRequired ? `required (${snapshot.wakeNames.join(", ") || "none configured"})` : "not required"}`,
    `barge-in ${snapshot.bargeInEnabled ? "on" : "off"}, playback ${snapshot.playbackActive ? "active" : "idle"}`,
    ...snapshot.music ? [`music: ${snapshot.music}`] : []
  ].join("\n");
}
export {
  VC_USAGE,
  formatStatusReply,
  parseTeamSpeakCommand
};
