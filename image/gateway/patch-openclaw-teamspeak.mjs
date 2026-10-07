// #3829: two narrow patches to OpenClaw core for TeamSpeak turns. The voice
// lane marks its turns ChatType "direct" (a group context would re-run the
// channel's mention policy, and the wake gate already did that job), and core
// treats "direct" in two ways that break a bot sharing a room:
//
//  1. inbound-meta: a "Conversation info" JSON block rides after every line,
//     wrapped in <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>. The bots read it as
//     something the speaker pasted. Nothing in it is new (the line already says
//     who spoke), so it is dropped for TeamSpeak.
//  2. dispatch-from-config: "direct" hard-codes silent replies to "disallow",
//     so a bot that answered NO_REPLY got re-run until it said something. That
//     is most of why the bots answered everything. TeamSpeak turns use the
//     group rule for this one decision (silence allowed); nothing else changes.
//
// Idempotent. Exits non-zero if OpenClaw's code no longer matches, so an
// OPENCLAW_VERSION bump breaks the build loudly instead of quietly dropping a fix.
import fs from "node:fs";
import path from "node:path";

const dist = process.argv[2] ?? "/app/dist";
const IS_TEAMSPEAK = `(ctx?.Provider === "teamspeak" || ctx?.Surface === "teamspeak")`;

const patches = [
  {
    name: "inbound-meta",
    prefix: "inbound-meta-",
    marker: "/* #3829 teamspeak meta */",
    find: "function buildInboundUserContextPrefix(ctx, envelope, sessionEntry) {",
    replace: (find, marker) => `${find}\n\t${marker} if ${IS_TEAMSPEAK} return "";`,
  },
  {
    name: "silent-reply",
    prefix: "dispatch-from-config-",
    marker: "/* #3829 teamspeak silent */",
    find: "const silentReplyConversationType = resolveRoutedPolicyConversationType(ctx);",
    replace: (_find, marker) =>
      `const silentReplyConversationType = ${marker} ${IS_TEAMSPEAK} ? "group" : resolveRoutedPolicyConversationType(ctx);`,
  },
];

let failed = false;
for (const patch of patches) {
  const hits = fs
    .readdirSync(dist)
    .filter((name) => name.startsWith(patch.prefix) && name.endsWith(".mjs"))
    .map((name) => path.join(dist, name))
    .filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return text.includes(patch.find) || text.includes(patch.marker);
    });
  if (hits.length !== 1) {
    console.error(`patch-openclaw-teamspeak: ${patch.name}: expected 1 file, found ${hits.length}`);
    failed = true;
    continue;
  }
  const file = hits[0];
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`patch-openclaw-teamspeak: ${patch.name}: already applied (${file})`);
    continue;
  }
  if (text.split(patch.find).length !== 2) {
    console.error(`patch-openclaw-teamspeak: ${patch.name}: target is not unique in ${file}`);
    failed = true;
    continue;
  }
  fs.writeFileSync(file, text.replace(patch.find, patch.replace(patch.find, patch.marker)));
  console.log(`patch-openclaw-teamspeak: ${patch.name}: applied (${file})`);
}
process.exit(failed ? 1 : 0);
