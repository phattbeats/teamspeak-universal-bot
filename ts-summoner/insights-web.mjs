// #3963: the TeamSpeak insights dashboard. Its own supervisor program, so a
// bad query here can't stall the summoner's shifts; the summoner records, this
// reads (plus ingests the gateway's transcripts, which only it touches).
//
//   GET /                      the dashboard (insights/index.html)
//   GET /api/overview?days=N   tiles, weekday x hour heatmaps, per-day series
//   GET /api/people?days=N     per person: voice, talk, chat, heard, bot turns
//   GET /api/bots?days=N       per bot + what drives engagement
//   GET /api/log?types=&q=&nick=&before=&limit=   the everything-log
//   /api/control/...           tools+skills, persona files, shifts (control.mjs); writes need X-Requested-With
//   /api/control/bots/...      #4374: the bot list: enable/disable, edit, add, remove; live via stack.mjs rewire
//   /api/control/voice/on|off  #4374: the stack-wide voice switch (the summoner's POST /voice/*)
//
// Every route sits behind HTTP basic auth: this is everyone's chat and speech.
// The credentials are /config/insights/auth.txt (`user:password`), generated
// on first start if missing; `cat` it on the box to log in.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { applyTurnOps, getMeta, openDb, parseRoomLog, setMeta, turnOps } from './insights.mjs';
import { bots, logPage, overview, people } from './insights-stats.mjs';
import {
  addBot, applyTools, cleanShifts, editBot, listBots, parseSupervisorStatus, personaFiles, personaHistory, readHistory,
  readJson, readPersona, readTools, removeBot, scanSkills, setBotEnabled, writeAtomic, writePersona, writeShifts,
  writeSummonerNick,
} from './control.mjs';

const log = (...a) => console.log(new Date().toISOString(), 'insights:', ...a);
const env = process.env;
const cfg = JSON.parse(readFileSync(env.SUMMONER_CONFIG || '/run/universal/summoner.json', 'utf8'));
const ic = cfg.insights ?? {};
const DB_PATH = ic.db ?? '/config/insights/insights.db';
const PORT = Number(env.INSIGHTS_PORT || ic.port || 8097);
const AUTH_FILE = ic.authFile ?? DB_PATH.replace(/[^/]*$/, 'auth.txt');
const OPENCLAW = env.OPENCLAW_STATE_DIR || '/config/openclaw';
const LOGS = env.SEXTON_LOG_DIR || '/var/sexton-logs';
const TZ = cfg.tz || 'America/New_York';
const RETENTION_DAYS = ic.retentionDays ?? 365;
const BOT_NICKS = new Set(Object.values(cfg.bots ?? {}).map((b) => String(b.nick).toLowerCase()));
// Not people: our bots, Lexton's henchman, and the test logins runs have used.
// `insights.hideNicks` (regexes) in the summoner config replaces this list.
const HIDE = (ic.hideNicks ?? ['^PHA\\d', '^pha\\d', 'Probe$', 'Test(er)?$', '^Ledger\\d*$', '^Henchbot$', '^serveradmin'])
  .map((r) => new RegExp(r, 'i'));
const hide = (nick) => !nick || BOT_NICKS.has(String(nick).toLowerCase()) || HIDE.some((r) => r.test(nick));
const PAGE = new URL('./insights/index.html', import.meta.url);

const CONFIG_DIR = env.UNIVERSAL_CONFIG_DIR || '/config';
const OPENCLAW_JSON = env.OPENCLAW_CONFIG_PATH || `${OPENCLAW}/openclaw.json`;
const WORKSPACES = `${OPENCLAW}/workspace/agents`;
const SUMMONER_EDITABLE = `${CONFIG_DIR}/summoner/config.json`;
const SKILL_DIRS = (env.CONTROL_SKILL_DIRS || `${OPENCLAW}/plugin-skills:${OPENCLAW}/skills:${OPENCLAW}/workspace/skills:/usr/local/lib/node_modules/openclaw/skills`).split(':');
const SUMMONER_URL = `http://127.0.0.1:${cfg.httpPort || 8099}`;
const MERGED = env.SUMMONER_CONFIG || '/run/universal/summoner.json';
// #4374: the bot list and what applies it.
const BOTS_FILE = `${CONFIG_DIR}/bots.json`;
const STACK = env.UNIVERSAL_STACK || '/opt/universal/stack.mjs';
const SUPERVISORCTL = env.SUPERVISORCTL || 'supervisorctl';
const SEED = env.UNIVERSAL_SEED || '/opt/sexton-gateway/openclaw.seed.json';

