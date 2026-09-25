import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  DEFAULT_ACCOUNT_ID,
  isTeamSpeakAccountConfigured,
  isTeamSpeakAccountEnabled,
  listTeamSpeakAccountIds,
  resolveTeamSpeakAccount
} from "./accounts.js";
import { createWebSocketBridgeSocket } from "./bridge/ws-socket.js";
import { isTeamSpeakVoiceEnabled, resolveTeamSpeakVoiceMode } from "./config.js";
import { getOptionalTeamSpeakRuntime } from "./runtime.js";
import { TeamSpeakRealtimeSpeakerSession } from "./voice/realtime-speaker-session.js";
import { createTeamSpeakTextTurn } from "./text-turn.js";
import { createSttTtsLane } from "./voice/stt-tts-lane.js";
import { TeamSpeakVoiceRuntime } from "./voice/voice-runtime.js";
const logger = createSubsystemLogger("teamspeak/voice");
const runtimes = /* @__PURE__ */ new Map();
function startTeamSpeakVoiceRuntime(params) {
  const { account } = params;
  if (!isTeamSpeakAccountEnabled(account) || !isTeamSpeakVoiceEnabled(account.config)) {
    return void 0;
  }
  if (!isTeamSpeakAccountConfigured(account)) {
    logger.warn(
      `teamspeak: account ${account.accountId} has no bridgeUrl; set channels.teamspeak.bridgeUrl or TEAMSPEAK_BRIDGE_URL`
    );
    return void 0;
  }
  stopTeamSpeakVoiceRuntime(account.accountId);
  const mode = resolveTeamSpeakVoiceMode(account.config);
  if (mode === "stt-tts") {
    return startTeamSpeakSttTtsRuntime(params);
  }
  const realtimeConfig = account.config.voice?.realtime;
  const textHostRuntime = getOptionalTeamSpeakRuntime();
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: account.accountId,
    config: account.config,
    createSocket: createWebSocketBridgeSocket,
    ...textHostRuntime ? {
      onChatMessage: createTeamSpeakTextTurn({
        agent: textHostRuntime.agent,
        accountId: account.accountId,
        agentId: params.agentId,
        sessionKey: params.sessionKey ?? `teamspeak:${account.accountId}`,
        log: (message) => logger.info(message)
      })
    } : {},
    ...typeof realtimeConfig?.minBargeInAudioEndMs === "number" ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs } : {},
    ...params.onConnectionChange ? { onConnectionChange: params.onConnectionChange } : {},
    log: (message) => logger.info(message),
    createSpeakerSession: (client, playback, tools) => new TeamSpeakRealtimeSpeakerSession({
      client,
      sessionId: `teamspeak:${account.accountId}:${client.clientId}`,
      accountId: account.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      mode,
      realtimeConfig,
      playback,
      ...params.bootstrapContextInstructions ? { bootstrapContextInstructions: params.bootstrapContextInstructions } : {},
      // PHA-3176: play_music / stop_music / set_volume / what_did_i_miss /
      // who_is_here / poke, executed by the runtime that owns the bridge.
      ...tools ? { toolRegistration: tools } : {},
      humanParticipantCount: () => runtime.humanParticipantCount(),
      onTerminalError: (error) => logger.warn(
        `teamspeak: speaker session clientId=${client.clientId} failed: ${error.message}`
      ),
      log: (message) => logger.info(message)
    })
  });
  runtimes.set(account.accountId, runtime);
  runtime.start();
  return runtime;
}
function startTeamSpeakSttTtsRuntime(params) {
  const { account } = params;
  const hostRuntime = getOptionalTeamSpeakRuntime();
  if (!hostRuntime) {
    logger.warn(
      `teamspeak: voice.mode=stt-tts needs the host plugin runtime, which was not injected; account ${account.accountId} will not start`
    );
    return void 0;
  }
  let runtime;
  const lane = createSttTtsLane({
    cfg: params.cfg,
    config: account.config,
    accountId: account.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? `teamspeak:${account.accountId}`,
    runtime: {
      agent: hostRuntime.agent,
      tts: hostRuntime.tts,
      // The block-streaming reply path (PHA-3792). Optional-chained: a host
      // older than the reply runtime still gets the ingress fallback.
      ...hostRuntime.channel?.reply ? { reply: hostRuntime.channel.reply } : {}
    },
    humanParticipantCount: () => runtime?.humanParticipantCount() ?? 0,
    onTerminalError: (error) => logger.warn(`teamspeak: stt-tts turn failed: ${error.message}`),
    log: (message) => logger.info(message)
  });
  if (!lane.ok) {
    logger.warn(`teamspeak: voice.mode=stt-tts refused for ${account.accountId}: ${lane.reason}`);
    return void 0;
  }
  runtime = new TeamSpeakVoiceRuntime({
    accountId: account.accountId,
    config: account.config,
    createSocket: createWebSocketBridgeSocket,
    ...params.onConnectionChange ? { onConnectionChange: params.onConnectionChange } : {},
    providerId: () => `${lane.lane.transcriberId}+${lane.lane.speechProviderId}`,
    onChatMessage: createTeamSpeakTextTurn({
      agent: hostRuntime.agent,
      accountId: account.accountId,
      agentId: params.agentId,
      sessionKey: params.sessionKey ?? `teamspeak:${account.accountId}`,
      log: (message) => logger.info(message)
    }),
    log: (message) => logger.info(message),
    createSpeakerSession: (client, playback) => lane.lane.createSpeakerSession(client, playback),
    // The band leader's announcement goes through the lane's own TTS (PHA-3554).
    synthesize: (text) => lane.lane.synthesizer.synthesize(text)
  });
  runtimes.set(account.accountId, runtime);
  runtime.start();
  return runtime;
}
function stopTeamSpeakVoiceRuntime(accountId) {
  const runtime = runtimes.get(accountId);
  if (!runtime) {
    return;
  }
  runtimes.delete(accountId);
  runtime.stop();
}
function resolveTeamSpeakRoute(cfg, account) {
  return resolveAgentRoute({
    cfg,
    channel: "teamspeak",
    accountId: account.accountId,
    peer: { kind: "group", id: account.channel ?? account.accountId }
  });
}
async function resolveTeamSpeakBootstrapContext(params) {
  const files = params.account.config.voice?.realtime?.bootstrapContextFiles;
  if (files?.length === 0) {
    return void 0;
  }
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      config: params.cfg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      ...files ? { files } : {},
      warn: (message) => logger.warn(`teamspeak: realtime bootstrap context: ${message}`)
    });
  } catch (error) {
    logger.warn(
      `teamspeak: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return void 0;
  }
}
const teamspeakPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: "teamspeak",
      meta: {
        id: "teamspeak",
        title: "TeamSpeak",
        docsPath: "/channels/teamspeak"
      },
      capabilities: {
        chatTypes: ["group"]
      },
      reload: {
        configPrefixes: ["channels.teamspeak"],
        accountScopedRestart: true
      },
      config: {
        listAccountIds: listTeamSpeakAccountIds,
        resolveAccount: resolveTeamSpeakAccount,
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isEnabled: (account) => isTeamSpeakAccountEnabled(account),
        isConfigured: (account) => isTeamSpeakAccountConfigured(account),
        unconfiguredReason: () => "Set channels.teamspeak.bridgeUrl (or TEAMSPEAK_BRIDGE_URL) to the plnt-ts-bridge WebSocket.",
        hasConfiguredState: ({ cfg, env }) => listTeamSpeakAccountIds(cfg).length > 0 || Boolean(env?.TEAMSPEAK_BRIDGE_URL)
      }
    }),
    /**
     * How the channel actually runs. `startAccount` is the gateway's only
     * lifecycle seam for a channel account (Discord's is
     * `extensions/discord/src/channel.ts`), so the voice runtime hangs off it:
     * without this the plugin loads, lists, and reports configured, and never
     * opens the bridge socket.
     *
     * The contract is a promise that stays pending for the life of the account
     * and settles when `abortSignal` fires — that is what the gateway awaits to
     * know the account is still running.
     */
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        if (!isTeamSpeakAccountConfigured(account)) {
          throw new Error(
            `TeamSpeak account "${account.accountId}" has no bridgeUrl; set channels.teamspeak.bridgeUrl or TEAMSPEAK_BRIDGE_URL.`
          );
        }
        const route = resolveTeamSpeakRoute(ctx.cfg, account);
        const bootstrapContextInstructions = await resolveTeamSpeakBootstrapContext({
          cfg: ctx.cfg,
          account,
          route
        });
        if (ctx.abortSignal.aborted) {
          return;
        }
        const runtime = startTeamSpeakVoiceRuntime({
          cfg: ctx.cfg,
          account,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          ...bootstrapContextInstructions ? { bootstrapContextInstructions } : {},
          onConnectionChange: (connected) => ctx.setStatus({ accountId: account.accountId, running: true, connected })
        });
        if (!runtime) {
          ctx.setStatus({ accountId: account.accountId, running: false, connected: false });
          return;
        }
        ctx.log?.info(
          `[${account.accountId}] starting TeamSpeak voice runtime bridge=${account.bridgeUrl} channel=${account.channel ?? "(none)"} agent=${route.agentId}`
        );
        ctx.setStatus({ accountId: account.accountId, running: true, connected: false });
        try {
          await new Promise((resolve) => {
            if (ctx.abortSignal.aborted) {
              resolve();
              return;
            }
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          stopTeamSpeakVoiceRuntime(account.accountId);
          ctx.setStatus({ accountId: account.accountId, running: false, connected: false });
        }
      },
      stopAccount: async (ctx) => {
        stopTeamSpeakVoiceRuntime(ctx.accountId);
      }
    }
  }
});
export {
  startTeamSpeakVoiceRuntime,
  stopTeamSpeakVoiceRuntime,
  teamspeakPlugin
};
