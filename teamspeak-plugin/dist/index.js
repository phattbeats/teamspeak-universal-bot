import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { createTeamSpeakAgentTools } from "./src/tools/agent-tools.js";
import { createTeamSpeakPersonaTools } from "./src/tools/persona-tools.js";
var index_default = defineBundledChannelEntry({
  id: "teamspeak",
  name: "TeamSpeak",
  description: "TeamSpeak channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "teamspeakPlugin"
  },
  // The stt-tts lane runs the agent turn and the TTS synthesis in-process, and
  // both live on PluginRuntime (PHA-3228). Without this the lane has no host.
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setTeamSpeakRuntime"
  },
  /**
   * The channel tools as agent tools (PHA-3428 item 4).
   *
   * A channel plugin has no seam for this: `createChannelPluginBase` copies a
   * fixed set of keys and `registerTool` is not among them, so the six tools
   * existed only as realtime provider functions and the stt-tts and text lanes
   * had none of them. `registerFull` is the hook the host calls in both `full`
   * and `tool-discovery` modes, which is exactly the tool registration path.
   *
   * `contracts.tools` in package.json must list every name registered here or
   * the host rejects the registration outright.
   */
  registerFull: (api) => {
    for (const tool of [...createTeamSpeakAgentTools(), ...createTeamSpeakPersonaTools()]) {
      api.registerTool(tool, { name: tool.name });
    }
  }
});
export {
  index_default as default
};
