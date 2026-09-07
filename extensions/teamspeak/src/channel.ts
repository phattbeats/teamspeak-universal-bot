/**
 * TeamSpeak channel plugin.
 *
 * Scope note: PHA-3175 is the *voice runtime*. This file is the registration
 * seam that lets the gateway load it — account resolution, capabilities, and
 * the `gateway.startAccount` lifecycle hook that runs one voice runtime per
 * configured account. That hook is what makes the channel do anything: a
 * plugin without it loads and reports itself configured, and never connects.
 * The text-channel adapter surface (outbound send, monitor, directory,
 * threading) is deliberately not implemented: channel chat memory is the
 * Sexton logger's job (PHA-3099/PHA-3173), and the bridge already carries the
 * `text_message` frames this plugin needs for `!vc` / `!sexton` commands.
 */
import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  DEFAULT_ACCOUNT_ID,
  isTeamSpeakAccountConfigured,
  isTeamSpeakAccountEnabled,
  listTeamSpeakAccountIds,
  resolveTeamSpeakAccount,
  type ResolvedTeamSpeakAccount,
} from "./accounts.js";
import { createWebSocketBridgeSocket } from "./bridge/ws-socket.js";
import { isTeamSpeakVoiceEnabled, resolveTeamSpeakVoiceMode } from "./config.js";
import { getOptionalTeamSpeakRuntime } from "./runtime.js";
import { TeamSpeakRealtimeSpeakerSession } from "./voice/realtime-speaker-session.js";
import { createSttTtsLane } from "./voice/stt-tts-lane.js";
import { TeamSpeakVoiceRuntime } from "./voice/voice-runtime.js";

const logger = createSubsystemLogger("teamspeak/voice");

/** One runtime per account; the gateway may hold several TeamSpeak accounts. */
const runtimes = new Map<string, TeamSpeakVoiceRuntime>();

export function startTeamSpeakVoiceRuntime(params: {
  cfg: OpenClawConfig;
  account: ResolvedTeamSpeakAccount;
  agentId: string;
  /** Conversation the stt-tts lane's agent turns are admitted into. */
  sessionKey?: string | undefined;
  /** Agent profile files (IDENTITY.md/USER.md/SOUL.md), already resolved. */
  bootstrapContextInstructions?: string | undefined;
  onConnectionChange?: ((connected: boolean) => void) | undefined;
}): TeamSpeakVoiceRuntime | undefined {
  const { account } = params;
  if (!isTeamSpeakAccountEnabled(account) || !isTeamSpeakVoiceEnabled(account.config)) {
    return undefined;
  }
  if (!isTeamSpeakAccountConfigured(account)) {
    logger.warn(
      `teamspeak: account ${account.accountId} has no bridgeUrl; set channels.teamspeak.bridgeUrl or TEAMSPEAK_BRIDGE_URL`,
    );
    return undefined;
  }
  stopTeamSpeakVoiceRuntime(account.accountId);

  const mode = resolveTeamSpeakVoiceMode(account.config);
  if (mode === "stt-tts") {
    return startTeamSpeakSttTtsRuntime(params);
  }

  const realtimeConfig = account.config.voice?.realtime;
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: account.accountId,
    config: account.config,
    createSocket: createWebSocketBridgeSocket,
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
    ...(params.onConnectionChange ? { onConnectionChange: params.onConnectionChange } : {}),
    log: (message) => logger.info(message),
    createSpeakerSession: (client, playback, tools) =>
      new TeamSpeakRealtimeSpeakerSession({
        client,
        sessionId: `teamspeak:${account.accountId}:${client.clientId}`,
        accountId: account.accountId,
        agentId: params.agentId,
        cfg: params.cfg,
        mode,
        realtimeConfig,
        playback,
        ...(params.bootstrapContextInstructions
          ? { bootstrapContextInstructions: params.bootstrapContextInstructions }
          : {}),
        // PHA-3176: play_music / stop_music / set_volume / what_did_i_miss /
        // who_is_here / poke, executed by the runtime that owns the bridge.
        ...(tools ? { toolRegistration: tools } : {}),
        humanParticipantCount: () => runtime.humanParticipantCount(),
        onTerminalError: (error) =>
          logger.warn(
            `teamspeak: speaker session clientId=${client.clientId} failed: ${error.message}`,
          ),
        log: (message) => logger.info(message),
      }),
  });
  runtimes.set(account.accountId, runtime);
  runtime.start();
  return runtime;
}

/**
 * The stt-tts lane (PHA-3228).
 *
 * Structurally the same runtime as the realtime lane — same bridge client, same
 * roster manager, same room queue, same chat commands — with a different
 * speaker session behind `createSpeakerSession`. The two differences that
 * belong here rather than in the lane: it needs the host `PluginRuntime` (the
 * agent turn and the TTS synthesis both live there), and it refuses to start on
 * a configuration that would put a metered provider in the path.
 */
