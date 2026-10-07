/**
 * The host runtime handle.
 *
 * The realtime lane never needed one: the SDK harness owns the agent consult
 * and the provider session, so the plugin only ever handed it config. The
 * stt-tts lane (#3228) runs the agent turn and the synthesis itself, and
 * both live on `PluginRuntime` — so the plugin takes the same runtime-setter
 * seam Discord uses (extensions/discord/src/runtime.ts), declared on the
 * bundled channel entry.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setTeamSpeakRuntime,
  tryGetRuntime: getOptionalTeamSpeakRuntime,
  getRuntime: getTeamSpeakRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "teamspeak",
  errorMessage: "TeamSpeak runtime not initialized",
});

export { getOptionalTeamSpeakRuntime, getTeamSpeakRuntime, setTeamSpeakRuntime };
