// #3963: the room's memory. One SQLite file (node:sqlite, no npm deps) that
// the summoner writes as things happen and the insights dashboard reads.
//
// What gets recorded, and by whom:
//   - summoner (it already sits in the server 24/7 on an invisible query login):
//       chat       every channel/server text message it can see
//       voice      presence sessions per person per channel, from the room poll,
//                  with talk time sampled off client_flag_talking (approximate:
//                  one poll every pollSec, so short bursts can fall between)
//       joins      server connects/disconnects (notifycliententerview/leftview)
//       heard      what the bots' STT transcribed (POST /heard), so voice has
//                  words too, but only while some bot is in the channel
//       bot_events shift starts/ends, summons, dismissals, scenes, banter...
//   - insights-web (ingests on a timer):
//       bot_turns  every turn out of the gateway's transcripts: who asked, on
//                  which lane, what tools ran, whether the bot answered
//
// Every write is wrapped: a broken disk or a locked file logs and moves on, it
// never takes the summoner (and so the shifts) down with it.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, nick TEXT, uid TEXT, target TEXT,
  text TEXT, is_bot INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL DEFAULT 'live');
CREATE INDEX IF NOT EXISTS chat_ts ON chat(ts);
CREATE TABLE IF NOT EXISTS voice (
  id INTEGER PRIMARY KEY, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  dbid TEXT, uid TEXT, nick TEXT, cid TEXT, channel TEXT,
  talk_s INTEGER NOT NULL DEFAULT 0, away_s INTEGER NOT NULL DEFAULT 0,
  is_bot INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS voice_start ON voice(start_ts);
CREATE INDEX IF NOT EXISTS voice_end ON voice(end_ts);
CREATE TABLE IF NOT EXISTS joins (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT, dbid TEXT, uid TEXT,
  nick TEXT, reason TEXT, is_bot INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS joins_ts ON joins(ts);
CREATE TABLE IF NOT EXISTS heard (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, nick TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS heard_ts ON heard(ts);
CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bot TEXT, kind TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS bot_events_ts ON bot_events(ts);
CREATE TABLE IF NOT EXISTS bot_turns (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE, ts INTEGER NOT NULL, bot TEXT, session TEXT,
  lane TEXT, nick TEXT, prompt TEXT, reply TEXT, replied INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '[]', cost REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS bot_turns_ts ON bot_turns(ts);
CREATE INDEX IF NOT EXISTS bot_turns_session ON bot_turns(bot, session, ts);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  // On a brand-new file the summoner and insights-web both initialise it at
  // boot. SQLite answers some of those collisions with an instant "database is
  // locked" that busy_timeout never waits out (the WAL switch, a read lock
  // upgrading to write), so: schema under BEGIN IMMEDIATE, which does wait,
  // and a short retry around the lot.
  for (let i = 0; ; i++) {
    try {
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      return db;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (i >= 50 || !/locked|busy/i.test(e.message)) { db.close(); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export const getMeta = (db, k, d = null) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? d;
export const setMeta = (db, k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

/**
 * The summoner's side. `botNicks`: lowercased nicks of our own bots, so they
 * are tagged (and left out of the people charts) rather than dropped.
 */
export class Recorder {
  constructor(path, { botNicks = new Set(), log = console.log, now = Date.now } = {}) {
    this.log = log;
    this.now = now;
    this.botNicks = botNicks;
    this.open = new Map(); // clid -> { id, cid, lastSeen }
    this.nickByClid = new Map(); // for leftview, which carries no nick
    this.channels = new Map(); // cid -> name
    this.lastHeard = new Map(); // nick|text -> ts; several bots forward one utterance
    this.path = path;
    this.retryAt = 0;
    this.attach();
  }

  /**
   * Open the db. A failure turns recording off rather than taking the
   * summoner down, and ready() tries again a minute later, so a transient
   * lock at boot doesn't silence the recorder until the next restart.
   */
  attach() {
    try {
      this.db = openDb(this.path);
      // Sessions left open by a crash or restart end where they were last seen.
      this.db.prepare('UPDATE voice SET open=0 WHERE open=1').run();
      this.st = {
        chat: this.db.prepare('INSERT INTO chat(ts,nick,uid,target,text,is_bot) VALUES(?,?,?,?,?,?)'),
        vOpen: this.db.prepare('INSERT INTO voice(start_ts,end_ts,dbid,uid,nick,cid,channel,is_bot) VALUES(?,?,?,?,?,?,?,?)'),
        vTick: this.db.prepare('UPDATE voice SET end_ts=?, talk_s=talk_s+?, away_s=away_s+?, nick=? WHERE id=?'),
        vClose: this.db.prepare('UPDATE voice SET open=0 WHERE id=?'),
        join: this.db.prepare('INSERT INTO joins(ts,kind,dbid,uid,nick,reason,is_bot) VALUES(?,?,?,?,?,?,?)'),
        heard: this.db.prepare('INSERT INTO heard(ts,nick,text) VALUES(?,?,?)'),
        botEvent: this.db.prepare('INSERT INTO bot_events(ts,bot,kind,detail) VALUES(?,?,?,?)'),
      };
    } catch (e) {
      this.db = null;
      this.retryAt = this.now() + 60_000;
      if (e.message !== this.lastError) this.log('insights: recorder off (retrying every minute):', e.message);
      this.lastError = e.message;
    }
  }

  ready() {
    if (!this.db && this.now() >= this.retryAt) this.attach();
    return !!this.db;
  }

  safe(what, fn) {
    if (!this.ready()) return;
    try { fn(); } catch (e) { this.log(`insights: ${what}:`, e.message); }
  }

  isBot(nick) { return this.botNicks.has(String(nick || '').toLowerCase()); }

  /** notifytextmessage. targetmode 2 = channel, 3 = server; 1 (private) never reaches a query that isn't a party to it. */
  chat({ nick, uid, targetmode, text }) {
    const msg = String(text || '').trim();
    if (!nick || !msg) return;
    const target = targetmode === '3' ? 'server' : targetmode === '1' ? 'private' : 'channel';
    this.safe('chat', () => this.st.chat.run(this.now(), nick, uid || null, target, msg, this.isBot(nick) ? 1 : 0));
  }

  setChannels(rows) {
    for (const c of rows) if (c.cid) this.channels.set(String(c.cid), c.channel_name || `#${c.cid}`);
  }

  /**
   * One room poll (`clientlist -uid -away -voice`). Opens a session per client
   * per channel, extends it each poll, closes it when they leave or move.
   * Query clients (client_type 1) are not people.
   */
  poll(clients, pollSec) {
    if (!this.ready()) return;
    const now = this.now();
    const seen = new Set();
    this.safe('poll', () => {
      this.db.exec('BEGIN');
      try {
        for (const c of clients) {
          if (c.client_type !== '0' || !c.clid) continue;
          seen.add(c.clid);
          this.nickByClid.set(c.clid, { nick: c.client_nickname, dbid: c.client_database_id, uid: c.client_unique_identifier });
          let s = this.open.get(c.clid);
          if (s && s.cid !== c.cid) { this.st.vClose.run(s.id); s = null; }
          if (!s) {
            const r = this.st.vOpen.run(now, now, c.client_database_id ?? null, c.client_unique_identifier ?? null,
              c.client_nickname, c.cid, this.channels.get(c.cid) ?? null, this.isBot(c.client_nickname) ? 1 : 0);
            s = { id: Number(r.lastInsertRowid), cid: c.cid, lastSeen: now };
            this.open.set(c.clid, s);
            continue;
          }
          // Credit the time since the last poll, capped so a stalled query
          // doesn't hand everyone a free hour.
          const dt = Math.min(Math.round((now - s.lastSeen) / 1000), pollSec * 3);
          const talk = c.client_flag_talking === '1' ? Math.min(dt, pollSec) : 0;
          const away = c.client_away === '1' ? dt : 0;
          this.st.vTick.run(now, talk, away, c.client_nickname, s.id);
          s.lastSeen = now;
        }
        for (const [clid, s] of this.open) {
          if (seen.has(clid)) continue;
          this.st.vClose.run(s.id);
          this.open.delete(clid);
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    });
  }

  /** The query died: nobody's session can be extended until it's back. */
  queryDown() {
    this.safe('queryDown', () => {
      for (const s of this.open.values()) this.st.vClose.run(s.id);
      this.open.clear();
    });
  }

  /** notifycliententerview / notifyclientleftview (servernotifyregister event=server). */
  notify(kind, p) {
    if (kind === 'notifycliententerview') {
      if (p.client_type !== '0') return;
      this.nickByClid.set(p.clid, { nick: p.client_nickname, dbid: p.client_database_id, uid: p.client_unique_identifier });
      this.safe('join', () => this.st.join.run(this.now(), 'join', p.client_database_id ?? null, p.client_unique_identifier ?? null,
        p.client_nickname, null, this.isBot(p.client_nickname) ? 1 : 0));
    } else if (kind === 'notifyclientleftview') {
      const who = this.nickByClid.get(p.clid);
      if (!who) return; // a query client, or someone who left before our first poll
      this.nickByClid.delete(p.clid);
      this.safe('leave', () => this.st.join.run(this.now(), 'leave', who.dbid ?? null, who.uid ?? null, who.nick,
        p.reasonmsg || null, this.isBot(who.nick) ? 1 : 0));
    }
  }

  /** A transcript one of the bots heard. Several bots in the room forward the same one. */
  heard(nick, text) {
    const t = String(text || '').trim();
    if (!nick || !t || this.isBot(nick)) return;
    const now = this.now(), key = `${nick}|${t}`;
    if (now - (this.lastHeard.get(key) ?? 0) < 30_000) return;
    this.lastHeard.set(key, now);
    if (this.lastHeard.size > 500) for (const [k, ts] of this.lastHeard) if (now - ts > 30_000) this.lastHeard.delete(k);
    this.safe('heard', () => this.st.heard.run(now, nick, t));
  }

  botEvent(bot, kind, detail = null) {
    this.safe('botEvent', () => this.st.botEvent.run(this.now(), bot ?? null, kind, detail == null ? null : String(detail).slice(0, 300)));
  }
}

// ------------------------------------------------- gateway transcripts --
// Parsing is pure so it can be tested without a gateway. The prompt prefix is
// the teamspeak plugin's: "[teamspeak voice · Sun 11:42 AM ET] kyle said: ...",
// "[teamspeak channel] kyle wrote: ...", "[teamspeak private message] ...".

const PREFIX = /^\[teamspeak (voice|channel|private message)[^\]]*\]\s*(.*?)\s+(?:said|wrote):\s*([\s\S]*)$/;

export function parsePrompt(content, senderName) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '';
  const m = PREFIX.exec(text);
  if (m) {
    const lane = m[1] === 'channel' ? 'chat' : m[1] === 'private message' ? 'dm' : 'voice';
    return { lane, nick: senderName || m[2], text: m[3].trim() };
  }
  if (/^\[cron:/.test(text)) return { lane: 'cron', nick: null, text };
  return { lane: 'other', nick: senderName || null, text };
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');

/**
 * Folds transcript_events rows ({ rowid, session_id, seq, event_json }) into
 * turn operations: a user message opens a turn; assistant text and tool results
 * that follow add to the latest turn of that session.
 */
export function turnOps(rows) {
  const ops = [];
  for (const r of rows) {
    let ev;
    try { ev = JSON.parse(r.event_json); } catch { continue; }
    if (ev?.type !== 'message' || !ev.message) continue;
    const m = ev.message;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(ev.timestamp) || Number(r.created_at) || 0;
    if (m.role === 'user') {
      const p = parsePrompt(m.content, m.__openclaw?.senderName);
      ops.push({ op: 'turn', key: ev.id || `${r.session_id}:${r.seq}`, session: r.session_id, ts, ...p });
    } else if (m.role === 'assistant') {
      const t = textOf(m.content).trim();
      const cost = Number(m.usage?.cost?.total) || 0;
      ops.push({ op: 'reply', session: r.session_id, ts, text: t, said: Boolean(t) && !/^NO_REPLY\b/.test(t), cost });
    } else if (m.role === 'toolResult' && m.toolName) {
      ops.push({ op: 'tool', session: r.session_id, ts, tool: m.toolName });
    }
  }
  return ops;
}

export function applyTurnOps(db, bot, ops) {
  const ins = db.prepare('INSERT OR IGNORE INTO bot_turns(key,ts,bot,session,lane,nick,prompt) VALUES(?,?,?,?,?,?,?)');
  const latest = db.prepare('SELECT id, reply, tools FROM bot_turns WHERE bot=? AND session=? AND ts<=? ORDER BY ts DESC, id DESC LIMIT 1');
  const upd = db.prepare('UPDATE bot_turns SET reply=?, replied=MAX(replied,?), tools=?, cost=cost+? WHERE id=?');
  let turns = 0;
  db.exec('BEGIN');
  try {
    for (const o of ops) {
      if (o.op === 'turn') {
        turns += Number(ins.run(o.key, o.ts, bot, o.session, o.lane, o.nick, String(o.text).slice(0, 2000)).changes);
        continue;
      }
      const t = latest.get(bot, o.session, o.ts);
      if (!t) continue;
      if (o.op === 'reply') {
        const reply = o.said ? [t.reply, o.text].filter(Boolean).join('\n').slice(0, 2000) : t.reply;
        upd.run(reply ?? null, o.said ? 1 : 0, t.tools, o.cost, t.id);
      } else {
        const tools = JSON.parse(t.tools);
        tools.push(o.tool);
        upd.run(t.reply ?? null, 0, JSON.stringify(tools), 0, t.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return turns;
}

// ---------------------------------------------------- room-log backfill --
// The cores have written `HH:MM  nick: text` (UTC) into logs/<bot>/<channel>/
// <date>.md since 2026-09-19. Every bot logs the same channel, so lines are
// deduped on minute+nick+text.

export function parseRoomLog(date, body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = /^(\d\d):(\d\d)\s{2}([^:]+?):\s(.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${date}T${m[1]}:${m[2]}:00Z`);
    if (Number.isFinite(ts)) out.push({ ts, nick: m[3].trim(), text: m[4].trim() });
  }
  return out;
}