function startTeamSpeakSttTtsRuntime(params: {
  cfg: OpenClawConfig;
  account: ResolvedTeamSpeakAccount;
  agentId: string;
  sessionKey?: string | undefined;
  onConnectionChange?: ((connected: boolean) => void) | undefined;
}): TeamSpeakVoiceRuntime | undefined {
  const { account } = params;
  const hostRuntime = getOptionalTeamSpeakRuntime();
  if (!hostRuntime) {
    logger.warn(
      `teamspeak: voice.mode=stt-tts needs the host plugin runtime, which was not injected; account ${account.accountId} will not start`,
    );
    return undefined;
  }

  let runtime: TeamSpeakVoiceRuntime | undefined;
  const lane = createSttTtsLane({
    cfg: params.cfg,
    config: account.config,
    accountId: account.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? `teamspeak:${account.accountId}`,
    runtime: { agent: hostRuntime.agent, tts: hostRuntime.tts },
    humanParticipantCount: () => runtime?.humanParticipantCount() ?? 0,
    onTerminalError: (error) => logger.warn(`teamspeak: stt-tts turn failed: ${error.message}`),
    log: (message) => logger.info(message),
  });
  if (!lane.ok) {
    logger.warn(`teamspeak: voice.mode=stt-tts refused for ${account.accountId}: ${lane.reason}`);
    return undefined;
  }

  runtime = new TeamSpeakVoiceRuntime({
    accountId: account.accountId,
    config: account.config,
    createSocket: createWebSocketBridgeSocket,
    ...(params.onConnectionChange ? { onConnectionChange: params.onConnectionChange } : {}),
    providerId: () => `${lane.lane.transcriberId}+${lane.lane.speechProviderId}`,
    log: (message) => logger.info(message),
    createSpeakerSession: (client, playback) => lane.lane.createSpeakerSession(client, playback),
  });
  runtimes.set(account.accountId, runtime);
  runtime.start();
  return runtime;
}

export function stopTeamSpeakVoiceRuntime(accountId: string): void {
  const runtime = runtimes.get(accountId);
  if (!runtime) {
    return;
  }
  runtimes.delete(accountId);
  runtime.stop();
}

/**
 * The agent the channel routes to. TeamSpeak has one room per account, so the
 * route peer is that channel; `agentId` picks the persona and `sessionKey`
 * scopes the profile files the realtime session is briefed with.
 */
function resolveTeamSpeakRoute(cfg: OpenClawConfig, account: ResolvedTeamSpeakAccount) {
  return resolveAgentRoute({
    cfg,
    channel: "teamspeak",
    accountId: account.accountId,
    peer: { kind: "group", id: account.channel ?? account.accountId },
  });
}

/**
 * IDENTITY.md / USER.md / SOUL.md, folded into the realtime instructions the
 * same way Discord voice does it (`resolveDiscordVoiceRealtimeBootstrapContext`).
 * Without this the Sexton introduces itself as a generic voice interface.
 *
 * Resolved once per account start rather than per speaker: the files are the
 * agent's, not the caller's, and re-reading them for every person who walks
 * into the channel buys nothing.
 */
async function resolveTeamSpeakBootstrapContext(params: {
  cfg: OpenClawConfig;
  account: ResolvedTeamSpeakAccount;
  route: { agentId: string; sessionKey: string };
}): Promise<string | undefined> {
  const files = params.account.config.voice?.realtime?.bootstrapContextFiles;
  if (files?.length === 0) {
    return undefined;
  }
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      config: params.cfg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      ...(files ? { files } : {}),
      warn: (message: string) =>
        logger.warn(`teamspeak: realtime bootstrap context: ${message}`),
    });
  } catch (error) {
    // A missing profile file is not a reason to leave the channel silent.
    logger.warn(
      `teamspeak: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export const teamspeakPlugin = createChatChannelPlugin<ResolvedTeamSpeakAccount>({
  base: {
    ...createChannelPluginBase<ResolvedTeamSpeakAccount>({
      id: "teamspeak",
      meta: {
        id: "teamspeak",
        title: "TeamSpeak",
        docsPath: "/channels/teamspeak",
      },
      capabilities: {
        chatTypes: ["group"],
      },
      reload: {
        configPrefixes: ["channels.teamspeak"],
        accountScopedRestart: true,
      },
      config: {
        listAccountIds: listTeamSpeakAccountIds,
        resolveAccount: resolveTeamSpeakAccount,
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isEnabled: (account) => isTeamSpeakAccountEnabled(account),
        isConfigured: (account) => isTeamSpeakAccountConfigured(account),
        unconfiguredReason: () =>
          "Set channels.teamspeak.bridgeUrl (or TEAMSPEAK_BRIDGE_URL) to the plnt-ts-bridge WebSocket.",
        hasConfiguredState: ({ cfg, env }) =>
          listTeamSpeakAccountIds(cfg).length > 0 || Boolean(env?.TEAMSPEAK_BRIDGE_URL),
      },
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
            `TeamSpeak account "${account.accountId}" has no bridgeUrl; set channels.teamspeak.bridgeUrl or TEAMSPEAK_BRIDGE_URL.`,
          );
        }
        const route = resolveTeamSpeakRoute(ctx.cfg, account);
        const bootstrapContextInstructions = await resolveTeamSpeakBootstrapContext({
          cfg: ctx.cfg,
          account,
          route,
        });
        if (ctx.abortSignal.aborted) {
          return;
        }
        const runtime = startTeamSpeakVoiceRuntime({
          cfg: ctx.cfg,
          account,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          ...(bootstrapContextInstructions ? { bootstrapContextInstructions } : {}),
          onConnectionChange: (connected) =>
            ctx.setStatus({ accountId: account.accountId, running: true, connected }),
        });
        if (!runtime) {
          // Voice disabled, or a mode with no runtime behind it. Both are
          // reported by startTeamSpeakVoiceRuntime; say so in status too rather
          // than leaving the account looking live.
          ctx.setStatus({ accountId: account.accountId, running: false, connected: false });
          return;
        }
        ctx.log?.info(
          `[${account.accountId}] starting TeamSpeak voice runtime bridge=${account.bridgeUrl} channel=${account.channel ?? "(none)"} agent=${route.agentId}`,
        );
        ctx.setStatus({ accountId: account.accountId, running: true, connected: false });
        try {
          await new Promise<void>((resolve) => {
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
      },
    },
  },
});
