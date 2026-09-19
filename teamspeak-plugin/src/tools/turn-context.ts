/**
 * Who the current agent turn is for, and which runtime can act on it (PHA-3428).
 *
 * The realtime lane hands tool calls straight to the provider session, so it
 * always knows the speaker: the session *is* the speaker. The stt-tts and text
 * lanes do not — they run the turn through `runCommandFromIngress`, and the
 * host executes tools from inside that call with no idea a TeamSpeak client is
 * on the other end. `play_music` needs a music controller, `poke` needs a
 * clientId, and `what_did_i_miss` needs the channel name.
 *
 * Two seams carry that across, and they are deliberately separate:
 *
 *  - **The turn context** is per-call and travels on an `AsyncLocalStorage`.
 *    Two people can be mid-turn at once (the lanes gate one turn per *speaker*,
 *    not one globally), so a module-level "current speaker" would hand Alice's
 *    `poke` Bob's clientId. ALS propagates down the await chain into the tool's
 *    `execute` and keeps the two turns apart.
 *  - **The access registry** is per-account and long-lived: the voice runtime
 *    publishes itself here while it is connected, because the tool definitions
 *    are registered once at plugin load, long before any runtime exists.
 *
 * Nothing here imports the voice graph. This module is pulled in by the plugin
 * entry's `registerFull`, which runs during bootstrap, and dragging the bridge
 * and the segmenter into that path would cost every gateway start.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type TeamSpeakTurnContext = {
  /** Which configured TeamSpeak account the turn belongs to. */
  accountId: string;
  clientId: number;
  nickname: string;
};

/**
 * A connected voice runtime, reduced to the one thing the agent tools need.
 * Structural on purpose: `registerFull` must not import `voice-runtime.ts`.
 */
export type TeamSpeakToolAccess = {
  run(
    name: string,
    args: Record<string, unknown>,
    context: { clientId: number; nickname: string },
  ): Promise<Record<string, unknown> & { ok: boolean }>;
};

const turnStorage = new AsyncLocalStorage<TeamSpeakTurnContext>();
const activeAccess = new Map<string, TeamSpeakToolAccess>();

/** Run an agent turn with the speaker attached, so tools can find them. */
export function runWithTeamSpeakTurnContext<T>(
  context: TeamSpeakTurnContext,
  fn: () => Promise<T>,
): Promise<T> {
  return turnStorage.run(context, fn);
}

export function currentTeamSpeakTurnContext(): TeamSpeakTurnContext | undefined {
  return turnStorage.getStore();
}

/** Publish a connected runtime's tools. Called from the runtime's `start()`. */
export function registerTeamSpeakToolAccess(accountId: string, access: TeamSpeakToolAccess): void {
  activeAccess.set(accountId, access);
}

/**
 * Withdraw a runtime's tools. Scoped to the access we published: a restarting
 * runtime registers the new one before the old one's `stop()` lands, and an
 * unconditional delete there would leave the account with no tools at all.
 */
export function unregisterTeamSpeakToolAccess(
  accountId: string,
  access?: TeamSpeakToolAccess,
): void {
  if (access && activeAccess.get(accountId) !== access) {
    return;
  }
  activeAccess.delete(accountId);
}

/**
 * Find the runtime a tool call should act on.
 *
 * Prefers the account named by the turn context. Falls back to the only
 * connected account when there is exactly one — that covers a tool call that
 * arrives outside a lane turn (a CLI run, say) on the single-account setup
 * everyone actually has. With several accounts and no context there is no
 * right answer, so it returns nothing and the tool says so.
 */
export function resolveTeamSpeakToolAccess(accountId?: string): TeamSpeakToolAccess | undefined {
  if (accountId !== undefined) {
    const scoped = activeAccess.get(accountId);
    if (scoped) {
      return scoped;
    }
  }
  return activeAccess.size === 1 ? [...activeAccess.values()][0] : undefined;
}

/** Test seam: forget every published runtime. */
export function clearTeamSpeakToolAccess(): void {
  activeAccess.clear();
}
