// PHA-3818: Lexton randomly DMs someone on the server with one ominous line.
// Every MENACE_MIN..MENACE_MAX minutes: read the whole-server channel tree off
// the core's bridge, pick a random human (never a bot, never Emily or
// miss_shade), have the lexton agent write the line, and PM it via 0x89.
// Runs as supervisor program `menace`; lives in /config so it survives a
// container recreate (the supervisor stanza does not — see deploy-lexton.sh).
const { execFile } = require("child_process");
const WebSocket = require("/opt/openclaw-teamspeak-plugin/node_modules/ws");

const MIN = Number(process.env.MENACE_MIN_MINUTES || 20);
const MAX = Number(process.env.MENACE_MAX_MINUTES || 60);
const BOTS = /^(sexton|bexton|lexton)\d*$/i;
const SPARED = /emily|miss_shade/i;
let lastVictim = null;

const log = (...a) => console.log(new Date().toISOString(), "[menace]", ...a);
const frame = (t, o) => { const h = Buffer.from(JSON.stringify(o)); const f = Buffer.alloc(5 + h.length); f.writeUInt8(t, 0); f.writeUInt32LE(h.length, 1); h.copy(f, 5); return f; };

function withBridge(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:9099");
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("bridge timeout")); }, 10000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("open", () => fn(ws, (v) => { clearTimeout(timer); setTimeout(() => ws.close(), 500); resolve(v); }));
  });
}

const channelTree = () => withBridge((ws, done) => {
  ws.on("message", (d) => {
    const b = Buffer.from(d);
    if (b.readUInt8(0) === 0x08) done(JSON.parse(b.subarray(5, 5 + b.readUInt32LE(1)).toString()));
  });
  ws.send(frame(0x95, {}));
});

const sendPm = (clientId, text) => withBridge((ws, done) => { ws.send(frame(0x89, { target: clientId, text })); done(); });

function writeLine(nickname) {
  return new Promise((resolve, reject) => {
    execFile("openclaw", ["agent", "--agent", "lexton", "--session-id", `menace-${Date.now()}`, "--json", "--thinking", "off",
      "--message", `[MENACE DM for ${nickname}]`], { timeout: 120000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const text = JSON.parse(stdout).result.payloads.map((p) => p.text).filter(Boolean).join(" ").trim();
        text ? resolve(text) : reject(new Error("empty reply"));
      } catch (e) { reject(e); }
    });
  });
}

async function strike() {
  const tree = await channelTree();
  const people = tree.flatMap((c) => c.occupants)
    .filter((o) => !BOTS.test(o.nickname) && !(o.serverGroups || []).includes("Sexton") && !SPARED.test(o.nickname));
  // MENACE_ONLY=<nick>: test hook, strike only that person.
  if (process.env.MENACE_ONLY) people.splice(0, people.length, ...people.filter((p) => p.nickname === process.env.MENACE_ONLY));
  if (people.length === 0) return log("nobody worth threatening online");
  const pool = people.length > 1 ? people.filter((p) => p.nickname !== lastVictim) : people;
  const victim = pool[Math.floor(Math.random() * pool.length)];
  const text = (await writeLine(victim.nickname)).slice(0, 900);
  // Short lines go out as a poke (pops up mid-screen), long ones as a DM.
  const how = text.length <= 100 ? "poke" : "DM";
  if (how === "poke") await withBridge((ws, done) => { ws.send(frame(0x88, { clientId: victim.clientId, text })); done(); });
  else await sendPm(victim.clientId, text);
  lastVictim = victim.nickname;
  log(`${how} -> ${victim.nickname} (#${victim.clientId}): ${text}`);
}

async function loop() {
  for (;;) {
    const mins = MIN + Math.random() * (MAX - MIN);
    log(`next strike in ${mins.toFixed(1)} min`);
    await new Promise((r) => setTimeout(r, mins * 60000));
    try { await strike(); } catch (e) { log("strike failed:", e.message); }
  }
}

if (process.argv[2] === "--now") strike().then(() => process.exit(0), (e) => { log("failed:", e.message); process.exit(1); });
else loop();
