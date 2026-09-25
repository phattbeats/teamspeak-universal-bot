import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const {
  setRuntime: setTeamSpeakRuntime,
  tryGetRuntime: getOptionalTeamSpeakRuntime,
  getRuntime: getTeamSpeakRuntime
} = createPluginRuntimeStore({
  pluginId: "teamspeak",
  errorMessage: "TeamSpeak runtime not initialized"
});
export {
  getOptionalTeamSpeakRuntime,
  getTeamSpeakRuntime,
  setTeamSpeakRuntime
};
