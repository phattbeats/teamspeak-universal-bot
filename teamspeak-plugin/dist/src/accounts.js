const DEFAULT_ACCOUNT_ID = "default";
function readChannelConfig(cfg) {
  const channels = cfg.channels;
  const teamspeak = channels?.teamspeak ?? cfg.teamspeak;
  return typeof teamspeak === "object" && teamspeak !== null ? teamspeak : void 0;
}
function listTeamSpeakAccountIds(cfg) {
  const config = readChannelConfig(cfg);
  if (!config) {
    return [];
  }
  const ids = Object.keys(config.accounts ?? {});
  if (config.bridgeUrl !== void 0 || config.voice !== void 0) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(new Set(ids));
}
function resolveTeamSpeakAccount(cfg, accountId) {
  const config = readChannelConfig(cfg);
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const account = id === DEFAULT_ACCOUNT_ID ? { ...config, accounts: void 0 } : config?.accounts?.[id] ?? {};
  const resolved = account ?? {};
  const bridgeUrl = resolved.bridgeUrl ?? process.env.TEAMSPEAK_BRIDGE_URL;
  return {
    accountId: id,
    config: resolved,
    bridgeUrl: bridgeUrl?.trim() || void 0,
    channel: resolved.channel?.trim() || void 0
  };
}
function isTeamSpeakAccountEnabled(account) {
  return account.config.enabled !== false;
}
function isTeamSpeakAccountConfigured(account) {
  return Boolean(account.bridgeUrl);
}
export {
  DEFAULT_ACCOUNT_ID,
  isTeamSpeakAccountConfigured,
  isTeamSpeakAccountEnabled,
  listTeamSpeakAccountIds,
  resolveTeamSpeakAccount
};
