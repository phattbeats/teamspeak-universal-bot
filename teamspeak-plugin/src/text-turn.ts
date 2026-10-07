/**
 * One OpenClaw agent turn for a chat message in the TeamSpeak room (#3428).
 *
 * The voice lane has `agent-turn.ts`; this is its text twin. Same seam
 * (`runCommandFromIngress`, no delivery), because the reply's destination is a
 * `text_message` frame back through the bridge, not whatever route the host
 * would otherwise pick.
 */
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { TextMessageHeader } from "./bridge/protocol.js";
import { runWithTeamSpeakTurnContext } from "./tools/turn-context.js";
import { formatTeamSpeakClock, type TeamSpeakAgentRuntime } from "./voice/agent-turn.js";

const TEAMSPEAK_TEXT_MESSAGE_PROVIDER = "teamspeak-text";

export type TeamSpeakTextTurnParams = {
  agent: TeamSpeakAgentRuntime;
  accountId: string;
  agentId: string;
  sessionKey: string;
  runtimeEnv?: unknown;
  log?: ((message: string) => void) | undefined;
};

/** Frame the message the way the voice lane frames an utterance. */
export function formatTeamSpeakTextPrompt(message: TextMessageHeader, at: number = Date.now()): string {
  const where = message.target === "client" ? "private message" : "channel";
  return `[teamspeak ${where} · ${formatTeamSpeakClock(at)}] ${message.nickname} wrote: ${message.text}`;
}

export function createTeamSpeakTextTurn(params: TeamSpeakTextTurnParams) {
  return async (message: TextMessageHeader): Promise<string | undefined> => {
    const startedAt = Date.now();
    // The channel tools execute inside this call; the context is how they learn
    // who to poke and which account's runtime to act on (#3428 item 4).
    const result = await runWithTeamSpeakTurnContext(
      {
        accountId: params.accountId,
        clientId: message.clientId as number,
        nickname: message.nickname,
      },
      () =>
        params.agent.runCommandFromIngress(
          {
            message: formatTeamSpeakTextPrompt(message),
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            messageChannel: "teamspeak",
            messageProvider: TEAMSPEAK_TEXT_MESSAGE_PROVIDER,
            accountId: params.accountId,
            allowModelOverride: false,
            deliver: false,
          },
          params.runtimeEnv ?? defaultRuntime,
        ),
    );
    const payloads = result.payloads ?? [];
    const text = payloads
      .filter((payload) => payload.isError !== true)
      .map((payload) => payload.text)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    const agentMs = Date.now() - startedAt;
    if (!text) {
      params.log?.(
        `teamspeak text: agent turn produced nothing to say clientId=${message.clientId} payloadCount=${payloads.length} agentMs=${agentMs}`,
      );
      return undefined;
    }
    params.log?.(
      `teamspeak text: reply ready clientId=${message.clientId} agentMs=${agentMs} chars=${text.length}`,
    );
    return text;
  };
}