const db = openDb(DB_PATH);

// ------------------------------------------------------------------ auth --

if (!existsSync(AUTH_FILE)) {
  writeFileSync(AUTH_FILE, `admin:${randomBytes(12).toString('base64url')}\n`, { mode: 0o600 });
  log(`generated login in ${AUTH_FILE}`);
}
const authOk = (header) => {
  const want = Buffer.from(`Basic ${Buffer.from(readFileSync(AUTH_FILE, 'utf8').trim()).toString('base64')}`);
  const got = Buffer.from(String(header || ''));
  return got.length === want.length && timingSafeEqual(got, want);
};

// ------------------------------------------------- transcript ingestion --
// Each bot's turns live in its agent's openclaw-agent.sqlite (transcript_events).
// Read-only, from the last rowid we saw, in pages.

function ingestBot(id) {
  const path = `${OPENCLAW}/agents/${id}/agent/openclaw-agent.sqlite`;
  if (!existsSync(path)) return 0;
  const src = new DatabaseSync(path, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout=3000');
    const page = src.prepare(`SELECT rowid, session_id, seq, created_at, event_json FROM transcript_events
      WHERE rowid > ? ORDER BY rowid LIMIT 2000`);
    let hw = Number(getMeta(db, `turns_hw:${id}`, 0)), n = 0;
    for (;;) {
      const rows = page.all(hw);
      if (!rows.length) break;
      n += applyTurnOps(db, id, turnOps(rows));
      hw = Number(rows.at(-1).rowid);
      setMeta(db, `turns_hw:${id}`, hw);
    }
    return n;
  } finally {
    src.close();
  }
}

function ingestAll() {
  for (const id of botIds()) {
    try {
      const n = ingestBot(id);
      if (n) log(`${id}: +${n} turns`);
    } catch (e) {
      log(`${id}: transcript ingest failed: ${e.message}`);
    }
  }
}

// ----------------------------------------------------- room-log backfill --
// Once: chat from before the recorder existed, out of the cores' room logs.

function backfillRoomLogs() {
  if (getMeta(db, 'backfill_roomlog')) return;
  const firstLive = db.prepare("SELECT MIN(ts) t FROM chat WHERE src = 'live'").get().t ?? Number.MAX_SAFE_INTEGER;
  const seen = new Set(), rows = [];
  for (const bot of existsSync(LOGS) ? readdirSync(LOGS) : []) {
    for (const ch of safeDir(`${LOGS}/${bot}`)) {
      for (const f of safeDir(`${LOGS}/${bot}/${ch}`)) {
        const m = /^(\d{4}-\d\d-\d\d)\.md$/.exec(f);
        if (!m) continue;
        for (const r of parseRoomLog(m[1], readFileSync(`${LOGS}/${bot}/${ch}/${f}`, 'utf8'))) {
          const k = `${r.ts}|${r.nick}|${r.text}`;
          if (r.ts >= firstLive || seen.has(k)) continue;
          seen.add(k);
          rows.push(r);
        }
      }
    }
  }
  const ins = db.prepare("INSERT INTO chat(ts,nick,target,text,is_bot,src) VALUES(?,?,'channel',?,?,'roomlog')");
  db.exec('BEGIN');
  for (const r of rows) ins.run(r.ts, r.nick, r.text, BOT_NICKS.has(r.nick.toLowerCase()) ? 1 : 0);
  db.exec('COMMIT');
  setMeta(db, 'backfill_roomlog', new Date().toISOString());
  log(`backfilled ${rows.length} chat lines from room logs`);
}
function safeDir(p) {
  try { return statSync(p).isDirectory() ? readdirSync(p) : []; } catch { return []; }
}

function prune() {
  if (!RETENTION_DAYS) return;
  const cut = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const [t, c] of [['chat', 'ts'], ['heard', 'ts'], ['joins', 'ts'], ['bot_events', 'ts'], ['bot_turns', 'ts'], ['voice', 'end_ts']]) {
    db.prepare(`DELETE FROM ${t} WHERE ${c} < ?`).run(cut);
  }
}

// --------------------------------------------------------------- control --

// The merged summoner config is rewritten by `stack.mjs rewire` when the Bots
// tab adds or removes a bot (#4374), so read it fresh: a bot added live shows
// up on every tab without restarting this server.
const botIds = () => Object.keys(readJson(MERGED, cfg).bots ?? {});
const need = (id) => { if (!botIds().includes(id)) throw Object.assign(new Error(`unknown bot ${id}`), { code: 404 }); return id; };
const personaDir = (id) => `${WORKSPACES}/${need(id)}`;

