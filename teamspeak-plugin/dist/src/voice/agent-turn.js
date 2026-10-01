import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { runWithTeamSpeakTurnContext } from "../tools/turn-context.js";
const TEAMSPEAK_VOICE_MESSAGE_PROVIDER = "teamspeak-voice";
const VOICE_BLOCK_STREAMING_CHUNK = {
  minChars: 24,
  maxChars: 400,
  breakPreference: "sentence"
};
const VOICE_BLOCK_STREAMING_COALESCE = { minChars: 24, maxChars: 400, idleMs: 0 };
function formatTeamSpeakVoicePrompt(utterance, at) {
  const followUp = utterance.followUp ? " \xB7 follow-up, name not said" : "";
  return `[teamspeak voice \xB7 ${formatTeamSpeakClock(at)}${followUp}] ${utterance.nickname} said: ${utterance.message}`;
}
const TEAMSPEAK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit"
});
function formatTeamSpeakClock(at) {
  return `${TEAMSPEAK_CLOCK.format(at)} ET`;
}
function buildVoiceTurnConfig(cfg, model) {
  const base = cfg;
  const defaults = { ...base.agents?.defaults ?? {} };
  defaults.blockStreamingChunk = VOICE_BLOCK_STREAMING_CHUNK;
  defaults.blockStreamingCoalesce = VOICE_BLOCK_STREAMING_COALESCE;
  if (model) {
    defaults.model = model;
  }
  return { ...cfg, agents: { ...base.agents ?? {}, defaults } };
}
function joinSpeakable(payloads) {
  return payloads.filter((payload) => payload.isError !== true).map((payload) => payload.text).filter((entry) => typeof entry === "string" && entry.trim().length > 0).join("\n").trim();
}
function createTeamSpeakAgentTurn(params) {
  const streaming = Boolean(params.reply) && params.blockStreaming !== false;
  const now = params.now ?? (() => Date.now());
  const runIngress = async (utterance) => {
    const result = await params.agent.runCommandFromIngress(
      {
        message: formatTeamSpeakVoicePrompt(utterance, now()),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        messageChannel: "teamspeak",
        messageProvider: TEAMSPEAK_VOICE_MESSAGE_PROVIDER,
        accountId: params.accountId,
        allowModelOverride: Boolean(params.model),
        ...params.model ? { model: params.model } : {},
        ...params.thinking ? { thinking: params.thinking } : {},
        deliver: false
      },
      params.runtimeEnv ?? defaultRuntime
    );
    const payloads = result.payloads ?? [];
    const text = joinSpeakable(payloads);
    if (!text) {
      params.log?.(
        `teamspeak voice: agent turn produced no speakable payloads clientId=${utterance.clientId} payloadCount=${payloads.length}`
      );
    }
    return { text, path: "ingress", blocks: 0 };
  };
  const runBlockStream = async (utterance, hooks) => {
    const reply = params.reply;
    const startedAt = now();
    const spoken = [];
    let blocks = 0;
    let finals = 0;
    const streamedText = () => spoken.map((payload) => payload.text ?? "").join("").replace(/\s+/g, "");
    const ctx = reply.finalizeInboundContext({
      Body: formatTeamSpeakVoicePrompt(utterance, startedAt),
      From: `teamspeak:voice:${utterance.clientId}`,
      To: `teamspeak:${params.accountId}`,
      SessionKey: params.sessionKey,
      AgentId: params.agentId,
      AccountId: params.accountId,
      // "direct", not "group": a group context would run the channel's
      // mention/activation policy, and the wake gate already did that job.
      ChatType: "direct",
      Provider: "teamspeak",
      Surface: "teamspeak",
      OriginatingChannel: "teamspeak",
      OriginatingTo: `teamspeak:${params.accountId}`,
      MessageProvider: TEAMSPEAK_VOICE_MESSAGE_PROVIDER,
      SenderId: `client:${utterance.clientId}`,
      SenderName: utterance.nickname,
      MessageSid: `teamspeak-voice:${utterance.clientId}:${startedAt}`,
      Timestamp: startedAt,
      InboundAccessAuthorized: true,
      // Spoken words are never slash commands; a transcript that happens to
      // start with "/" is a transcript, not an operator.
      CommandAuthorized: false
    });
    const result = await reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: buildVoiceTurnConfig(params.cfg, params.model),
      dispatcherOptions: {
        deliver: (payload, info) => {
          if (payload.isError === true) {
            params.log?.(
              `teamspeak voice: agent turn error payload clientId=${utterance.clientId} kind=${info.kind}: ${(payload.text ?? "").slice(0, 200)}`
            );
            return;
          }
          const text2 = typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text2) {
            return;
          }
          if (info.kind === "block") {
            blocks += 1;
            spoken.push(payload);
            hooks.onBlock?.(text2);
            return;
          }
          if (info.kind !== "final") {
            return;
          }
          finals += 1;
          const already = streamedText();
          if (already && text2.replace(/\s+/g, "") === already) {
            return;
          }
          spoken.push(payload);
          hooks.onBlock?.(text2);
        },
        onError: (error, info) => {
          params.log?.(
            `teamspeak voice: reply dispatch error clientId=${utterance.clientId} kind=${info.kind}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      replyOptions: {
        // The switch. `false` forces block streaming on for this turn even
        // when `agents.defaults.blockStreamingDefault` is off (get-reply-directives.ts).
        disableBlockStreaming: false,
        ...params.thinking ? { thinkingLevelOverride: params.thinking } : {},
        // No typing indicator to drive and nowhere to show tool progress.
        suppressTyping: true
      }
    });
    const text = joinSpeakable(spoken);
    if (!text) {
      params.log?.(
        `teamspeak voice: agent turn produced no speakable blocks clientId=${utterance.clientId} blocks=${blocks} finals=${finals} queuedFinal=${result.queuedFinal ?? "?"} counts=${JSON.stringify(result.counts ?? {})}`
      );
    }
    return { text, path: "block-stream", blocks };
  };
  return async (utterance, hooks = {}) => {
    return await runWithTeamSpeakTurnContext(
      {
        accountId: params.accountId,
        clientId: utterance.clientId,
        nickname: utterance.nickname
      },
      () => streaming ? runBlockStream(utterance, hooks) : runIngress(utterance)
    );
  };
}
export {
  VOICE_BLOCK_STREAMING_CHUNK,
  VOICE_BLOCK_STREAMING_COALESCE,
  buildVoiceTurnConfig,
  createTeamSpeakAgentTurn,
  formatTeamSpeakClock,
  formatTeamSpeakVoicePrompt
};
