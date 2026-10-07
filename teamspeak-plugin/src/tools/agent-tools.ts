/**
 * The Sexton's channel tools, as ordinary OpenClaw agent tools (#3428 item 4).
 *
 * `registry.ts` already implements `play_music`, `stop_music`, `set_volume`,
 * `what_did_i_miss`, `who_is_here` and `poke`, but only as *realtime provider*
 * function tools: the realtime speaker session registers them on the provider
 * session and executes them itself. The stt-tts and text lanes never touch that
 * path — they run `runCommandFromIngress`, so they get the agent's normal
 * toolset and had none of these. "Sexton, play something chill" on the stt-tts
 * lane produced a sentence about being unable to play music.
 *
 * This is the second face of the same six tools, so the descriptions and
 * parameters come from `buildTeamSpeakTools` rather than being restated here —
 * one set of words for the model on both lanes. Execution resolves the live
 * runtime through `turn-context.ts` and lands in the same `run` the realtime
 * session calls, so there is exactly one implementation of each tool.
 *
 * All six are registered unconditionally. Whether music is available is a
 * property of the *runtime*, not of the plugin, and it can change between
 * gateway start and a turn; the music tools already answer "Music playback is
 * not enabled on this Sexton" for themselves, which is a better outcome than a
 * tool that silently does not exist.
 */
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { buildTeamSpeakTools } from "./registry.js";
import {
  currentTeamSpeakTurnContext,
  resolveTeamSpeakToolAccess,
  type TeamSpeakToolAccess,
} from "./turn-context.js";

/**
 * The host requires every registered tool name to be declared in the manifest's
 * `contracts.tools`, and refuses the whole registration otherwise. Kept beside
 * the builder so the two cannot drift; `package.json` repeats the same list.
 */
/**
 * Every tool, moderation and villain included (#3820: Lexton runs the
 * stt-tts lane, so until this his kick/move tools never reached the agent).
 * Whether an account may actually use one is decided at dispatch:
 * `moderation.*` flags + `allowGroups`, and `tools.villain.enabled`.
 */
const ALL_TOOL_OPTIONS = {
  music: true,
  band: true,
  moderation: { kick: true, ban: true, edit: true },
  villain: true,
};

export const TEAMSPEAK_AGENT_TOOL_NAMES = buildTeamSpeakTools(ALL_TOOL_OPTIONS).map(
  (tool) => tool.name,
);

type AgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<unknown>;
};

export type TeamSpeakAgentToolDeps = {
  /** Test seam; production resolves the live runtime from the registry. */
  resolveAccess?: (accountId?: string) => TeamSpeakToolAccess | undefined;
  log?: ((message: string) => void) | undefined;
};

/**
 * Build the agent-tool face of the channel tools.
 *
 * Called once from the plugin entry's `registerFull`, before any account is
 * connected — which is why the runtime is resolved per call rather than closed
 * over here.
 */
export function createTeamSpeakAgentTools(deps: TeamSpeakAgentToolDeps = {}): AgentTool[] {
  const resolveAccess = deps.resolveAccess ?? resolveTeamSpeakToolAccess;
  return buildTeamSpeakTools(ALL_TOOL_OPTIONS).map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const turn = currentTeamSpeakTurnContext();
      const access = resolveAccess(turn?.accountId);
      if (!access) {
        deps.log?.(`teamspeak tool: ${tool.name} called with no connected channel`);
        return jsonResult({
          ok: false,
          error:
            "Not connected to a TeamSpeak channel right now, so there is nothing to act on.",
        });
      }
      const result = await access.run(tool.name, readArgs(params), {
        clientId: turn?.clientId ?? UNKNOWN_CLIENT_ID,
        nickname: turn?.nickname ?? UNKNOWN_NICKNAME,
      });
      return jsonResult(result);
    },
  }));
}

/**
 * A tool call with no turn context — a CLI run, or a host that executed the
 * tool off the turn's async chain. `who_is_here` still answers; the parts that
 * mean "the person who asked" (`poke me`) fail to match a roster entry and say
 * so, which is the honest outcome. No real TeamSpeak clientId is negative.
 */
const UNKNOWN_CLIENT_ID = -1;
const UNKNOWN_NICKNAME = "someone";

/** Providers hand tool arguments over as an object or as a JSON string. */
function readArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
