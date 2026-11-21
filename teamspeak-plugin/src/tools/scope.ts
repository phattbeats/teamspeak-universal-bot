/**
 * Which tools a session may see.
 *
 * The plugin used to register every tool it has unconditionally, so every agent
 * session in the fleet — Signal, Discord, Paperclip, cron, the Paperclip issue
 * runs — carried ~5.3k tokens of TeamSpeak schema it could never use. The
 * schemas were paid for in every prompt, in every model call.
 *
 * The host gives a plugin tool factory the *session* context
 * (`messageChannel`, `deliveryContext`, `nativeChannelId`, the account). A
 * factory that returns `null` omits the tool for that session; a factory that
 * returns the tool includes it. That is the seam: no configuration, no
 * per-agent allow/deny list, and nothing is deleted from the plugin.
 *
 * The split:
 *
 *  - **core** — the voice-agent's everyday surface: speak, music control,
 *    "who's here", "come here", "go there". Small enough to live in every
 *    session, useful wherever the agent can talk to the room.
 *  - **admin** — bans, kicks, channel and server edits, persona edits, the
 *    band. These act on the TeamSpeak server and on the agent's own
 *    configuration; they belong to the TeamSpeak channel and nowhere else.
 *
 * Everything not explicitly named core is treated as admin, so a tool added
 * later fails closed (hidden outside TeamSpeak) instead of quietly leaking
 * into every session.
 */

/**
 * The tools every session keeps. Twelve, not ten: the count is what the
 * operator asked for ("about ten"), and each entry here is a tool the voice
 * lane actually calls.
 */
export const TEAMSPEAK_CORE_TOOL_NAMES = [
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
  "leave_voice",
] as const;

export type TeamSpeakToolScope = "core" | "admin";

/**
 * The session facts the scope decision needs. Structural on purpose: the
 * factory context is the host's, and this module must not depend on a host
 * type it cannot import from the standalone repo.
 */
export type TeamSpeakSessionContext = {
  /** The channel plugin the turn arrived on: "teamspeak", "signal", ... */
  messageChannel?: string | undefined;
  /** Where a reply would be delivered; carries the channel for gateway turns. */
  deliveryContext?: { channel?: string | undefined } | undefined;
};

/** The channel id the TeamSpeak plugin registers under. */
export const TEAMSPEAK_CHANNEL_ID = "teamspeak";

/** The scope a tool belongs to. Unknown names are admin (fail closed). */
export function resolveTeamSpeakToolScope(toolName: string): TeamSpeakToolScope {
  return (TEAMSPEAK_CORE_TOOL_NAMES as readonly string[]).includes(toolName) ? "core" : "admin";
}

/** The scope of the *session*: TeamSpeak sessions get the full surface. */
export function resolveTeamSpeakSessionScope(
  context: TeamSpeakSessionContext | undefined,
): TeamSpeakToolScope {
  const channel = context?.messageChannel ?? context?.deliveryContext?.channel;
  return channel === TEAMSPEAK_CHANNEL_ID ? "admin" : "core";
}

/**
 * Whether a tool is visible in a session.
 *
 * Core tools are visible everywhere. Admin tools are visible only in a
 * TeamSpeak session, so Signal, Discord, WhatsApp, Paperclip and cron stop
 * carrying the server-administration schema.
 */
export function isTeamSpeakToolVisible(
  toolName: string,
  context: TeamSpeakSessionContext | undefined,
): boolean {
  if (resolveTeamSpeakToolScope(toolName) === "core") return true;
  return resolveTeamSpeakSessionScope(context) === "admin";
}

/**
 * The registration factory for one tool.
 *
 * The host calls this per session with that session's context. Returning the
 * tool includes it; returning `null` omits it for that session only. The
 * plugin registers every tool through here, so the scope rule lives in one
 * place and the entry point stays a wiring detail.
 */
export function createTeamSpeakToolFactory<T extends { name: string }>(
  tool: T,
): (context: TeamSpeakSessionContext | undefined) => T | null {
  return (context) => (isTeamSpeakToolVisible(tool.name, context) ? tool : null);
}
