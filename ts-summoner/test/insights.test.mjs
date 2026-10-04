import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTurnOps, openDb, parsePrompt, parseRoomLog, Recorder, turnOps } from '../insights.mjs';
import { bots, localClock, logPage, overview, people } from '../insights-stats.mjs';

const T0 = Date.parse('2026-10-05T00:00:00Z'); // Sun 20:00 in New York
const MIN = 60_000;
const quiet = () => {};

function recorder() {
  let now = T0;
  const r = new Recorder(':memory:', { botNicks: new Set(['sexton']), log: quiet, now: () => now });
  return { r, at: (t) => { now = t; } };
}
const client = (clid, nick, cid, x = {}) => ({
  clid, cid, client_type: '0', client_nickname: nick, client_database_id: clid, client_unique_identifier: `uid-${nick}`,
  client_flag_talking: '0', client_away: '0', ...x,
});

test('room polls become one voice session per person per channel', () => {
  const { r, at } = recorder();
  const poll = (t, cs) => { at(t); r.poll(cs, 10); };
  poll(T0, [client('5', 'kyle', '1'), { clid: '9', client_type: '1', client_nickname: 'serveradmin' }]);
  poll(T0 + 10_000, [client('5', 'kyle', '1', { client_flag_talking: '1' })]);
  poll(T0 + 20_000, [client('5', 'kyle', '1', { client_away: '1' })]);
  poll(T0 + 30_000, [client('5', 'kyle', '7')]); // moved channels
  poll(T0 + 40_000, []); // left
  const rows = r.db.prepare('SELECT nick, cid, start_ts, end_ts, talk_s, away_s, open FROM voice ORDER BY id').all();
  assert.equal(rows.length, 2, 'query clients are not people');
  assert.deepEqual({ ...rows[0] }, { nick: 'kyle', cid: '1', start_ts: T0, end_ts: T0 + 20_000, talk_s: 10, away_s: 10, open: 0 });
  assert.equal(rows[1].cid, '7');
  assert.equal(rows[1].open, 0);
});

test('a stalled poll does not hand out free hours', () => {
  const { r, at } = recorder();
  at(T0); r.poll([client('5', 'kyle', '1')], 10);
  at(T0 + 3_600_000); r.poll([client('5', 'kyle', '1')], 10);
  const { end_ts: e, start_ts: s, talk_s: t } = r.db.prepare('SELECT * FROM voice').get();
  assert.equal(e - s, 3_600_000, 'the session still spans the gap');
  assert.equal(t, 0);
});

test('chat, joins, heard and bot events are recorded; bots are tagged; heard is deduped', () => {
  const { r, at } = recorder();
  r.chat({ nick: 'kyle', uid: 'u1', targetmode: '2', text: ' sexton play aja ' });
  r.chat({ nick: 'Sexton', targetmode: '2', text: 'Playing.' });
  r.chat({ nick: 'kyle', targetmode: '3', text: '' }); // empty: dropped
  r.notify('notifycliententerview', { clid: '5', client_type: '0', client_nickname: 'kyle', client_unique_identifier: 'u1' });
  r.notify('notifyclientleftview', { clid: '5', reasonmsg: 'bye' });
  r.notify('notifyclientleftview', { clid: '99' }); // never seen: ignored
  r.heard('kyle', 'hello there');
  r.heard('kyle', 'hello there'); // a second bot forwarding the same line
  at(T0 + 31_000); r.heard('kyle', 'hello there');
  r.heard('Sexton', 'bots hear each other');
  r.botEvent('sexton', 'entrance', 'shift_start');
  const chat = r.db.prepare('SELECT nick, text, target, is_bot FROM chat ORDER BY id').all().map((x) => ({ ...x }));
  assert.deepEqual(chat, [
    { nick: 'kyle', text: 'sexton play aja', target: 'channel', is_bot: 0 },
    { nick: 'Sexton', text: 'Playing.', target: 'channel', is_bot: 1 },
  ]);
  assert.deepEqual(r.db.prepare('SELECT kind, nick, reason FROM joins ORDER BY id').all().map((x) => ({ ...x })),
    [{ kind: 'join', nick: 'kyle', reason: null }, { kind: 'leave', nick: 'kyle', reason: 'bye' }]);
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM heard').get().n, 2);
  assert.equal(r.db.prepare('SELECT kind FROM bot_events').get().kind, 'entrance');
});

