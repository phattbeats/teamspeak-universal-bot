// PHA-3821: shift schedule + chat summoning for the TeamSpeak bots.
//
// The bots used to live in the server 24/7. This sidecar is the one thing that
// does: an invisible ServerQuery login (not on anyone's roster) that
//   - keeps each bot on its shift (sexton days, bexton evenings, lexton nights),
//   - reads channel chat, so "hey bexton" typed while he's gone brings him in,
//     "go home bexton" sends him off, and trash-talking Lexton makes him crash in,
//   - watches who is talking, so a bot whose shift ends mid-conversation waits.
//
// "Gone" is real: the bot's TeamSpeak core (supervisor program `sexton` in its
// container) is stopped, so it drops off the roster. The gateway/brain stays up.
// Voice can't summon anyone here -- ServerQuery gets no audio -- so a spoken
// "hey bexton" only works through a bot that's already in the channel, via the
// HTTP API below. Those bots also forward what they hear to POST /heard, so a
// spoken jab at Lexton crashes him in under the same cooldown as chat (PHA-3823).
//
// No npm deps: `ssh` (+ sshpass) for the query, the Docker socket for exec.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';

const CONFIG_PATH = process.env.SUMMONER_CONFIG || '/app/config.json';
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const QUERY_PASS = readFileSync(cfg.query.passFile, 'utf8').trim();
const BOT_NICKS = new Set(Object.values(cfg.bots).map((b) => b.nick.toLowerCase()));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MIN = 60_000;

// ---------------------------------------------------------------- schedule --

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: cfg.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function local(ts) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: DAYS[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// A shift's `days` are the days it STARTS on; start > end crosses midnight.
function onShift(bot, ts) {
  const { day, min } = local(ts);
  const yesterday = (day + 6) % 7;
  return bot.shifts.some((s) => {
    const days = s.days ?? [0, 1, 2, 3, 4, 5, 6];
    const a = hm(s.start), b = hm(s.end);
    if (a < b) return days.includes(day) && min >= a && min < b;
    return (days.includes(day) && min >= a) || (days.includes(yesterday) && min < b);
  });
}

// First minute at or after `ts` where onShift() equals `want` (24h horizon).
function nextFlip(bot, ts, want) {
  for (let t = ts; t < ts + 24 * 60 * MIN; t += MIN) if (onShift(bot, t) === want) return t;
  return ts + 24 * 60 * MIN;
}

// ------------------------------------------------------------------- state --

const state = {};
for (const [id, bot] of Object.entries(cfg.bots)) {
  state[id] = {
    override: null, // { mode: 'on'|'off', until, why }
    lastMention: 0,
    crashCooldownUntil: 0,
    running: null, // supervisor truth, refreshed each reconcile
    lastAction: 0,
    onDuty: false, // last decision was 'on'; only an on-duty bot gets talk-grace
    graceLogged: false,
  };
}
const room = { humans: 0, lastHumanTalk: 0, lastHumanSeen: 0, queryUp: false };

function desired(id, now) {
  const bot = cfg.bots[id], st = state[id];
  const o = st.override;
  if (o && now < o.until) return { on: o.mode === 'on', why: o.why };
  if (o) { log(`${id}: override '${o.why}' expired`); st.override = null; }
  if (onShift(bot, now)) return { on: true, why: 'on shift' };
  // Shift over: don't walk out mid-conversation. The query can see who is
  // talking (client_flag_talking), not what about, so any human voice counts.
  // Only for a bot we had on duty: a core that came back by itself (container
  // restart, supervisord autostart) off shift gets stopped, not held (PHA-3831).
  if (st.running && st.onDuty && now - room.lastHumanTalk < cfg.idleGraceMin * MIN) {
    return { on: true, why: 'shift over, waiting for the room to go quiet' };
  }
  return { on: false, why: 'off shift' };
}

function summon(id, why, stayMin = cfg.summonStayMin) {
  const now = Date.now(), st = state[id];
  st.lastMention = now;
  st.override = { mode: 'on', until: now + stayMin * MIN, why };
  log(`${id}: SUMMON (${why}) for ${stayMin}m`);
  reconcile().catch((e) => log('reconcile', e.message));
}

function dismiss(id, why) {
  const now = Date.now(), bot = cfg.bots[id], st = state[id];
  if (onShift(bot, now)) {
    // Off for the rest of this shift, then the schedule resumes.
    st.override = { mode: 'off', until: nextFlip(bot, now, false), why };
  } else {
    st.override = null; // summoned off-shift: just drop back to the schedule
    room.lastHumanTalk = 0; // and don't let the talk-grace hold him
  }
  log(`${id}: DISMISS (${why})`);
  reconcile().catch((e) => log('reconcile', e.message));
}

// ------------------------------------------------------------ docker exec --

function dockerApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock', method, path,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => (res.statusCode >= 300
        ? reject(new Error(`docker ${method} ${path} -> ${res.statusCode} ${data.slice(0, 200)}`))
        : resolve(data)));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('docker api timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function exec(container, cmd) {
  const { Id } = JSON.parse(await dockerApi('POST', `/containers/${container}/exec`,
    { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true }));
  return (await dockerApi('POST', `/exec/${Id}/start`, { Detach: false, Tty: true })).trim();
}

