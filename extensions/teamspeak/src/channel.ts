/**
 * TeamSpeak channel plugin.
 *
 * Scope note: PHA-3175 is the *voice runtime*. This file is the registration
 * seam that lets the gateway load it — account resolution, capabilities, and
 * the lifecycle hook that starts one voice runtime per configured account.
 * The text-channel adapter surface (outbound send, monitor, directory,
 * threading) is deliberately not implemented: channel chat memory is the
 * Sexton logger's job (PHA-3099/PHA-3173), and the bridge already carries the
 * `text_message` frames this plugin needs for `!vc` / `!sexton` commands.
 */
import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import { TeamSpeakRealtimeSpeakerSession } from "./voice/realtime-speaker-session.js";
import { TeamSpeakVoiceRuntime } from "./voice/voice-runtime.js";

const logger = createSubsystemLogger("teamspeak/voice");

/** One runtime per account; the gateway may hold several TeamSpeak accounts. */
const runtimes = new Map<string, TeamSpeakVoiceRuntime>();

export function startTeamSpeakVoiceRuntime(params: {
  cfg: OpenClawConfig;
  account: ResolvedTeamSpeakAccount;
  agentId: string;
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
    // stt-tts has no realtime session to open; it is a separate pipeline and
    // is not part of this plugin yet. Say so rather than starting a dead runtime.
    logger.warn(
      `teamspeak: voice.mode=stt-tts is not implemented for TeamSpeak; use agent-proxy or bidi`,
    );
    return undefined;
  }

  const realtimeConfig = account.config.voice?.realtime;
  const runtime = new TeamSpeakVoiceRuntime({
    accountId: account.accountId,
    config: account.config,
    createSocket: createWebSocketBridgeSocket,
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
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
        // PHA-3176: play_music / stop_music / set_volume / what_did_i_miss /
        // who_is_here / poke, executed by the runtime that owns the bridge.
        ...(tools ? { toolRegistration: tools } : {}),
        humanParticipantCount: () => runtime.snapshot().humanParticipants,
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

export function stopTeamSpeakVoiceRuntime(accountId: string): void {
  const runtime = runtimes.get(accountId);
  if (!runtime) {
    return;
  }
  runtimes.delete(accountId);
  runtime.stop();
}

export const teamspeakPlugin = createChatChannelPlugin<ResolvedTeamSpeakAccount>({
  base: createChannelPluginBase<ResolvedTeamSpeakAccount>({
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
});
