// #3963: the TeamSpeak insights dashboard. Its own supervisor program, so a
// bad query here can't stall the summoner's shifts; the summoner records, this
// reads (plus ingests the gateway's transcripts, which only it touches).
//
//   GET /                      the dashboard (insights/index.html)
//   GET /api/overview?days=N   tiles, weekday x hour heatmaps, per-day series
//   GET /api/people?days=N     per person: voice, talk, chat, heard, bot turns
//   GET /api/bots?days=N       per bot + what drives engagement
//   GET /api/log?types=&q=&nick=&before=&limit=   the everything-log
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

// ------------------------------------------------------------------ http --

function range(qs) {
  const now = Date.now();
  const days = qs.get('days');
  const from = days === 'all' ? 0 : now - Number(days || 30) * 86_400_000;
  return { from, to: now + 60_000, tz: TZ, now, hide };
}

http.createServer((req, res) => {
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
      default: return send(404, { error: 'not found' });
    }
  } catch (e) {
    log(`${url.pathname}: ${e.message}`);
    return send(500, { error: e.message });
  }
}).listen(PORT, () => log(`dashboard on :${PORT}, db ${DB_PATH}`));

try { backfillRoomLogs(); } catch (e) { log('backfill failed:', e.message); }
ingestAll();
setInterval(ingestAll, (ic.ingestSec ?? 60) * 1000);
prune();
setInterval(() => { try { prune(); } catch (e) { log('prune:', e.message); } }, 6 * 3_600_000);