async function readBody(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 400_000) throw Object.assign(new Error('body too large'), { code: 413 }); }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('body is not JSON'), { code: 400 }); }
}

async function summoner(path, method = 'GET') {
  const r = await fetch(`${SUMMONER_URL}${path}`, { method, signal: AbortSignal.timeout(5000) });
  return r.json();
}

/** Read-modify-write openclaw.json; the gateway picks the change up from disk. */
function editOpenclaw(fn) {
  const raw = readFileSync(OPENCLAW_JSON, 'utf8');
  const next = fn(JSON.parse(raw));
  writeAtomic(`${OPENCLAW_JSON}.ctl-bak`, raw, 0o600);
  writeAtomic(OPENCLAW_JSON, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

// ---------------------------------------------------------- bots (#4374) --

/** Run a command, collect its output. Like the summoner's execLocal: callers read the output, exit codes are not thrown. */
function run(cmd, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd.join(' ')}: timeout`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}
const supervisorctl = async (...args) => (await run([SUPERVISORCTL, ...args])).out;

/** The persona packs on disk, by id, with the nick each would log in as. */
async function packsOnDisk() {
  const r = await run(['node', STACK, 'packs'], 20_000);
  let dirs = {};
  try { dirs = JSON.parse(r.out); } catch { throw new Error(`stack.mjs packs: ${r.out.slice(0, 200)}`); }
  return Object.fromEntries(Object.entries(dirs).map(([id, dir]) => [id, { dir, nick: readJson(`${dir}/voice.json`, {}).nick ?? null }]));
}

/** Read-modify-write bots.json with a .ctl-bak, like editOpenclaw. */
function editBots(fn) {
  const raw = existsSync(BOTS_FILE) ? readFileSync(BOTS_FILE, 'utf8') : '{}';
  const file = JSON.parse(raw);
  file.bots ??= {};
  let result;
  try { result = fn(file); } catch (e) { e.code ??= 400; throw e; } // validation text is the person's, not a 500
  writeAtomic(`${BOTS_FILE}.ctl-bak`, raw);
  writeAtomic(BOTS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  return result;
}

/**
 * Make bots.json live: regenerate bots.conf + the gateway wiring, then let
 * supervisord add/remove/restart only the programs whose config changed. The
 * summoner keeps its bot list in memory, so it is restarted when that list
 * (or a nick it finds a bot by) changed.
 */
async function applyBots({ restartSummoner = false } = {}) {
  const steps = {};
  const rewire = await run(['node', STACK, 'rewire'], 120_000);
  steps.rewire = rewire.out;
  if (rewire.code !== 0) throw new Error(`stack.mjs rewire failed: ${rewire.out.slice(-400)}`);
  steps.reread = await supervisorctl('reread');
  steps.update = await supervisorctl('update');
  if (restartSummoner) steps.summoner = await supervisorctl('restart', 'summoner');
  return steps;
}

async function botsSnapshot() {
  const [packs, status, live] = await Promise.all([
    packsOnDisk(),
    supervisorctl('status').catch((e) => `supervisorctl: ${e.message}`),
    summoner('/status').catch(() => null),
  ]);
  const accounts = readJson(OPENCLAW_JSON, {})?.channels?.teamspeak?.accounts ?? {};
  const file = readJson(BOTS_FILE, { bots: {} });
  return {
    ...listBots(file, packs, { programs: parseSupervisorStatus(status), live, accounts }),
    summoner: !!live,
    voice: live?.voice ?? 'unknown',
    seedVoiceMode: seedVoiceMode(),
  };
}
const seedVoiceMode = () => readJson(SEED, {})?.channels?.teamspeak?.voice?.mode ?? 'stt-tts';
const programsOf = (id, entry) => [`core-${id}`, ...(entry?.menace ? [`menace-${id}`] : [])];

async function controlBots(req, id, verb, send) {
  if (!id) return send(200, await botsSnapshot());
  if (verb === 'summon' || verb === 'dismiss') {
    need(id);
    return send(200, await summoner(`/${verb}/${id}?by=dashboard`, 'POST'));
  }
  if (verb === 'voice') {
    // Per-bot voice: the account's voice.mode. "off" = text-only; "on" = back
    // to the seed's lane (stt-tts). The gateway picks it up from disk.
    need(id);
    const { mode } = await readBody(req);
    if (mode !== 'on' && mode !== 'off') throw Object.assign(new Error('mode must be on or off'), { code: 400 });
    editOpenclaw((c) => {
      const a = c?.channels?.teamspeak?.accounts?.[id];
      if (!a) throw new Error(`unknown bot ${id}`);
      (a.voice ??= {}).mode = mode === 'off' ? 'off' : seedVoiceMode();
      return c;
    });
    log(`control: bots ${id}: voice ${mode}`);
    return send(200, { id, voiceMode: mode === 'off' ? 'off' : seedVoiceMode() });
  }
  if (verb === 'enabled') {
    if (req.method !== 'PUT') return send(405, { error: 'PUT only' });
    const { on } = await readBody(req);
    const entry = editBots((f) => setBotEnabled(f, id, on));
    const steps = {};
    if (!on) for (const p of programsOf(id, entry)) steps[`stop ${p}`] = await supervisorctl('stop', p);
    Object.assign(steps, await applyBots({ restartSummoner: true }));
    if (on && entry.autostart !== false) {
      try { unlinkSync(`${CONFIG_DIR}/bots/${id}/.off-duty`); } catch { /* was not off duty */ }
      for (const p of programsOf(id, entry)) steps[`start ${p}`] = await supervisorctl('start', p);
    }
    log(`control: bots ${id}: ${on ? 'enabled' : 'disabled'} ${JSON.stringify(steps)}`);
    return send(200, { id, enabled: on, steps, note: on && entry.autostart === false ? 'enabled; it has autostart off, so Summon (or its shift) brings it in' : null });
  }
  if (verb) return send(404, { error: 'not found' });
  if (req.method === 'PUT') {
    const patch = await readBody(req);
    const before = readJson(BOTS_FILE, {})?.bots?.[id];
    const entry = editBots((f) => editBot(f, id, patch));
    let nickChanged = false;
    if ('nick' in patch && (before?.nick ?? null) !== (entry.nick ?? null)) {
      const nick = entry.nick || (await packsOnDisk())[id]?.nick || id[0].toUpperCase() + id.slice(1);
      writeSummonerNick(SUMMONER_EDITABLE, id, nick);
      nickChanged = true;
    }
    const steps = await applyBots({ restartSummoner: nickChanged });
    log(`control: bots ${id}: edited ${JSON.stringify(patch)} ${JSON.stringify(steps)}`);
    return send(200, { id, entry, steps });
  }
  if (req.method === 'POST') {
    const patch = await readBody(req);
    const packs = await packsOnDisk();
    const entry = editBots((f) => addBot(f, id, patch, Object.keys(packs)));
    const steps = await applyBots({ restartSummoner: true });
    log(`control: bots ${id}: added ${JSON.stringify(entry)} ${JSON.stringify(steps)}`);
    return send(200, { id, entry, steps });
  }
  if (req.method === 'DELETE') {
    const before = readJson(BOTS_FILE, {})?.bots?.[id];
    if (!before) return send(404, { error: `unknown bot ${id}` });
    const steps = {};
    for (const p of programsOf(id, before)) steps[`stop ${p}`] = await supervisorctl('stop', p);
    editBots((f) => removeBot(f, id));
    Object.assign(steps, await applyBots({ restartSummoner: true }));
    log(`control: bots ${id}: removed (home and identity kept) ${JSON.stringify(steps)}`);
    return send(200, { id, removed: true, steps });
  }
  return send(405, { error: 'GET, PUT, POST or DELETE' });
}

async function control(req, url, send) {
  const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // after /api/control
  const [area, id, file, sub, version] = parts;
  const write = req.method !== 'GET';
  if (write && !req.headers['x-requested-with']) return send(403, { error: 'missing X-Requested-With' });
  const skills = () => scanSkills(SKILL_DIRS);

  if (area === 'bots') return controlBots(req, id, file, send);
  if (area === 'voice') {
    // The stack-wide switch (#4372 API, #4374 UI): POST /api/control/voice/on|off.
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    if (id !== 'on' && id !== 'off') return send(404, { error: 'POST voice/on | voice/off' });
    const r = await summoner(`/voice/${id}?by=dashboard`, 'POST');
    log(`control: voice ${id}: ${JSON.stringify(r)}`);
    return send(200, r);
  }
  if (area === 'tools') {
    if (!id) return send(200, readTools(readJson(OPENCLAW_JSON, {}), botIds(), skills()));
    if (req.method !== 'PUT') return send(405, { error: 'PUT only' });
    need(id);
    const patch = await readBody(req);
    editOpenclaw((c) => applyTools(c, id, patch, skills()));
    log(`control: tools for ${id}: ${JSON.stringify(patch)}`);
    return send(200, readTools(readJson(OPENCLAW_JSON, {}), botIds(), skills()).bots[id]);
  }
  if (area === 'persona') {
    if (!id) return send(200, Object.fromEntries(botIds().map((b) => [b, personaFiles(personaDir(b))])));
    const dir = personaDir(id);
    if (!file) return send(200, personaFiles(dir));
    if (sub === 'history') {
      return send(200, version ? { text: readHistory(dir, file, version) } : personaHistory(dir, file));
    }
    if (req.method === 'PUT') {
      const { text } = await readBody(req);
      const backup = writePersona(dir, file, text);
      log(`control: persona ${id}/${file} saved (backup ${backup})`);
      return send(200, { ok: true, backup });
    }
    return send(200, { text: readPersona(dir, file), history: personaHistory(dir, file) });
  }
  if (area === 'schedule') {
    if (!id) {
      const status = await summoner('/status').catch(() => null);
      const eff = readJson(env.SUMMONER_CONFIG || '/run/universal/summoner.json', cfg);
      return send(200, {
        tz: TZ, summoner: !!status,
        bots: Object.fromEntries(botIds().map((b) => [b, {
          nick: eff.bots[b].nick, shifts: eff.bots[b].shifts ?? [], guest: !!eff.bots[b].guest,
          live: status?.bots?.[b] ?? null,
        }])),
      });
    }
    need(id);
    if (file === 'summon' || file === 'dismiss') return send(200, await summoner(`/${file}/${id}?by=dashboard`, 'POST'));
    if (req.method !== 'PUT') return send(405, { error: 'PUT only' });
    const shifts = cleanShifts((await readBody(req)).shifts);
    const merged = env.SUMMONER_CONFIG || '/run/universal/summoner.json';
    const wrote = writeShifts(SUMMONER_EDITABLE, id, shifts);
    writeShifts(merged, id, shifts);
    if (!wrote) return send(409, { error: `${SUMMONER_EDITABLE} has no entry for ${id}` });
    const reload = await summoner('/reload', 'POST').catch((e) => ({ error: e.message }));
    log(`control: shifts for ${id}: ${JSON.stringify(shifts)} (reload: ${JSON.stringify(reload)})`);
    return send(200, { shifts, reload });
  }
  return send(404, { error: 'not found' });
}

// ------------------------------------------------------------------ http --

function range(qs) {
  const now = Date.now();
  const days = qs.get('days');
  const from = days === 'all' ? 0 : now - Number(days || 30) * 86_400_000;
  return { from, to: now + 60_000, tz: TZ, now, hide };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (!authOk(req.headers.authorization)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TeamSpeak insights"' });
    return res.end('login required');
  }
  try {
    const qs = url.searchParams;
    switch (url.pathname) {
      case '/': return send(200, readFileSync(PAGE), 'text/html; charset=utf-8');
      case '/api/overview': return send(200, overview(db, range(qs)));
      case '/api/people': return send(200, people(db, range(qs)));
      case '/api/bots': return send(200, bots(db, range(qs)));
      case '/api/log': {
        const r = range(qs);
        return send(200, logPage(db, {
          types: (qs.get('types') || 'chat,heard,turn,join,voice,bot').split(','),
          q: qs.get('q') || '', nick: qs.get('nick') || '',
          before: Number(qs.get('before')) || Number.MAX_SAFE_INTEGER, after: r.from,
          limit: Number(qs.get('limit')) || 200,
        }));
      }
      default:
        if (url.pathname.startsWith('/api/control/')) return await control(req, url, send);
        return send(404, { error: 'not found' });
    }
  } catch (e) {
    log(`${url.pathname}: ${e.message}`);
    const code = e.code && e.code >= 400 && e.code < 500 ? e.code : e instanceof SyntaxError || /^(unknown|bad|shift|not an|file too|refusing|text must|villain|band|skills|days)/.test(e.message) ? 400 : 500;
    return send(code, { error: e.message });
  }
}).listen(PORT, () => log(`dashboard on :${PORT}, db ${DB_PATH}`));

try { backfillRoomLogs(); } catch (e) { log('backfill failed:', e.message); }
ingestAll();
setInterval(ingestAll, (ic.ingestSec ?? 60) * 1000);
prune();
setInterval(() => { try { prune(); } catch (e) { log('prune:', e.message); } }, 6 * 3_600_000);
