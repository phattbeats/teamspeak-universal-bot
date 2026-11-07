// Narrow entry for the host's runtime injection, kept separate from the
// channel plugin module so bootstrap does not load the voice graph to set it.
export { setTeamSpeakRuntime } from "./src/runtime.js";