// The core is `[program:sexton]` in every bot container. The marker file tells
// sexton-healthcheck the bot is off duty, not broken.
async function coreRunning(bot) {
  const out = await exec(bot.container, ['supervisorctl', 'status', 'sexton']);
  return /\b(RUNNING|STARTING|BACKOFF)\b/.test(out);
}
async function startCore(bot) {
  await exec(bot.container, ['rm', '-f', '/config/.off-duty']);
  return exec(bot.container, ['supervisorctl', 'start', 'sexton']);
}
async function stopCore(bot) {
  await exec(bot.container, ['touch', '/config/.off-duty']);
  return exec(bot.container, ['supervisorctl', 'stop', 'sexton']);
}

let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const now = Date.now();
    // Summoned bots leave once the server has had no humans for a while.
    for (const [id, st] of Object.entries(state)) {
      if (st.override?.mode === 'on' && room.queryUp && room.humans === 0
          && now - room.lastHumanSeen > cfg.idleGraceMin * MIN) {
        log(`${id}: server empty, ending '${st.override.why}'`);
        st.override = null;
      }
    }
    for (const [id, bot] of Object.entries(cfg.bots)) {
      const st = state[id];
      try {
        st.running = await coreRunning(bot);
      } catch (e) {
        log(`${id}: status failed: ${e.message}`);
        continue;
      }
      const d = desired(id, now);
      st.onDuty = d.on;
      if (d.on === st.running) continue;
      if (now - st.lastAction < 60_000) continue; // one move per bot per minute
      st.lastAction = now;
      log(`${id}: ${d.on ? 'START' : 'STOP'} core (${d.why})`);
      try {
        const out = d.on ? await startCore(bot) : await stopCore(bot);
        log(`${id}: ${out}`);
      } catch (e) {
        log(`${id}: action failed: ${e.message}`);
      }
    }
  } finally {
    reconciling = false;
  }
}

// ------------------------------------------------------------ chat rules --

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ');
const has = (text, list) => list.some((w) => new RegExp(`\\b${w}\\b`).test(text));

function namedBots(text) {
  return Object.entries(cfg.bots).filter(([, b]) => has(text, b.names)).map(([id]) => id);
}

