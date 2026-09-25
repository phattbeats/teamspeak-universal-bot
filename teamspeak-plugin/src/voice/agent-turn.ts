/**
 * One OpenClaw agent turn for a heard utterance (PHA-3228, streamed PHA-3792).
 *
 * Two entry points into the host, chosen by whether the caller can use a
 * reply before it is finished:
 *
 *  - `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher` (the
 *    default): the host's block-streaming path. The model's output is chunked
 *    mid-generation by `EmbeddedBlockChunker` and each block is handed to our
 *    `deliver`, which forwards it to `onBlock` -- the stt-tts session starts
 *    synthesizing sentence one while the model is still writing sentence
 *    three. Nothing reaches the TeamSpeak text channel: the dispatcher IS the
 *    delivery, and ours only feeds the voice lane.
 *
 *  - `runtime.agent.runCommandFromIngress` (fallback, `voice.blockStreaming:
 *    false` or a host without the reply runtime): mirrors
 *    `runDiscordVoiceAgentTurn` (extensions/discord/src/voice/ingress.ts),
 *    `deliver: false`, whole reply joined at the end.
 *
 * Both keep thinking off (dead air on a voice line) and the `voice.model`
 * override. On the streaming path the model override rides on a per-turn copy
 * of the config (`agents.defaults.model`), because `getReplyFromConfig` has no
 * one-shot model option -- its only model directive persists to the session.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { TeamSpeakClientId } from "../bridge/protocol.js";
import { runWithTeamSpeakTurnContext } from "../tools/turn-context.js";

const TEAMSPEAK_VOICE_MESSAGE_PROVIDER = "teamspeak-voice";

/**
 * Block chunking for a voice turn. The host defaults (`minChars` 800,
 * paragraph breaks) exist so a chat channel does not get a message per
 * sentence; here a message per sentence is exactly the point. Small blocks,
 * sentence breaks, and no coalescer idle hold, so the first sentence leaves
 * the chunker the moment its full stop lands.
 */
export const VOICE_BLOCK_STREAMING_CHUNK = {
  minChars: 24,
  maxChars: 400,
  breakPreference: "sentence",
} as const;
export const VOICE_BLOCK_STREAMING_COALESCE = { minChars: 24, maxChars: 400, idleMs: 0 } as const;

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

/** A reply payload as our dispatcher sees it; the host's `ReplyPayload` has more. */
export type TeamSpeakReplyPayload = {
  text?: string | undefined;
  isError?: boolean | undefined;
};

/**
 * The `runtime.channel.reply` slice this needs (same bivariance trick). Shapes
 * track `openclaw/plugin-sdk/reply-dispatch-runtime`.
 */
export type TeamSpeakReplyRuntime = {
  finalizeInboundContext(ctx: Record<string, unknown>): Record<string, unknown>;
  dispatchReplyWithBufferedBlockDispatcher(params: {
    ctx: Record<string, unknown>;
    cfg: OpenClawConfig;
    dispatcherOptions: {
      deliver(payload: TeamSpeakReplyPayload, info: { kind: string }): Promise<void> | void;
      onError?(error: unknown, info: { kind: string }): void;
    };
    replyOptions?: Record<string, unknown>;
  }): Promise<{ queuedFinal?: boolean; counts?: Record<string, number> }>;
};

export type TeamSpeakAgentTurnParams = {
  agent: TeamSpeakAgentRuntime;
  /** `runtime.channel.reply`; absent means the ingress fallback. */
  reply?: TeamSpeakReplyRuntime | undefined;
  /** `voice.blockStreaming`; default true when `reply` is available. */
  blockStreaming?: boolean | undefined;
  cfg: OpenClawConfig;
  accountId: string;
  agentId: string;
  sessionKey: string;
  /** Optional LLM override from `voice.model`. */
  model?: string | undefined;
  /**
   * Thinking level forced on this turn (`voice.thinking`, PHA-3789). Voice
   * has no channel to show a thinking trace and the wait is dead air on the
   * line, so callers default this to "off" rather than leaving it to
   * whatever the agent's `thinkingDefault` resolves to for other channels.
   */
  thinking?: string | undefined;
  runtimeEnv?: unknown;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
};

export type TeamSpeakHeardUtterance = {
  clientId: TeamSpeakClientId;
  nickname: string;
  message: string;
  wakeName?: string;
};

export type TeamSpeakAgentTurnHooks = {
  /**
   * A block of reply text, in order, while the model is still generating.
   * Only fires on the streaming path; the return value of the turn is still
   * the whole reply either way.
   */
  onBlock?: ((text: string) => void) | undefined;
};

