const TEAMSPEAK_CORE_TOOL_NAMES = [
  "send_text",
  "play_music",
  "stop_music",
  "skip",
  "pause",
  "resume",
  "now_playing",
  "show_queue",
  "who_is_here",
  "move_to_channel",
  "join_voice",
  "leave_voice"
];
const TEAMSPEAK_CHANNEL_ID = "teamspeak";
function resolveTeamSpeakToolScope(toolName) {
  return TEAMSPEAK_CORE_TOOL_NAMES.includes(toolName) ? "core" : "admin";
}
function resolveTeamSpeakSessionScope(context) {
  const channel = context?.messageChannel ?? context?.deliveryContext?.channel;
  return channel === TEAMSPEAK_CHANNEL_ID ? "admin" : "core";
}
function isTeamSpeakToolVisible(toolName, context) {
  if (resolveTeamSpeakToolScope(toolName) === "core") return true;
  return resolveTeamSpeakSessionScope(context) === "admin";
}
function createTeamSpeakToolFactory(tool) {
  return (context) => isTeamSpeakToolVisible(tool.name, context) ? tool : null;
}
export {
  TEAMSPEAK_CHANNEL_ID,
  TEAMSPEAK_CORE_TOOL_NAMES,
  createTeamSpeakToolFactory,
  isTeamSpeakToolVisible,
  resolveTeamSpeakSessionScope,
  resolveTeamSpeakToolScope
};