function onChat(invokerName, rawMsg) {
  if (!invokerName || BOT_NICKS.has(invokerName.toLowerCase())) return; // no bot-to-bot loops
  if (rawMsg.trim().startsWith('{')) return; // TS6 attachment JSON, not speech
  const text = words(rawMsg);
  const now = Date.now();
  for (const id of namedBots(text)) {
    const bot = cfg.bots[id], st = state[id];
    const on = desired(id, now).on;
    // "don't leave bexton" is not a dismissal.
    if (has(text, cfg.rules.dismissWords) && !/\b(don'?t|do not|never|stay)\b/.test(text)) {
      if (on) dismiss(id, `${invokerName}: "${rawMsg.slice(0, 80)}"`);
      continue;
    }
    if (on) {
      // Already here: a mention keeps a summoned bot around a bit longer.
      if (st.override?.mode === 'on') st.override.until = Math.max(st.override.until, now + cfg.summonStayMin * MIN);
      st.lastMention = now;
      continue;
    }
    const startsWithName = bot.names.some((n) => text.trimStart().startsWith(n));
    if (startsWithName || has(text, cfg.rules.summonWords)) {
      summon(id, `${invokerName} called him in chat`);
    } else {
      trashTalk(id, text, invokerName);
    }
  }
}

// Named + insulted while away: crash in, once per cooldown. Returns true if summoned.
function trashTalk(id, text, who) {
  const bot = cfg.bots[id], st = state[id], now = Date.now();
  if (!bot.trashTalk || !has(text, cfg.rules.insultWords)) return false;
  if (now < st.crashCooldownUntil) {
    log(`${id}: trash-talk heard, but still cooling down`);
    return false;
  }
  st.crashCooldownUntil = now + bot.trashTalk.cooldownMin * MIN;
  summon(id, `${who} talked shit about him`, bot.trashTalk.stayMin);
  return true;
}

// PHA-3823: a transcript from a bot's STT. Voice only crashes in trash-talk
// targets; a spoken "get Bexton in here" is the listening bot's summon_bot.
function onHeard(who, raw) {
  if (!who || BOT_NICKS.has(who.toLowerCase())) return []; // bots hear each other
  const text = words(raw);
  return namedBots(text).filter((id) => !desired(id, Date.now()).on && trashTalk(id, text, `${who} (voice)`));
}

// URL segment -> bot id; any configured name works ("lex", "luthor", "bex").
function resolveBot(name) {
  const n = decodeURIComponent(name || '').toLowerCase().trim();
  if (cfg.bots[n]) return n;
  return Object.entries(cfg.bots).find(([, b]) => b.names.includes(n))?.[0];
}

// -------------------------------------------------------- off-shift log --

// PHA-3830: the room log is written by the logging bot's core, so nothing got
// recorded while it was off shift and the next catch-up had nothing to say.
// While that core is known stopped, append channel chat to the same file in
// its own `HH:MM  nick: text` shape (UTC, like the core); it rehydrates the
// file when it starts. Unknown state (null) writes nothing, to avoid doubles.
function logChat(invokerName, rawMsg, targetmode) {
  const cl = cfg.chatLog;
  if (!cl || targetmode !== '2' || !invokerName || invokerName.includes(':')) return;
  if (state[cl.whenOff]?.running !== false) return;
  const text = rawMsg.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const iso = new Date().toISOString();
  try {
    mkdirSync(cl.dir, { recursive: true });
    appendFileSync(`${cl.dir}/${iso.slice(0, 10)}.md`, `${iso.slice(11, 16)}  ${invokerName}: ${text}\n`);
  } catch (e) {
    log('chat log:', e.message);
  }
}

// ----------------------------------------------------------- ServerQuery --

const unesc = (s) => s.replace(/\\(.)/g, (_, c) => ({ s: ' ', p: '|', '/': '/', '\\': '\\', n: '\n', t: '\t', r: '' }[c] ?? c));
function parseProps(line) {
  const o = {};
  for (const tok of line.split(' ')) {
    const i = tok.indexOf('=');
    if (i < 0) o[tok] = '';
    else o[tok.slice(0, i)] = unesc(tok.slice(i + 1));
  }
  return o;
}

class Query {
  constructor() { this.queue = []; this.cur = null; this.buf = ''; }

  connect() {
    return new Promise((resolve, reject) => {
      const q = cfg.query;
      this.proc = spawn('sshpass', ['-e', 'ssh', '-T', '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
        '-o', 'ServerAliveInterval=60', '-p', String(q.port), `${q.user}@${q.host}`],
      { env: { ...process.env, SSHPASS: QUERY_PASS } });
      this.proc.stderr.on('data', (d) => log('query ssh:', d.toString().trim()));
      this.proc.on('exit', (code) => {
        room.queryUp = false;
        this.cur?.reject(new Error('query closed'));
        for (const c of this.queue) c.reject(new Error('query closed'));
        this.queue = []; this.cur = null;
        this.onClose?.(code);
      });
      let greeted = false;
      this.proc.stdout.on('data', (d) => {
        this.buf += d.toString().replace(/\r/g, '');
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
          if (!greeted) { if (line.startsWith('Welcome')) { greeted = true; resolve(); } continue; }
          this.onLine(line);
        }
      });
      setTimeout(() => (greeted ? null : reject(new Error('no query greeting'))), 15_000);
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    if (line.startsWith('notify')) {
      const sp = line.indexOf(' ');
      this.onNotify?.(line.slice(0, sp), parseProps(line.slice(sp + 1)));
      return;
    }
    if (!this.cur) return;
    if (line.startsWith('error ')) {
      const e = parseProps(line.slice(6));
      const c = this.cur; this.cur = null;
      if (e.id === '0') c.resolve(c.lines); else c.reject(new Error(`${c.cmd}: ${e.msg} (${e.id})`));
      this.pump();
    } else {
      this.cur.lines.push(line);
    }
  }

  cmd(cmd) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject, lines: [] });
      this.pump();
    });
  }

  pump() {
    if (this.cur || !this.queue.length) return;
    this.cur = this.queue.shift();
    this.proc.stdin.write(this.cur.cmd + '\n');
  }

  close() { this.proc?.kill(); }
}

