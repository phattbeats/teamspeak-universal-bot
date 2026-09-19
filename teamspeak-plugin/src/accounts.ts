/**
 * Account resolution for the TeamSpeak channel.
 *
 * Multi-account is supported the way Discord does it (`accounts` map plus a
 * top-level default block), because one gateway may sit in more than one
 * TeamSpeak server or channel.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TeamSpeakAccountConfig } from "./config.js";

export const DEFAULT_ACCOUNT_ID = "default";

export type ResolvedTeamSpeakAccount = {
  accountId: string;
  config: TeamSpeakAccountConfig;
  bridgeUrl: string | undefined;
  channel: string | undefined;
};

type TeamSpeakChannelConfig = TeamSpeakAccountConfig & {
  accounts?: Record<string, TeamSpeakAccountConfig | undefined>;
};

function readChannelConfig(cfg: OpenClawConfig): TeamSpeakChannelConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const teamspeak = channels?.teamspeak ?? (cfg as Record<string, unknown>).teamspeak;
  return typeof teamspeak === "object" && teamspeak !== null
    ? (teamspeak as TeamSpeakChannelConfig)
    : undefined;
}

export function listTeamSpeakAccountIds(cfg: OpenClawConfig): string[] {
  const config = readChannelConfig(cfg);
  if (!config) {
    return [];
  }
  const ids = Object.keys(config.accounts ?? {});
  // The top-level block is the default account; it is only an account when it
  // actually carries configuration, so an `accounts`-only config lists cleanly.
  if (config.bridgeUrl !== undefined || config.voice !== undefined) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(new Set(ids));
}

export function resolveTeamSpeakAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTeamSpeakAccount {
  const config = readChannelConfig(cfg);
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const account =
    id === DEFAULT_ACCOUNT_ID
      ? { ...config, accounts: undefined }
      : (config?.accounts?.[id] ?? {});
  const resolved: TeamSpeakAccountConfig = account ?? {};
  const bridgeUrl = resolved.bridgeUrl ?? process.env.TEAMSPEAK_BRIDGE_URL;
  return {
    accountId: id,
    config: resolved,
    bridgeUrl: bridgeUrl?.trim() || undefined,
    channel: resolved.channel?.trim() || undefined,
  };
}

export function isTeamSpeakAccountEnabled(account: ResolvedTeamSpeakAccount): boolean {
  return account.config.enabled !== false;
}

/** A TeamSpeak account is only usable once it knows where its bridge lives. */
export function isTeamSpeakAccountConfigured(account: ResolvedTeamSpeakAccount): boolean {
  return Boolean(account.bridgeUrl);
}
