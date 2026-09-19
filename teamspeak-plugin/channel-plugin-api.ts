// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag setup-only surfaces into lightweight channel plugin loads.
export { teamspeakPlugin } from "./src/channel.js";