const rows = (lines) => lines.join('|').split('|').filter(Boolean).map(parseProps);

async function pollRoom(q) {
  const clients = rows(await q.cmd('clientlist -voice'));
  const humans = clients.filter((c) => c.client_type === '0' && !BOT_NICKS.has((c.client_nickname || '').toLowerCase()));
  const now = Date.now();
  room.humans = humans.length;
  if (humans.length) room.lastHumanSeen = now;
  if (humans.some((c) => c.client_flag_talking === '1')) room.lastHumanTalk = now;
}

async function runQuery() {
  const q = new Query();
  q.onNotify = (kind, p) => {
    if (kind === 'notifytextmessage') {
      logChat(p.invokername, p.msg || '', p.targetmode);
      onChat(p.invokername, p.msg || '');
    }
  };
  await q.connect();
  await q.cmd('use 1');
  await q.cmd(`clientupdate client_nickname=${cfg.query.nickname.replace(/ /g, '\\s')}`).catch((e) => log(e.message));
  const [me] = rows(await q.cmd('whoami'));
  await q.cmd(`clientmove clid=${me.client_id} cid=${cfg.channelId}`).catch((e) => log('move:', e.message));
  await q.cmd('servernotifyregister event=textchannel');
  await q.cmd('servernotifyregister event=textserver');
  await q.cmd('servernotifyregister event=server');
  room.queryUp = true;
  log(`query up as clid=${me.client_id}, watching channel ${cfg.channelId}`);
  const timer = setInterval(() => pollRoom(q).catch((e) => log('poll:', e.message)), cfg.pollSec * 1000);
  await pollRoom(q);
  await new Promise((resolve) => { q.onClose = resolve; });
  clearInterval(timer);
  log('query connection closed');
}

async function queryLoop() {
  for (let backoff = 5; ; backoff = Math.min(backoff * 2, 120)) {
    try { await runQuery(); backoff = 5; } catch (e) { log('query error:', e.message); }
    await new Promise((r) => setTimeout(r, backoff * 1000));
  }
}

// ---------------------------------------------------------------- HTTP API --
// For the bots' own tools (a spoken "Sexton, get Bexton in here" goes through
// Sexton, who is in the channel and can hear it). Not published to the host.

function status() {
  const now = Date.now();
  return {
    now: new Date(now).toISOString(), room,
    bots: Object.fromEntries(Object.entries(cfg.bots).map(([id, b]) => [id, {
      running: state[id].running, desired: desired(id, now), onShift: onShift(b, now),
      override: state[id].override && { ...state[id].override, until: new Date(state[id].override.until).toISOString() },
    }])),
  };
}

http.createServer((req, res) => {
  const [, verb, id] = (req.url || '').split('?')[0].split('/');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && verb === 'status') return send(200, status());
  if (req.method === 'POST' && (verb === 'summon' || verb === 'dismiss')) {
    const bot = resolveBot(id);
    if (!bot) return send(404, { error: `unknown bot ${id}` });
    const by = new URL(req.url, 'http://x').searchParams.get('by') || 'api';
    const before = status().bots[bot];
    if (verb === 'summon') summon(bot, `summoned by ${by}`); else dismiss(bot, `dismissed by ${by}`);
    return send(200, { bot, ...before });
  }
  if (req.method === 'POST' && verb === 'heard') {
    const by = new URL(req.url, 'http://x').searchParams.get('by') || '';
    let body = '';
    req.on('data', (c) => { if (body.length < 4000) body += c; });
    req.on('end', () => send(200, { summoned: onHeard(by, body) }));
    return;
  }
  send(404, { error: 'GET /status | POST /summon/<bot> | POST /dismiss/<bot> | POST /heard?by=<speaker>' });
}).listen(cfg.httpPort, () => log(`http on :${cfg.httpPort}`));

setInterval(() => reconcile().catch((e) => log('reconcile', e.message)), cfg.reconcileSec * 1000);
reconcile().catch((e) => log('reconcile', e.message));
queryLoop();
