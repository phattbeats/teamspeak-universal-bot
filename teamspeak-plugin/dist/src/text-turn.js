import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { runWithTeamSpeakTurnContext } from "./tools/turn-context.js";
const TEAMSPEAK_TEXT_MESSAGE_PROVIDER = "teamspeak-text";
function formatTeamSpeakTextPrompt(message) {
  const where = message.target === "client" ? "private message" : "channel";
  return `[teamspeak ${where}] ${message.nickname} wrote: ${message.text}`;
}
function createTeamSpeakTextTurn(params) {
  return async (message) => {
    const startedAt = Date.now();
    const result = await runWithTeamSpeakTurnContext(
      {
        accountId: params.accountId,
        clientId: message.clientId,
        nickname: message.nickname
      },
      () => params.agent.runCommandFromIngress(
        {
          message: formatTeamSpeakTextPrompt(message),
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          messageChannel: "teamspeak",
          messageProvider: TEAMSPEAK_TEXT_MESSAGE_PROVIDER,
          accountId: params.accountId,
          allowModelOverride: false,
          deliver: false
        },
        params.runtimeEnv ?? defaultRuntime
      )
    );
    const payloads = result.payloads ?? [];
    const text = payloads.filter((payload) => payload.isError !== true).map((payload) => payload.text).filter((value) => typeof value === "string" && value.trim().length > 0).join("\n").trim();
    const agentMs = Date.now() - startedAt;
    if (!text) {
      params.log?.(
        `teamspeak text: agent turn produced nothing to say clientId=${message.clientId} payloadCount=${payloads.length} agentMs=${agentMs}`
      );
      return void 0;
    }
    params.log?.(
      `teamspeak text: reply ready clientId=${message.clientId} agentMs=${agentMs} chars=${text.length}`
    );
    return text;
  };
}
export {
  createTeamSpeakTextTurn,
  formatTeamSpeakTextPrompt
};
