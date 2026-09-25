import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { buildTeamSpeakTools } from "./registry.js";
import {
  currentTeamSpeakTurnContext,
  resolveTeamSpeakToolAccess
} from "./turn-context.js";
const TEAMSPEAK_AGENT_TOOL_NAMES = buildTeamSpeakTools({ music: true, band: true }).map(
  (tool) => tool.name
);
function createTeamSpeakAgentTools(deps = {}) {
  const resolveAccess = deps.resolveAccess ?? resolveTeamSpeakToolAccess;
  return buildTeamSpeakTools({ music: true, band: true }).map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params) => {
      const turn = currentTeamSpeakTurnContext();
      const access = resolveAccess(turn?.accountId);
      if (!access) {
        deps.log?.(`teamspeak tool: ${tool.name} called with no connected channel`);
        return jsonResult({
          ok: false,
          error: "Not connected to a TeamSpeak channel right now, so there is nothing to act on."
        });
      }
      const result = await access.run(tool.name, readArgs(params), {
        clientId: turn?.clientId ?? UNKNOWN_CLIENT_ID,
        nickname: turn?.nickname ?? UNKNOWN_NICKNAME
      });
      return jsonResult(result);
    }
  }));
}
const UNKNOWN_CLIENT_ID = -1;
const UNKNOWN_NICKNAME = "someone";
function readArgs(raw) {
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export {
  TEAMSPEAK_AGENT_TOOL_NAMES,
  createTeamSpeakAgentTools
};
