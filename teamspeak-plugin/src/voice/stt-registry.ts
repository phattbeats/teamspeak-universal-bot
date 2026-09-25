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
  // whisper-local first: `names()` keeps registration order, so it leads the
  // "not one of ..." messages, which is also the order an operator should read
  // them in. The slot *defaults* are named in `config.ts` from the shared id
  // constants rather than duplicated here — two sources for "the default
  // provider" is how they drift apart.
  return new SttProviderRegistry().register(whisperLocalFactory).register(miniMaxAsrFactory);
}