test('a recorder that cannot open its db stays out of the way', () => {
  const r = new Recorder('/dev/null/nope/insights.db', { log: quiet });
  assert.equal(r.db, null);
  r.chat({ nick: 'a', text: 'b' });
  r.poll([client('1', 'a', '1')], 10);
  r.botEvent('x', 'y');
});

test('prompts: lane, nick and text come off the plugin prefix', () => {
  assert.deepEqual(parsePrompt('[teamspeak voice · Sun 11:42 AM ET] kyleonrye said: which is in the first', 'kyleonrye'),
    { lane: 'voice', nick: 'kyleonrye', text: 'which is in the first' });
  assert.deepEqual(parsePrompt('[teamspeak channel] ty-c wrote: sexton play x'), { lane: 'chat', nick: 'ty-c', text: 'sexton play x' });
  assert.equal(parsePrompt('[teamspeak private message] therealphaTT wrote: hi').lane, 'dm');
  assert.equal(parsePrompt('[teamspeak voice · follow-up, name not said · Sun 1:00 PM ET] a b said: more').nick, 'a b');
  assert.equal(parsePrompt('[cron:abc] do the thing').lane, 'cron');
  assert.equal(parsePrompt([{ type: 'text', text: '[teamspeak channel] x wrote: y' }]).text, 'y');
});

const ev = (id, session, seq, message) => ({ rowid: seq, session_id: session, seq, created_at: T0 + seq, event_json: JSON.stringify({ type: 'message', id, timestamp: new Date(T0 + seq * 1000).toISOString(), message: { timestamp: T0 + seq * 1000, ...message } }) });

test('transcripts fold into turns: tools, replies, NO_REPLY, cost, re-ingest is idempotent', () => {
  const db = openDb(':memory:');
  const rows = [
    ev('u1', 's', 1, { role: 'user', content: '[teamspeak channel] kyle wrote: sexton play aja', __openclaw: { senderName: 'kyle' } }),
    ev('a1', 's', 2, { role: 'assistant', content: [{ type: 'toolCall' }], usage: { cost: { total: 0.1 } } }),
    ev('t1', 's', 3, { role: 'toolResult', toolName: 'play_music', content: [] }),
    ev('a2', 's', 4, { role: 'assistant', content: [{ type: 'text', text: 'Aja, coming up.' }], usage: { cost: { total: 0.05 } } }),
    ev('u2', 's', 5, { role: 'user', content: '[teamspeak voice] bob said: anyway' }),
    ev('a3', 's', 6, { role: 'assistant', content: [{ type: 'text', text: 'NO_REPLY' }] }),
    { rowid: 7, session_id: 's', seq: 7, created_at: 0, event_json: '{"type":"custom"}' },
  ];
  assert.equal(applyTurnOps(db, 'sexton', turnOps(rows)), 2);
  assert.equal(applyTurnOps(db, 'sexton', turnOps(rows.slice(0, 1))), 0, 'same user event twice is one turn');
  const t = db.prepare('SELECT lane, nick, prompt, reply, replied, tools, cost FROM bot_turns ORDER BY ts').all().map((x) => ({ ...x }));
  assert.deepEqual(t[0], { lane: 'chat', nick: 'kyle', prompt: 'sexton play aja', reply: 'Aja, coming up.', replied: 1, tools: '["play_music"]', cost: 0.15000000000000002 });
  assert.deepEqual(t[1], { lane: 'voice', nick: 'bob', prompt: 'anyway', reply: null, replied: 0, tools: '[]', cost: 0 });
});

test('room logs parse as UTC minutes', () => {
  const rows = parseRoomLog('2026-10-03', '05:49  kyleonrye: sexton play x\nnot a line\n21:42  a: b: c\n');
  assert.deepEqual(rows, [
    { ts: Date.parse('2026-10-03T05:49:00Z'), nick: 'kyleonrye', text: 'sexton play x' },
    { ts: Date.parse('2026-10-03T21:42:00Z'), nick: 'a', text: 'b: c' },
  ]);
});

test('local clock follows the server time zone across DST', () => {
  const c = localClock('America/New_York');
  assert.deepEqual(c(T0), { dow: 6, hour: 20, date: '2026-10-04' });
  assert.equal(c(Date.parse('2026-12-01T12:00:00Z')).hour, 7);
});

