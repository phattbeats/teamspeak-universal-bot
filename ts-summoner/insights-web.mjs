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
//
// Every route sits behind HTTP basic auth: this is everyone's chat and speech.
// The credentials are /config/insights/auth.txt (`user:password`), generated
// on first start if missing; `cat` it on the box to log in.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { applyTurnOps, getMeta, openDb, parseRoomLog, setMeta, turnOps } from './insights.mjs';
import { bots, logPage, overview, people } from './insights-stats.mjs';
import {
  applyTools, cleanShifts, personaFiles, personaHistory, readHistory, readJson, readPersona, readTools, scanSkills,
  writeAtomic, writePersona, writeShifts,
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
  for (const id of Object.keys(cfg.bots ?? {})) {
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

const botIds = () => Object.keys(cfg.bots ?? {});
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

async function control(req, url, send) {
  const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // after /api/control
  const [area, id, file, sub, version] = parts;
  const write = req.method !== 'GET';
  if (write && !req.headers['x-requested-with']) return send(403, { error: 'missing X-Requested-With' });
  const skills = () => scanSkills(SKILL_DIRS);

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