export type TeamSpeakAgentTurnResult = {
  text: string;
  /** How the reply arrived, for the turn log. */
  path: "block-stream" | "ingress";
  /** Blocks delivered mid-generation (0 on the ingress path). */
  blocks: number;
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

/**
 * The per-turn config copy for the streaming path: voice-sized block
 * chunking, plus `voice.model` as the defaults model when set. A copy, never
 * a mutation -- the host's config object is shared with every other channel
 * this gateway serves.
 */
export function buildVoiceTurnConfig(cfg: OpenClawConfig, model?: string): OpenClawConfig {
  const base = cfg as { agents?: { defaults?: Record<string, unknown> } };
  const defaults = { ...(base.agents?.defaults ?? {}) };
  defaults.blockStreamingChunk = VOICE_BLOCK_STREAMING_CHUNK;
  defaults.blockStreamingCoalesce = VOICE_BLOCK_STREAMING_COALESCE;
  if (model) {
    defaults.model = model;
  }
  return { ...cfg, agents: { ...(base.agents ?? {}), defaults } } as OpenClawConfig;
}

function joinSpeakable(payloads: TeamSpeakReplyPayload[]): string {
  return payloads
    .filter((payload) => payload.isError !== true)
    .map((payload) => payload.text)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n")
    .trim();
}

export function createTeamSpeakAgentTurn(params: TeamSpeakAgentTurnParams) {
  const streaming = Boolean(params.reply) && params.blockStreaming !== false;
  const now = params.now ?? (() => Date.now());

  const runIngress = async (utterance: TeamSpeakHeardUtterance): Promise<TeamSpeakAgentTurnResult> => {
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
        ...(params.thinking ? { thinking: params.thinking } : {}),
        deliver: false,
      },
      params.runtimeEnv ?? defaultRuntime,
    );
    const payloads = result.payloads ?? [];
    const text = joinSpeakable(payloads);
    if (!text) {
      params.log?.(
        `teamspeak voice: agent turn produced no speakable payloads clientId=${utterance.clientId} payloadCount=${payloads.length}`,
      );
    }
    return { text, path: "ingress", blocks: 0 };
  };

  const runBlockStream = async (
    utterance: TeamSpeakHeardUtterance,
    hooks: TeamSpeakAgentTurnHooks,
  ): Promise<TeamSpeakAgentTurnResult> => {
    const reply = params.reply as TeamSpeakReplyRuntime;
    const startedAt = now();
    const spoken: TeamSpeakReplyPayload[] = [];
    let blocks = 0;
    let finals = 0;
    // The host's own dedupe: when streaming succeeds end to end the final
    // payload is dropped (agent-runner-payloads.ts, preserveUnsentMediaAfterBlockSend),
    // so a `final` with text is genuinely unstreamed text -- an aborted
    // stream, or a reply the chunker never got. Speak it. What we must not do
    // is speak a final that repeats the blocks, so compare before trusting.
    const streamedText = () => spoken.map((payload) => payload.text ?? "").join("").replace(/\s+/g, "");
    const ctx = reply.finalizeInboundContext({
      Body: formatTeamSpeakVoicePrompt(utterance),
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
      CommandAuthorized: false,
    });
    const result = await reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: buildVoiceTurnConfig(params.cfg, params.model),
      dispatcherOptions: {
        deliver: (payload, info) => {
          if (payload.isError === true) {
            params.log?.(
              `teamspeak voice: agent turn error payload clientId=${utterance.clientId} kind=${info.kind}: ${(payload.text ?? "").slice(0, 200)}`,
            );
            return;
          }
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text) {
            return;
          }
          if (info.kind === "block") {
            blocks += 1;
            spoken.push(payload);
            hooks.onBlock?.(text);
            return;
          }
          if (info.kind !== "final") {
            // Tool progress and other commentary are for a chat window.
            return;
          }
          finals += 1;
          const already = streamedText();
          if (already && text.replace(/\s+/g, "") === already) {
            return;
          }
          spoken.push(payload);
          hooks.onBlock?.(text);
        },
        onError: (error, info) => {
          params.log?.(
            `teamspeak voice: reply dispatch error clientId=${utterance.clientId} kind=${info.kind}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
      replyOptions: {
        // The switch. `false` forces block streaming on for this turn even
        // when `agents.defaults.blockStreamingDefault` is off (get-reply-directives.ts).
        disableBlockStreaming: false,
        ...(params.thinking ? { thinkingLevelOverride: params.thinking } : {}),
        // No typing indicator to drive and nowhere to show tool progress.
        suppressTyping: true,
      },
    });
    const text = joinSpeakable(spoken);
    if (!text) {
      params.log?.(
        `teamspeak voice: agent turn produced no speakable blocks clientId=${utterance.clientId} blocks=${blocks} finals=${finals} queuedFinal=${result.queuedFinal ?? "?"} counts=${JSON.stringify(result.counts ?? {})}`,
      );
    }
    return { text, path: "block-stream", blocks };
  };

  return async (
    utterance: TeamSpeakHeardUtterance,
    hooks: TeamSpeakAgentTurnHooks = {},
  ): Promise<TeamSpeakAgentTurnResult> => {
    // The channel tools execute inside this call; the context is how they learn
    // who is speaking and which account's runtime to act on (PHA-3428 item 4).
    // Per-turn rather than per-runtime because the lane gates one turn per
    // speaker, not one globally: two people can be mid-turn at once.
    return await runWithTeamSpeakTurnContext(
      {
        accountId: params.accountId,
        clientId: utterance.clientId as number,
        nickname: utterance.nickname,
      },
      () => (streaming ? runBlockStream(utterance, hooks) : runIngress(utterance)),
    );
  };
}
