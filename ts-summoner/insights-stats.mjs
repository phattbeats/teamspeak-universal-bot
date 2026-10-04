// PHA-3963: the dashboard's numbers, as plain functions over the insights db.
// Data is small (a few people, a few thousand rows a month), so the grouping
// that needs local time (hour of day, weekday, calendar day) is done in JS.

const H = 3_600_000;
const SLICE = 5 * 60_000; // presence is bucketed in 5-minute slices
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ts -> { dow (0 = Mon), hour, date 'YYYY-MM-DD' } in `tz`, cached per UTC hour. */
export function localClock(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const cache = new Map();
  return (ts) => {
    const k = Math.floor(ts / H);
    let v = cache.get(k);
    if (!v) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(k * H)).map((x) => [x.type, x.value]));
      v = { dow: WEEKDAYS.indexOf(p.weekday), hour: Number(p.hour) % 24, date: `${p.year}-${p.month}-${p.day}` };
      cache.set(k, v);
      if (cache.size > 20_000) cache.clear();
    }
    return v;
  };
}

const grid = () => Array.from({ length: 7 }, () => Array(24).fill(0));

// `hide(nick)`: bots and test logins that aren't people (the log still shows them).
const none = () => false;

/** Voice sessions overlapping [from, to), clipped to it. */
function sessions(db, from, to, bots = false) {
  return db.prepare(`SELECT start_ts, end_ts, dbid, uid, nick, channel, talk_s, away_s, open FROM voice
    WHERE end_ts >= ? AND start_ts < ? AND is_bot = ?`).all(from, to, bots ? 1 : 0)
    .map((s) => ({ ...s, a: Math.max(s.start_ts, from), b: Math.min(s.end_ts, to) }))
    .filter((s) => s.b > s.a || s.open);
}

// One person, many nicks: voice and joins know the unique id; chat backfilled
// from room logs only knows the nick. The newest nick names the person.
function identities(db) {
  const byNick = new Map(), name = new Map();
  for (const r of db.prepare(`SELECT nick, uid, MAX(t) t FROM (
      SELECT nick, uid, end_ts t FROM voice WHERE uid IS NOT NULL
      UNION ALL SELECT nick, uid, ts FROM joins WHERE uid IS NOT NULL
      UNION ALL SELECT nick, uid, ts FROM chat WHERE uid IS NOT NULL)
    GROUP BY nick, uid ORDER BY t`).all()) {
    byNick.set(r.nick, r.uid);
    name.set(r.uid, r.nick);
  }
  const key = (nick, uid) => uid || byNick.get(nick) || `nick:${nick}`;
  const label = (k) => (k.startsWith('nick:') ? k.slice(5) : name.get(k) || k);
  return { key, label };
}

export function overview(db, { from, to, tz, now = Date.now(), hide = none }) {
  const clock = localClock(tz);
  const id = identities(db);
  const heat = { voice: grid(), chat: grid() };
  const days = new Map();
  const day = (ts) => {
    const d = clock(ts).date;
    let v = days.get(d);
    if (!v) days.set(d, (v = { date: d, voiceH: 0, chat: 0, people: new Set() }));
    return v;
  };
  const people = new Set();
  let voiceS = 0, talkS = 0;
  for (const s of sessions(db, from, to)) {
    if (hide(s.nick)) continue;
    const who = id.key(s.nick, s.uid);
    people.add(who);
    voiceS += (s.b - s.a) / 1000;
    talkS += s.talk_s * Math.min(1, (s.b - s.a) / Math.max(1, s.end_ts - s.start_ts));
    for (let t = s.a; t < s.b; t += SLICE) {
      const len = Math.min(SLICE, s.b - t);
      const c = clock(t);
      heat.voice[c.dow][c.hour] += len / 60_000;
      const d = day(t);
      d.voiceH += len / H;
      d.people.add(who);
    }
  }
  const chats = db.prepare('SELECT ts, nick, uid FROM chat WHERE ts >= ? AND ts < ? AND is_bot = 0').all(from, to)
    .filter((m) => !hide(m.nick));
  for (const m of chats) {
    const c = clock(m.ts);
    heat.chat[c.dow][c.hour] += 1;
    const d = day(m.ts);
    d.chat += 1;
    const who = id.key(m.nick, m.uid);
    d.people.add(who);
    people.add(who);
  }
  const one = (sql) => db.prepare(sql).get(from, to);
  const heard = one('SELECT COUNT(*) n FROM heard WHERE ts >= ? AND ts < ?').n;
  const turns = one('SELECT COUNT(*) n, COALESCE(SUM(replied),0) replied, COALESCE(SUM(cost),0) cost FROM bot_turns WHERE ts >= ? AND ts < ?');
  // Busiest hour across the week: voice person-minutes, chat as tiebreak.
  let peak = null;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const v = heat.voice[d][h] + heat.chat[d][h];
    if (v > 0 && (!peak || v > peak.v)) peak = { dow: WEEKDAYS[d], hour: h, v };
  }
  const online = db.prepare('SELECT nick, channel, start_ts FROM voice WHERE open = 1 AND is_bot = 0 AND end_ts > ? ORDER BY start_ts')
    .all(now - 5 * 60_000).filter((s) => !hide(s.nick));
  const span = db.prepare(`SELECT MIN(t) first FROM (SELECT MIN(start_ts) t FROM voice UNION ALL SELECT MIN(ts) FROM chat
    UNION ALL SELECT MIN(ts) FROM bot_turns)`).get();
  return {
    tiles: {
      people: people.size, voiceHours: voiceS / 3600, talkHours: talkS / 3600, chat: chats.length, heard,
      botTurns: turns.n, botReplies: turns.replied, botCost: turns.cost, peak,
    },
    online,
    heat,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, people: d.people.size })),
    firstData: span.first,
  };
}

