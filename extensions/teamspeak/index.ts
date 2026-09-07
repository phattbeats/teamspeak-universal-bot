// TeamSpeak plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "teamspeak",
  name: "TeamSpeak",
  description: "TeamSpeak channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "teamspeakPlugin",
  },
  // The stt-tts lane runs the agent turn and the TTS synthesis in-process, and
  // both live on PluginRuntime (PHA-3228). Without this the lane has no host.
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setTeamSpeakRuntime",
  },
});
