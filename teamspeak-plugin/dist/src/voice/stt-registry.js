import { miniMaxAsrFactory } from "./minimax-asr.js";
import { SttProviderRegistry } from "./stt-provider.js";
import { whisperLocalFactory } from "./whisper-local.js";
function createDefaultSttProviderRegistry() {
  return new SttProviderRegistry().register(whisperLocalFactory).register(miniMaxAsrFactory);
}
export {
  createDefaultSttProviderRegistry
};