export function people(db, { from, to, hide = none }) {
  const id = identities(db);
  const map = new Map();
  const skip = { voiceS: 0, talkS: 0, awayS: 0, sessions: 0, chat: 0, heard: 0, botTurns: 0, lastSeen: 0 };
  const row = (nick, uid) => {
    if (hide(nick)) return { ...skip };
    const k = id.key(nick, uid);
    let r = map.get(k);
    if (!r) map.set(k, (r = { name: id.label(k), voiceS: 0, talkS: 0, awayS: 0, sessions: 0, chat: 0, heard: 0, botTurns: 0, lastSeen: 0 }));
    return r;
  };
  for (const s of sessions(db, from, to)) {
    const r = row(s.nick, s.uid);
    const f = Math.min(1, (s.b - s.a) / Math.max(1, s.end_ts - s.start_ts));
    r.voiceS += (s.b - s.a) / 1000;
    r.talkS += s.talk_s * f;
    r.awayS += s.away_s * f;
    r.sessions += 1;
    r.lastSeen = Math.max(r.lastSeen, s.b);
  }
  for (const m of db.prepare('SELECT ts, nick, uid FROM chat WHERE ts >= ? AND ts < ? AND is_bot = 0').all(from, to)) {
    const r = row(m.nick, m.uid);
    r.chat += 1;
    r.lastSeen = Math.max(r.lastSeen, m.ts);
  }
  for (const h of db.prepare('SELECT nick, COUNT(*) n, MAX(ts) t FROM heard WHERE ts >= ? AND ts < ? GROUP BY nick').all(from, to)) {
    const r = row(h.nick, null);
    r.heard += h.n;
    r.lastSeen = Math.max(r.lastSeen, h.t);
  }
  for (const t of db.prepare(`SELECT nick, COUNT(*) n, MAX(ts) t FROM bot_turns WHERE ts >= ? AND ts < ? AND nick IS NOT NULL
      AND lane IN ('voice','chat','dm') GROUP BY nick`).all(from, to)) {
    const r = row(t.nick, null);
    r.botTurns += t.n;
    r.lastSeen = Math.max(r.lastSeen, t.t);
  }
  return [...map.values()].sort((a, b) => b.voiceS - a.voiceS || b.chat - a.chat);
}

const top = (counts, n = 8) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

/**
 * What gets people going. Two lenses:
 *  - turns: what people ask the bots for (the tools a turn ran, or plain talk),
 *    how often the bot answered, and how often the same person came back to
 *    that bot within `followMin` (a conversation, not a one-off);
 *  - events: things the bots start on their own (entrances, scenes, banter,
 *    summons...) and how much human chat + speech followed in the next
 *    `windowMin`, against the same window before.
 */
