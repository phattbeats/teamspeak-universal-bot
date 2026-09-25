import { AsyncLocalStorage } from "node:async_hooks";
const turnStorage = new AsyncLocalStorage();
const activeAccess = /* @__PURE__ */ new Map();
function runWithTeamSpeakTurnContext(context, fn) {
  return turnStorage.run(context, fn);
}
function currentTeamSpeakTurnContext() {
  return turnStorage.getStore();
}
function registerTeamSpeakToolAccess(accountId, access) {
  activeAccess.set(accountId, access);
}
function unregisterTeamSpeakToolAccess(accountId, access) {
  if (access && activeAccess.get(accountId) !== access) {
    return;
  }
  activeAccess.delete(accountId);
}
function resolveTeamSpeakToolAccess(accountId) {
  if (accountId !== void 0) {
    const scoped = activeAccess.get(accountId);
    if (scoped) {
      return scoped;
    }
  }
  return activeAccess.size === 1 ? [...activeAccess.values()][0] : void 0;
}
function clearTeamSpeakToolAccess() {
  activeAccess.clear();
}
export {
  clearTeamSpeakToolAccess,
  currentTeamSpeakTurnContext,
  registerTeamSpeakToolAccess,
  resolveTeamSpeakToolAccess,
  runWithTeamSpeakTurnContext,
  unregisterTeamSpeakToolAccess
};
