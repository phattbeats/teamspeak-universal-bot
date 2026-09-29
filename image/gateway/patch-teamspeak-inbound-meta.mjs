// PHA-3829: stop OpenClaw core from appending its per-turn "Conversation info"
// block to TeamSpeak turns. The block arrives after the speaker's line, wrapped
// in <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>, and the bots read it as something
// the speaker pasted. Everything in it (sender, message id, chat id) is already
// in the "[teamspeak voice] <nick> said: ..." body.
// Idempotent. Exits non-zero if OpenClaw's code no longer matches, so an
// upgrade breaks the build loudly instead of quietly dropping the fix.
import fs from "node:fs";
import path from "node:path";

const dist = process.argv[2] ?? "/app/dist";
const MARKER = "/* PHA-3829 teamspeak */";
const SIGNATURE = "function buildInboundUserContextPrefix(ctx, envelope, sessionEntry) {";
const GUARD = `${SIGNATURE}\n\t${MARKER} if (ctx?.Provider === "teamspeak" || ctx?.Surface === "teamspeak") return "";`;

const hits = fs.readdirSync(dist).filter((name) => name.startsWith("inbound-meta-") && name.endsWith(".mjs"))
  .map((name) => path.join(dist, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes(SIGNATURE));
if (hits.length !== 1) {
  console.error(`patch-teamspeak-inbound-meta: expected 1 file defining buildInboundUserContextPrefix, found ${hits.length}`);
  process.exit(1);
}
const file = hits[0];
const text = fs.readFileSync(file, "utf8");
if (text.includes(MARKER)) {
  console.log(`patch-teamspeak-inbound-meta: already applied (${file})`);
  process.exit(0);
}
fs.writeFileSync(file, text.replace(SIGNATURE, GUARD));
console.log(`patch-teamspeak-inbound-meta: applied (${file})`);