function seeded() {
  const db = openDb(':memory:');
  const v = db.prepare('INSERT INTO voice(start_ts,end_ts,uid,nick,cid,channel,talk_s,is_bot,open) VALUES(?,?,?,?,?,?,?,?,0)');
  v.run(T0, T0 + 60 * MIN, 'u1', 'kyle', '1', 'General Shit', 600, 0);
  v.run(T0 + 30 * MIN, T0 + 45 * MIN, 'u2', 'ty', '1', 'General Shit', 60, 0);
  v.run(T0, T0 + 60 * MIN, null, 'Sexton', '1', 'General Shit', 0, 1);
  const c = db.prepare('INSERT INTO chat(ts,nick,uid,target,text,is_bot) VALUES(?,?,?,?,?,?)');
  c.run(T0 + MIN, 'kyle', 'u1', 'channel', 'sexton play aja', 0);
  c.run(T0 + 2 * MIN, 'kyle', null, 'channel', 'skip', 0);
  c.run(T0 + 3 * MIN, 'Sexton', null, 'channel', 'Playing.', 1);
  db.prepare('INSERT INTO heard(ts,nick,text) VALUES(?,?,?)').run(T0 + 21 * MIN, 'ty', 'nice one');
  const t = db.prepare('INSERT INTO bot_turns(key,ts,bot,session,lane,nick,prompt,replied,tools,cost) VALUES(?,?,?,?,?,?,?,?,?,?)');
  t.run('k1', T0 + MIN, 'sexton', 's', 'chat', 'kyle', 'play aja', 1, '["play_music"]', 0.1);
  t.run('k2', T0 + 3 * MIN, 'sexton', 's', 'chat', 'kyle', 'skip', 1, '["skip"]', 0.1);
  t.run('k3', T0 + 30 * MIN, 'sexton', 's', 'voice', 'ty', 'hey', 0, '[]', 0.2);
  db.prepare('INSERT INTO bot_events(ts,bot,kind,detail) VALUES(?,?,?,?)').run(T0 + 20 * MIN, null, 'banter', 'banter:bexton+sexton');
  return db;
}
const R = { from: T0 - 86_400_000, to: T0 + 86_400_000, tz: 'America/New_York', now: T0 + 2 * 3_600_000 };

test('overview: totals, heatmap in local time, bots excluded', () => {
  const o = overview(seeded(), R);
  assert.equal(o.tiles.people, 2);
  assert.equal(o.tiles.voiceHours, 1.25);
  assert.equal(o.tiles.chat, 2);
  assert.equal(o.tiles.heard, 1);
  assert.equal(o.tiles.botTurns, 3);
  assert.equal(o.tiles.botReplies, 2);
  assert.equal(o.heat.voice[6][20], 75, 'Sun 8pm ET: 60 + 15 person-minutes');
  assert.equal(o.heat.chat[6][20], 2);
  assert.deepEqual(o.tiles.peak, { dow: 'Sun', hour: 20, v: 77 });
  assert.deepEqual(o.days.map((d) => d.date), ['2026-10-04']);
});

test('people: merged by unique id, sorted by voice time', () => {
  const p = people(seeded(), R);
  assert.deepEqual(p.map((x) => [x.name, Math.round(x.voiceS / 60), x.chat, x.heard, x.botTurns]), [
    ['kyle', 60, 2, 0, 2],
    ['ty', 15, 0, 1, 1],
  ]);
});

test('bots: asks by first tool, came-back rate, events against the window before', () => {
  const b = bots(seeded(), { ...R, botNicks: new Set(['sexton']) });
  assert.equal(b.bots[0].turns, 3);
  assert.equal(b.bots[0].replied, 2);
  const play = b.asks.find((a) => a.kind === 'play_music');
  assert.deepEqual({ ...play }, { kind: 'play_music', turns: 1, replied: 1, cameBack: 1 });
  assert.ok(b.asks.find((a) => a.kind === 'talk (voice)'));
  assert.deepEqual(b.events, [{ kind: 'banter', n: 1, avgBefore: 0, avgAfter: 1, answeredPct: 100 }]);
});

test('log: newest first, filters by type, person and text (LIKE is escaped)', () => {
  const db = seeded();
  const all = logPage(db, {});
  assert.ok(all.length >= 9);
  assert.ok(all.every((r, i) => i === 0 || all[i - 1].ts >= r.ts));
  assert.deepEqual(logPage(db, { types: ['chat'], nick: 'kyle' }).map((r) => r.text), ['skip', 'sexton play aja']);
  assert.equal(logPage(db, { q: 'aja' }).length, 2, 'chat line + bot turn');
  assert.equal(logPage(db, { q: '%' }).length, 0);
  assert.equal(logPage(db, { types: ['nope'] }).length, 0);
  const turn = logPage(db, { types: ['turn'] })[0];
  assert.equal(JSON.parse(turn.b).lane, 'voice');
});