export function bots(db, { from, to, followMin = 5, windowMin = 10, hide = none }) {
  const turns = db.prepare(`SELECT ts, bot, session, lane, nick, replied, tools, cost FROM bot_turns
    WHERE ts >= ? AND ts < ? ORDER BY ts`).all(from, to);
  const per = {}, kinds = {};
  const human = turns.filter((t) => ['voice', 'chat', 'dm'].includes(t.lane) && t.nick && !hide(t.nick));
  for (const [i, t] of human.entries()) {
    const b = (per[t.bot] ??= { bot: t.bot, turns: 0, replied: 0, cost: 0, lanes: {}, askers: {}, tools: {} });
    b.turns += 1;
    b.replied += t.replied;
    b.cost += t.cost;
    b.lanes[t.lane] = (b.lanes[t.lane] ?? 0) + 1;
    b.askers[t.nick] = (b.askers[t.nick] ?? 0) + 1;
    const tools = JSON.parse(t.tools);
    for (const x of tools) b.tools[x] = (b.tools[x] ?? 0) + 1;
    const kind = tools[0] ?? `talk (${t.lane})`;
    const k = (kinds[kind] ??= { kind, turns: 0, replied: 0, cameBack: 0 });
    k.turns += 1;
    k.replied += t.replied;
    for (let j = i + 1; j < human.length && human[j].ts - t.ts <= followMin * 60_000; j++) {
      if (human[j].bot === t.bot && human[j].nick === t.nick) { k.cameBack += 1; break; }
    }
  }
  const W = windowMin * 60_000;
  const activity = db.prepare(`SELECT (SELECT COUNT(*) FROM chat WHERE is_bot = 0 AND ts >= ? AND ts < ?)
    + (SELECT COUNT(*) FROM heard WHERE ts >= ? AND ts < ?) n`);
  const act = (a, b) => activity.get(a, b, a, b).n;
  const evs = {};
  for (const e of db.prepare(`SELECT ts, bot, kind FROM bot_events WHERE ts >= ? AND ts < ?
      AND kind NOT IN ('core_start','core_stop')`).all(from, to)) {
    const x = (evs[e.kind] ??= { kind: e.kind, n: 0, before: 0, after: 0, answered: 0 });
    const after = act(e.ts, e.ts + W);
    x.n += 1;
    x.before += act(e.ts - W, e.ts);
    x.after += after;
    if (after > 0) x.answered += 1;
  }
  return {
    bots: Object.values(per).map((b) => ({ ...b, askers: top(b.askers), tools: top(b.tools) })).sort((a, b) => b.turns - a.turns),
    asks: Object.values(kinds).sort((a, b) => b.turns - a.turns),
    events: Object.values(evs).map((x) => ({
      kind: x.kind, n: x.n, avgBefore: x.before / x.n, avgAfter: x.after / x.n, answeredPct: (100 * x.answered) / x.n,
    })).sort((a, b) => b.n - a.n),
    windowMin, followMin,
  };
}

const LOG_SOURCES = {
  chat: `SELECT 'chat' t, ts, nick, text, target a, NULL b FROM chat`,
  heard: `SELECT 'heard' t, ts, nick, text, NULL a, NULL b FROM heard`,
  turn: `SELECT 'turn' t, ts, nick, prompt text, bot a, json_object('lane', lane, 'replied', replied, 'reply', reply, 'tools', json(tools)) b FROM bot_turns`,
  join: `SELECT 'join' t, ts, nick, kind text, reason a, NULL b FROM joins WHERE is_bot = 0`,
  voice: `SELECT 'voice' t, start_ts ts, nick, channel text, CAST((end_ts - start_ts) / 1000 AS INTEGER) a, talk_s b FROM voice WHERE is_bot = 0`,
  bot: `SELECT 'bot' t, ts, bot nick, kind text, detail a, NULL b FROM bot_events`,
};

/** The everything-log, newest first, one page at a time (`before` = the last ts you got). */
export function logPage(db, { types = Object.keys(LOG_SOURCES), q = '', nick = '', before = Number.MAX_SAFE_INTEGER, after = 0, limit = 200 }) {
  const parts = types.filter((t) => LOG_SOURCES[t]).map((t) => LOG_SOURCES[t]);
  if (!parts.length) return [];
  const sql = `SELECT * FROM (${parts.join(' UNION ALL ')}) WHERE ts < ? AND ts >= ?
    AND (? = '' OR nick LIKE ? ESCAPE '\\') AND (? = '' OR text LIKE ? ESCAPE '\\' OR a LIKE ? ESCAPE '\\')
    ORDER BY ts DESC LIMIT ?`;
  const like = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(sql).all(before, after, nick, like(nick), q, like(q), like(q), Math.min(limit, 1000));
}
