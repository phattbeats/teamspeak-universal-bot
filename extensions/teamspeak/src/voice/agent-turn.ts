/**
 * One OpenClaw agent turn for a heard utterance (PHA-3228).
 *
 * Mirrors `runDiscordVoiceAgentTurn` (extensions/discord/src/voice/ingress.ts):
 * admit the turn through `runtime.agent.runCommandFromIngress` on the channel's
 * own route, ask for no delivery, and join the text payloads into something
 * speakable. Delivery is off because the reply's destination is the voice lane,
 * not the channel's text — the Sexton answering out loud must not also paste
 * the answer into chat.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { TeamSpeakClientId } from "../bridge/protocol.js";

const TEAMSPEAK_VOICE_MESSAGE_PROVIDER = "teamspeak-voice";

/**
 * The `runtime.agent` slice this needs, restated so tests need no host.
 *
 * Method syntax, not a function property: method parameters are checked
 * bivariantly, so the host's `runCommandFromIngress(opts: AgentCommandIngressOpts,
 * runtime: RuntimeEnv)` assigns to this seam inside a real OpenClaw checkout
 * without dragging `AgentCommandIngressOpts` into the plugin's type graph.
 */
export type TeamSpeakAgentRuntime = {
  runCommandFromIngress(
    opts: Record<string, unknown>,
    runtime: unknown,
  ): Promise<{
    payloads?: Array<{ text?: string | undefined; isError?: boolean | undefined }> | undefined;
  }>;
};

export type TeamSpeakAgentTurnParams = {
  agent: TeamSpeakAgentRuntime;
  cfg: OpenClawConfig;
  accountId: string;
  agentId: string;
  sessionKey: string;
  /** Optional LLM override from `voice.model`. */
  model?: string | undefined;
  runtimeEnv?: unknown;
  log?: ((message: string) => void) | undefined;
};

export type TeamSpeakHeardUtterance = {
  clientId: TeamSpeakClientId;
  nickname: string;
  message: string;
  wakeName?: string;
};

/**
 * Frame the transcript so the agent knows who spoke and that it is on a live
 * voice lane. Discord does the same through `formatVoiceIngressPrompt`; the
 * speaker label matters more here because TeamSpeak nicknames are the only
 * identity the bridge carries.
 */
export function formatTeamSpeakVoicePrompt(utterance: TeamSpeakHeardUtterance): string {
  return `[teamspeak voice] ${utterance.nickname} said: ${utterance.message}`;
}

export function createTeamSpeakAgentTurn(params: TeamSpeakAgentTurnParams) {
  return async (utterance: TeamSpeakHeardUtterance): Promise<string> => {
    const result = await params.agent.runCommandFromIngress(
      {
        message: formatTeamSpeakVoicePrompt(utterance),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        messageChannel: "teamspeak",
        messageProvider: TEAMSPEAK_VOICE_MESSAGE_PROVIDER,
        accountId: params.accountId,
        allowModelOverride: Boolean(params.model),
        ...(params.model ? { model: params.model } : {}),
        deliver: false,
      },
      params.runtimeEnv ?? defaultRuntime,
    );
    const payloads = result.payloads ?? [];
    const text = payloads
      .filter((payload) => payload.isError !== true)
      .map((payload) => payload.text)
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .join("\n")
      .trim();
    if (!text) {
      params.log?.(
        `teamspeak voice: agent turn produced no speakable payloads clientId=${utterance.clientId} payloadCount=${payloads.length}`,
      );
    }
    return text;
  };
}
