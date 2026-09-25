/**
 * The built-in STT providers, registered by name (PHA-3790).
 *
 * This is the whole "no code change to swap" surface: a provider appears here
 * once and is thereafter selectable from any persona's config by name. The
 * registry is built fresh per call rather than kept as a module singleton so a
 * test can register a fake without leaking it into the next test, and so a host
 * that ever wants a per-account registry can have one.
 *
 * Adding a provider is three things and none of them are in the lane:
 *   1. a module exporting an `SttProviderFactory` (see `whisper-local.ts` for a
 *      local one, `minimax-asr.ts` for a hosted one),
 *   2. one `register` call below,
 *   3. its own defaults and its own refusal inside its `create`.
 */
import { miniMaxAsrFactory } from "./minimax-asr.js";
import { SttProviderRegistry } from "./stt-provider.js";
import { whisperLocalFactory } from "./whisper-local.js";

export function createDefaultSttProviderRegistry(): SttProviderRegistry {
  // whisper-local first: `names()` keeps registration order, and the first
  // registered local provider is what the config resolver defaults to.
  return new SttProviderRegistry().register(whisperLocalFactory).register(miniMaxAsrFactory);
}

/** The default primary when config names no provider at all. */
export const DEFAULT_STT_PROVIDER = whisperLocalFactory.id;

/** The default secondary when the escalation block names no provider. */
export const DEFAULT_SECONDARY_STT_PROVIDER = miniMaxAsrFactory.id;
