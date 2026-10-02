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
//
// PHA-3841 layered three things on top, all documented in
// docs/universal-bot/SCHEDULE-AND-EVENTS.md:
//   - a special-nights calendar (calendar.json) that bends shifts and picks
//     themed entrance/exit pools (Friday lounge, Halloween, birthdays...),
//   - two-bot scenes (scenes.json) at shift changes instead of lone lines,
//   - rare events: Lexton's hostile takeover (Sexton to Bot Jail for an hour)
//     and Bexton's two-day bender. Their state survives restarts (state dir).
//
// PHA-3839 (variety.mjs) loosened the clock: shifts start and end 0-45 min
// late, about one in ten is a call-out (another bot covers, or nobody does),
// and a bot stays while people are talking and leaves once the room goes quiet.
//
// PHA-3842 (guests.mjs) adds the guest-star slot: Rotten Johnny and Trixie
// share one `guest` container, and on Bexton nights the dice occasionally
// bring one of them in for a few minutes.
//
// No npm deps: `ssh` (+ sshpass) for the query, the Docker socket for exec.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import {
  flavorFor, forcedEvents, local, nextFlip as nextFlipBy, serviceDay, shiftAt, shiftsFor, tagged,
} from './schedule.mjs';
import { offCooldown, parseStep, pickScene, planScenes, takeoverEligible, tickChance } from './story.mjs';
import { calledOut, isLate, jitterFor, overtimeOk, pickCover, quietOut, varietyConfig } from './variety.mjs';
import {
  candidates as guestCandidates, guestConfig, guestIds, pickGuest, slotHolder, slotOpen, visitChance, visitLength,
} from './guests.mjs';
import { banterChance, banterConfig, banterKey, banterOpen, pickBanter } from './banter.mjs';

const CONFIG_PATH = process.env.SUMMONER_CONFIG || '/app/config.json';
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const QUERY_PASS = readFileSync(cfg.query.passFile, 'utf8').trim();
const BOT_NICKS = new Set(Object.values(cfg.bots).map((b) => b.nick.toLowerCase()));
// PHA-3842: guests never cover a shift and never break news; they only visit.
const GUESTS = new Set(guestIds(cfg));
const REGULARS = Object.keys(cfg.bots).filter((id) => !GUESTS.has(id));
const gc = guestConfig(cfg.guests);
const bc = banterConfig(cfg.banter);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MIN = 60_000;

// ------------------------------------------------- live-editable files --
// calendar.json and scenes.json are re-read when their mtime changes, so an
// edit on the box takes effect within one reconcile. A broken edit keeps the
// last good copy and logs why.

function liveJson(path, fallback) {
  let mtime = -1, value = fallback;
  return () => {
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) {
        value = JSON.parse(readFileSync(path, 'utf8'));
        mtime = m;
        log(`loaded ${path}`);
      }
    } catch (e) {
      if (mtime !== -2) log(`${path}: ${e.code === 'ENOENT' ? 'missing' : e.message}; keeping the last good copy`);
      mtime = -2;
    }
    return value;
  };
}
const calendar = liveJson(cfg.calendarFile ?? '/app/live/calendar.json', { entries: [] });
const scenes = liveJson(cfg.scenes?.file ?? '/app/live/scenes.json', {});

// ---------------------------------------------------------------- schedule --
// The rules live in schedule.mjs. A shift's `days` are the days it STARTS on;
// start > end crosses midnight; calendar entries bend both. PHA-3839 jitter
// moves every shift, so "on shift" everywhere below means the jittered one.

const vc = varietyConfig(cfg.variety);
const jit = (key) => jitterFor(vc, key);
const planned = (id, ts) => shiftAt(cfg, calendar(), id, ts, jit);
const onShift = (id, ts) => planned(id, ts) !== null;
const nextFlip = (id, ts, want) => nextFlipBy((t) => onShift(id, t), ts, want);

// ------------------------------------------------------------ event state --
// Persisted, so a takeover in progress or a bender survives a restart:
//   takeover: { lastAt, active: { startedAt, until, jailed, overthrown } | null }
//   bender:   { lastAt, active: { bot, from, until, newsSaid } | null, returning: <bot>|null }
//   forced:   { "<entryId>@<day>": true }  calendar-forced events already used
//   callouts: { "<shift key>": { bot, cover, at, until } }  PHA-3839, decided once per shift
//   guests:   { visits: [ts], active: { bot, from, until, why } | null }  PHA-3842
//   banter:   { plays: [{ day, at, key, dropIn }] }  PHA-3859

const STATE_FILE = cfg.stateFile ?? '/app/state/state.json';
const events = (() => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
})();
events.takeover ??= { lastAt: 0, active: null };
events.bender ??= { lastAt: 0, active: null, returning: null };
events.forced ??= {};
events.callouts ??= {};
events.guests ??= { visits: [], active: null };
events.banter ??= { plays: [] };
function saveEvents() {
  try {
    mkdirSync(STATE_FILE.replace(/\/[^/]*$/, ''), { recursive: true });
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(events, null, 2));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (e) {
    log('event state not saved:', e.message);
  }
}
const ev = cfg.events ?? {};

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
    exitReason: null, // 'dismiss' once dismissed, until the core is stopped
    working: false, // running while wanted; only a working bot says goodbye
    busy: false, // an exit line or a scene is playing; reconcile leaves this bot alone
    baseOn: null, // last tick's onShift(), to spot a shift start a bender swallowed
    plannedOn: null, // PHA-3839: last tick's onShift(), to time the overtime cap
    shiftEndedAt: null,
    onSince: Date.now(), // core last seen coming up; a fresh start gets the full quiet wait
    leftQuiet: null, // shift key this bot walked out of because the room went quiet
  };
}
const room = { humans: 0, lastHumanTalk: 0, lastHumanSeen: 0, lastChat: 0, queryUp: false, clients: [] };
const BOOT_AT = Date.now();

// A guest visit restored from disk keeps the guest in until it's over.
if (events.guests.active && state[events.guests.active.bot]) {
  const a = events.guests.active;
  state[a.bot].override = { mode: 'on', until: a.until, why: 'guest visit', visit: true };
}

// A takeover restored from disk puts the villain back on.
if (events.takeover.active && ev.takeover) {
  state[ev.takeover.villain].override = { mode: 'on', until: events.takeover.active.until, why: 'hostile takeover' };
}

const benderOn = (id, now) => {
  const b = events.bender.active;
  return Boolean(b && b.bot === id && now >= b.from && now < b.until);
};

// PHA-3839 S3: nobody has said anything (voice or chat) for a while, counting
// from when the bot came up or the shift began, whichever is later.
function roomQuiet(id, now, since) {
  const lastActivity = Math.max(room.lastHumanTalk, room.lastChat, state[id].onSince, BOOT_AT, since ?? 0);
  return quietOut(vc, { lastActivity, now, queryUp: room.queryUp });
}

function desired(id, now) {
  const st = state[id];
  const o = st.override;
  // PHA-3842: one guest container, one guest. Whoever holds it finishes first.
  if (GUESTS.has(id) && !st.running) {
    const holder = slotHolder(cfg, state, id);
    if (holder) return { on: false, why: `guest slot taken by ${holder}` };
  }
  if (o && now < o.until) {
    if (o.visit) return { on: true, why: o.why, visit: true };
    if (o.cover && roomQuiet(id, now, o.since)) return { on: false, why: 'room quiet', quiet: true };
    return { on: o.mode === 'on', why: o.why, cover: o.cover };
  }
  if (o) { log(`${id}: override '${o.why}' expired`); st.override = null; }
  if (benderOn(id, now)) return { on: false, why: 'on a bender' };
  const shift = planned(id, now);
  if (shift) {
    if (calledOut(vc, shift)) return { on: false, why: 'called out' };
    if (roomQuiet(id, now, shift.startTs)) return { on: false, why: 'room quiet', quiet: true };
    return { on: true, why: 'on shift', shift };
  }
  // Shift over: don't walk out mid-conversation. The query can see who is
  // talking (client_flag_talking), not what about, so any human voice counts.
  // Only for a bot we had on duty: a core that came back by itself (container
  // restart, supervisord autostart) off shift gets stopped, not held (PHA-3831).
  // PHA-3839 caps the overtime at an hour past the shift.
  const talking = now - room.lastHumanTalk < cfg.idleGraceMin * MIN;
  if (st.running && st.onDuty && overtimeOk(vc, { shiftEndedAt: st.shiftEndedAt, now, talking })) {
    return { on: true, why: 'shift over, waiting for the room to go quiet' };
  }
  return { on: false, why: 'off shift' };
}

// ------------------------------------------------------------- call-outs --
// PHA-3839 S2. Decided once, the first tick a called-out shift is live, and
// kept in the state file so a restart doesn't hand the shift to someone else.
// A cover is an 'on' override until the missed shift's end; nobody covering
// means whoever is in the room says he didn't show.

function calloutTick(now) {
  const ids = REGULARS;
  for (const id of ids) {
    const shift = planned(id, now);
    if (!shift || !calledOut(vc, shift) || events.callouts[shift.key]) continue;
    if (benderOn(id, now) || state[id].override) continue; // not coming anyway, or summoned
    const free = ids.filter((c) => c !== id && !onShift(c, now) && !state[c].running && !state[c].busy
      && !state[c].override && !benderOn(c, now));
    const cover = pickCover(vc, shift.key, free);
    events.callouts[shift.key] = { bot: id, cover, at: now, until: shift.endTs };
    for (const [k, c] of Object.entries(events.callouts)) if (now - c.until > 3 * 24 * 60 * MIN) delete events.callouts[k];
    saveEvents();
    const who = cfg.bots[id].nick;
    log(`${id}: CALLED OUT of ${shift.key}; ${cover ? `${cover} covers` : 'nobody covers'}`);
    if (cover) {
      state[cover].override = { mode: 'on', until: shift.endTs, why: `covering for ${who}`, cover: id, since: now };
      continue;
    }
    const teller = ids.find((c) => c !== id && state[c].running && !state[c].busy && desired(c, now).on);
    if (!teller) continue;
    requestLine(cfg.bots[teller], 'no_show', { vars: { who } })
      .then((asked) => asked && log(`${teller}: 'no_show' requested`))
      .catch((e) => log(`${teller}: no-show line failed: ${e.message}`));
  }
}

function summon(id, why, stayMin = cfg.summonStayMin) {
  const now = Date.now(), st = state[id];
  // PHA-3842: a guest called in by chat gets a visit's few minutes, not a shift.
  if (GUESTS.has(id)) stayMin = visitLength(gc, cfg.bots[id]);
  st.lastMention = now;
  st.override = { mode: 'on', until: now + stayMin * MIN, why };
  log(`${id}: SUMMON (${why}) for ${stayMin}m`);
  reconcile().catch((e) => log('reconcile', e.message));
}

function dismiss(id, why) {
  const now = Date.now(), st = state[id];
  // Dismissing the villain mid-takeover overthrows him; the takeover code
  // plays that scene and frees the Sexton.
  if (events.takeover.active && id === ev.takeover?.villain) {
    events.takeover.active.overthrown = why;
    saveEvents();
  }
  if (onShift(id, now)) {
    // Off for the rest of this shift, then the schedule resumes.
    st.override = { mode: 'off', until: nextFlip(id, now, false), why };
  } else {
    // Summoned off shift: back to the schedule, but through a short 'off'
    // override. Zeroing lastHumanTalk alone didn't hold: the next room poll
    // re-set it while anyone was talking, and the talk-grace kept him in.
    st.override = { mode: 'off', until: now + 2 * MIN, why };
  }
  st.exitReason = 'dismiss';
  log(`${id}: DISMISS (${why})`);
  reconcile().catch((e) => log('reconcile', e.message));
}

// ------------------------------------------------------------ docker exec --

function dockerApi(method, path, body, timeoutMs = 30_000) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker api timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function exec(container, cmd, timeoutMs) {
  const { Id } = JSON.parse(await dockerApi('POST', `/containers/${container}/exec`,
    { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true }));
  return (await dockerApi('POST', `/exec/${Id}/start`, { Detach: false, Tty: true }, timeoutMs)).trim();
}

// The core is `[program:sexton]` in every bot container. The marker file tells
// sexton-healthcheck the bot is off duty, not broken.
async function coreRunning(bot, id) {
  const out = await exec(bot.container, ['supervisorctl', 'status', 'sexton']);
  const up = /\b(RUNNING|STARTING|BACKOFF)\b/.test(out);
  if (!up || !bot.guest) return up;
  // PHA-3842: the guest container's core is up as whoever is in the chair.
  // Nobody known in it (first boot, a hand restart): nobody would ever stop
  // it, so stop it here; the next visit switches someone in properly.
  const who = (await exec(bot.container, ['cat', '/config/.guest']).catch(() => '')).trim();
  if (!GUESTS.has(who) || cfg.bots[who].container !== bot.container) {
    log(`${bot.container}: core up with no guest in the chair ('${who}'), stopping it`);
    await stopCore(bot);
    return false;
  }
  return who === id;
}

// PHA-3842: put guest `id` in the shared container's chair before his core
// starts. Restarts that container's gateway when the persona changes (~30s).
async function prepareGuest(id, bot) {
  if (!bot.guest) return;
  const out = await exec(bot.container, ['node', '/usr/local/bin/guest-switch.mjs', id], 180_000);
  const last = out.split('\n').filter(Boolean).pop() || '';
  let r;
  try { r = JSON.parse(last); } catch { throw new Error(`guest-switch ${id}: ${out.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`guest-switch ${id}: ${r.error}`);
  log(`${id}: in the guest chair as '${r.nick}'${r.changed ? ' (gateway restarted)' : ''}`);
}
async function startCore(bot) {
  await exec(bot.container, ['rm', '-f', '/config/.off-duty']);
  return exec(bot.container, ['supervisorctl', 'start', 'sexton']);
}
async function stopCore(bot) {
  await exec(bot.container, ['touch', '/config/.off-duty']);
  return exec(bot.container, ['supervisorctl', 'stop', 'sexton']);
}

// ------------------------------------------------- entrance/exit lines --
// PHA-3824. The bot's gateway plays a line from its own lines.json when this
// file appears, and deletes it once the line has finished. Entrances are
// written before the core starts (the gateway holds it until it's in the
// channel); exits are written first and the core is stopped once it's gone.
// Nobody on the server, nobody to hear it: skip the TTS call. Entrances still
// go out, marked quiet, because they also roll the shift's mood (PHA-3840).

const ANNOUNCE_FILE = cfg.announce?.file ?? '/config/.announce';

const audience = () => cfg.announce?.enabled !== false && room.queryUp && room.humans > 0;

// `entrance` requests go out even to an empty server, marked quiet: they also
// roll the shift's mood (PHA-3840). `vars` fill {who} on a birthday (PHA-3841).
async function requestLine(bot, reason, { entrance = false, vars } = {}) {
  if (cfg.announce?.enabled === false) return false;
  const quiet = !audience();
  if (quiet && !entrance) return false;
  const body = JSON.stringify({ reason, at: Date.now(), ...(quiet ? { quiet } : {}), ...(vars ? { vars } : {}) });
  await exec(bot.container, ['sh', '-c', 'printf %s "$1" > "$2"', 'announce', body, ANNOUNCE_FILE]);
  return true;
}

async function lineFinished(bot) {
  const out = await exec(bot.container, ['sh', '-c', 'test -e "$1" && echo waiting || echo done', 'announce', ANNOUNCE_FILE]);
  return out.includes('done');
}

async function startWithLine(id, bot, reason, vars) {
  await prepareGuest(id, bot);
  try {
    if (await requestLine(bot, reason, { entrance: true, vars })) log(`${id}: entrance line '${reason}' requested`);
  } catch (e) {
    log(`${id}: entrance line failed: ${e.message}`);
  }
  return startCore(bot);
}

async function stopWithLine(id, bot, reason, vars) {
  try {
    if (await requestLine(bot, reason, { vars })) {
      const deadline = Date.now() + (cfg.announce?.exitWaitSec ?? 20) * 1000;
      while (Date.now() < deadline && !(await lineFinished(bot))) await new Promise((r) => setTimeout(r, 1000));
      log(`${id}: exit line '${reason}' done`);
    }
  } catch (e) {
    log(`${id}: exit line failed: ${e.message}`);
  }
  // A leftover request would fire as the next entrance; drop it.
  await exec(bot.container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
  return stopCore(bot);
}

// ------------------------------------------------------------- scenes --
// PHA-3841 S5. A scene is a short script from scenes.json, played by handing
// each bot its next line through the same announce file, one at a time: write
// the line, wait for the bot to delete the file (= said it), next. The bots
// never coordinate with each other; the summoner is the stage manager.

const sceneMemory = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sayAndWait(id, text, vars, timeoutSec) {
  const bot = cfg.bots[id];
  await exec(bot.container, ['sh', '-c', 'printf %s "$1" > "$2"', 'announce',
    JSON.stringify({ reason: 'scene', text, vars, at: Date.now() }), ANNOUNCE_FILE]);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await wait(1000);
    if (await lineFinished(bot)) return true;
  }
  await exec(bot.container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
  return false;
}

/**
 * Plays scene `key` (tag = tonight's calendar pool). `joining` = bots whose
 * core was just started: their first line gets a longer wait (core start +
 * channel join is ~10-25s). Lines for a bot that isn't up are skipped; `do`
 * steps always run, so a takeover still jails even if a line was lost. A line
 * that times out mutes the rest of the script, the actions still happen.
 * Returns false if there was no scene to play.
 */
async function playScene(key, tag, vars, joining = []) {
  const pick = pickScene(scenes(), key, tag, Math.random, sceneMemory);
  if (!pick) return false;
  log(`scene ${pick.key} #${pick.index}`);
  const ids = Object.keys(cfg.bots);
  const waiting = new Set(joining);
  let muted = !audience();
  for (const raw of pick.steps) {
    const step = parseStep(raw, ids);
    if (!step) { log(`scene ${pick.key}: skipping step ${JSON.stringify(raw)}`); continue; }
    if (step.do) {
      await sceneAction(step.do).catch((e) => log(`scene ${pick.key}: ${step.do} failed: ${e.message}`));
      continue;
    }
    if (muted) continue;
    if (!state[step.bot].running && !waiting.has(step.bot)) continue;
    const timeoutSec = waiting.has(step.bot) ? (cfg.scenes?.joinWaitSec ?? 90) : (cfg.scenes?.lineWaitSec ?? 30);
    waiting.delete(step.bot);
    try {
      if (!(await sayAndWait(step.bot, step.line, vars, timeoutSec))) {
        log(`scene ${pick.key}: ${step.bot} never said his line, cutting the dialogue`);
        muted = true;
      }
    } catch (e) {
      log(`scene ${pick.key}: ${step.bot}: ${e.message}`);
      muted = true;
    }
  }
  return true;
}

async function sceneAction(what) {
  const t = ev.takeover;
  if (what === 'jail') {
    await moveClient(t.target, t.jailChannelId);
    if (events.takeover.active) { events.takeover.active.jailed = true; saveEvents(); }
    log(`${t.target}: jailed (channel ${t.jailChannelId})`);
  } else if (what === 'release') {
    if (events.takeover.active) { events.takeover.active.jailed = false; saveEvents(); }
    await moveClient(t.target, cfg.channelId);
    log(`${t.target}: released`);
  } else {
    throw new Error(`unknown action '${what}'`);
  }
}

/**
 * Starts a bot that's about to be in a scene. Its own entrance line would
 * talk over the script, so the request goes out marked quiet: it still rolls
 * the shift's mood (PHA-3840), says nothing, and its removal tells us he's
 * in the channel and ready for his first line.
 */
async function joinQuietly(id, reason) {
  const bot = cfg.bots[id];
  await prepareGuest(id, bot);
  await exec(bot.container, ['sh', '-c', 'printf %s "$1" > "$2"', 'announce',
    JSON.stringify({ reason, at: Date.now(), quiet: true }), ANNOUNCE_FILE]);
  log(`${id}: ${await startCore(bot)}`);
  const deadline = Date.now() + (cfg.scenes?.joinWaitSec ?? 90) * 1000;
  while (Date.now() < deadline) {
    await wait(1000);
    if (await lineFinished(bot)) return true;
  }
  log(`${id}: never came up for his scene`);
  await exec(bot.container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
  return false;
}

/** Marks bots busy for the length of `fn`, so reconcile leaves them alone. */
function backstage(ids, label, fn) {
  for (const id of ids) state[id].busy = true;
  return fn()
    .catch((e) => log(`${label}: ${e.message}`))
    .finally(() => { for (const id of ids) state[id].busy = false; });
}

// Tonight's line tag for a bot: a rare-event tag beats the calendar pool.
function tagFor(id, now, base) {
  if (base === 'shift_start' && events.bender.returning === id) return 'bender_return';
  if (benderOn(id, now) || (base !== 'shift_start' && events.bender.active?.bot === id && now < events.bender.active.until)) return 'bender';
  return flavorFor(cfg, calendar(), id, now).pool;
}
const varsFor = (id, now) => {
  const v = flavorFor(cfg, calendar(), id, now).vars;
  return Object.keys(v).length ? v : undefined;
};

// ------------------------------------------------------------ rare events --
// PHA-3841 S7. Both are rare by construction: a cooldown in days, then dice.
// The calendar can force either one on a date (`"events": ["takeover"]`), and
// POST /event/<kind> fires one by hand.

function startTakeover(now, why) {
  const t = ev.takeover;
  events.takeover.lastAt = now;
  events.takeover.active = { startedAt: now, until: now + t.durationMin * MIN, jailed: false, overthrown: null, why };
  saveEvents();
  const v = state[t.villain];
  v.override = { mode: 'on', until: events.takeover.active.until, why: 'hostile takeover' };
  v.lastAction = now;
  v.exitReason = null;
  log(`EVENT takeover (${why}) until ${new Date(events.takeover.active.until).toISOString()}`);
  backstage([t.villain, t.target], 'takeover start', async () => {
    await joinQuietly(t.villain, 'summon');
    v.running = true;
    v.working = true;
    if (!(await playScene('takeover:start', null, undefined, []))) {
      await sceneAction('jail'); // no script, still a takeover
    }
  });
}

function endTakeover(now) {
  const t = ev.takeover, a = events.takeover.active;
  const overthrown = Boolean(a.overthrown);
  events.takeover.active = null;
  saveEvents();
  const v = state[t.villain];
  if (v.override?.why === 'hostile takeover') v.override = null;
  log(`EVENT takeover over (${overthrown ? `overthrown: ${a.overthrown}` : 'time'})`);
  backstage([t.villain, t.target], 'takeover end', async () => {
    const played = await playScene(overthrown ? 'takeover:overthrown' : 'takeover:end', null, undefined, []);
    if (!played || a.jailed) await sceneAction('release').catch(() => {});
    // The scene was his exit line; leave without another one.
    if (!desired(t.villain, Date.now()).on && (await coreRunning(cfg.bots[t.villain]))) {
      v.working = false;
      v.exitReason = null;
      v.lastAction = Date.now();
      await exec(cfg.bots[t.villain].container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
      log(`${t.villain}: ${await stopCore(cfg.bots[t.villain])}`);
    }
  });
}

function takeoverTick(now, forced) {
  const t = ev.takeover;
  if (!t?.enabled) return;
  const a = events.takeover.active;
  if (a) {
    if (state[t.villain].busy || state[t.target].busy) return;
    if (now >= a.until || a.overthrown) endTakeover(now);
    return;
  }
  const tg = state[t.target], vl = state[t.villain];
  const ok = takeoverEligible({
    enabled: true, queryUp: room.queryUp, active: false, humans: room.humans, minHumans: t.minHumans ?? 2,
    targetRunning: tg.running, targetOnShift: onShift(t.target, now), targetOverride: Boolean(tg.override), targetBusy: tg.busy,
    targetOnShiftAfter: onShift(t.target, now + (t.durationMin + 15) * MIN),
    villainRunning: vl.running, villainOnShift: onShift(t.villain, now), villainOverride: Boolean(vl.override), villainBusy: vl.busy,
    offCooldown: forced || offCooldown(events.takeover.lastAt, t.cooldownDays, now),
  });
  if (!ok) return;
  if (forced || Math.random() < tickChance(cfg.reconcileSec, t.meanEligibleMin)) {
    if (forced) { events.forced[forced] = true; }
    startTakeover(now, forced ? `calendar ${forced}` : 'dice');
  }
}

function startBender(now, why) {
  const b = ev.bender;
  events.bender.lastAt = now;
  events.bender.active = { bot: b.bot, from: now, until: now + b.durationHours * 60 * MIN, newsSaid: 0, why };
  events.bender.returning = null;
  saveEvents();
  log(`EVENT bender: ${b.bot} (${why}) until ${new Date(events.bender.active.until).toISOString()}`);
}

// Someone in the room breaks the news that the band isn't coming.
function benderNews(now) {
  const a = events.bender.active;
  const teller = (ev.bender.tellers ?? REGULARS)
    .find((id) => id !== a.bot && state[id].running && !state[id].busy && desired(id, now).on);
  const reason = a.newsSaid ? 'bender_news:day2' : 'bender_news';
  a.newsSaid += 1;
  saveEvents();
  if (!teller) return;
  requestLine(cfg.bots[teller], reason)
    .then((asked) => asked && log(`${teller}: '${reason}' requested`))
    .catch((e) => log(`${teller}: bender news failed: ${e.message}`));
}

function benderTick(now, forced) {
  const b = ev.bender;
  if (!b?.enabled) return;
  const a = events.bender.active;
  if (a && now >= a.until) {
    log(`EVENT bender over; ${a.bot} is back on his next shift`);
    events.bender.active = null;
    events.bender.returning = a.bot;
    saveEvents();
  }
  // A shift that starts (on the plain schedule) is where a bender is born,
  // and where the news gets broken while it lasts.
  const st = state[b.bot];
  const baseOn = onShift(b.bot, now);
  const shiftStarted = st.baseOn === false && baseOn;
  st.baseOn = baseOn;
  if (!shiftStarted && !forced) return;
  if (events.bender.active) {
    if (shiftStarted) benderNews(now);
    return;
  }
  const dayOk = (b.days ?? [5]).includes(local(now, cfg.tz).day);
  if (forced || (dayOk && offCooldown(events.bender.lastAt, b.cooldownDays, now) && Math.random() < b.chance)) {
    if (forced) events.forced[forced] = true;
    startBender(now, forced ? `calendar ${forced}` : 'dice');
    if (shiftStarted) benderNews(now);
  }
}

// ------------------------------------------------------------ guest stars --
// PHA-3842 G1. A visit is an 'on' override marked `visit`, so everything else
// (entrance line, exit line, empty-server cutoff, dismissals) is the ordinary
// summons machinery. Visit history is persisted for the weekly cap.

const inRoom = (id) => Boolean(state[id]?.running) && !GUESTS.has(id);
const specialNight = (ids, now) => ids.some((id) => (cfg.bots[id].guest.needs ?? REGULARS)
  .some((h) => flavorFor(cfg, calendar(), h, now).pool));

function startVisit(id, now, why) {
  const len = visitLength(gc, cfg.bots[id]);
  const until = now + len * MIN;
  events.guests.active = { bot: id, from: now, until, why };
  events.guests.visits = [...events.guests.visits.filter((t) => now - t < 14 * 24 * 60 * MIN), now];
  saveEvents();
  state[id].override = { mode: 'on', until, why: 'guest visit', visit: true };
  state[id].exitReason = null;
  log(`GUEST ${id} drops in (${why}) for ${len}m`);
}

function guestsTick(now) {
  if (!GUESTS.size) return;
  const a = events.guests.active;
  if (a) {
    const st = state[a.bot];
    const o = st.override;
    // `running` is null when a status call failed: that's not the host leaving.
    const needs = (cfg.bots[a.bot].guest.needs ?? []).filter((h) => state[h]);
    const hostGone = needs.length > 0 && !needs.some((h) => state[h].running !== false || state[h].busy);
    if (o?.visit && hostGone && st.running && !st.busy) {
      log(`GUEST ${a.bot}: the host left, so does the guest`);
      o.until = now;
    }
    if (!o?.visit || now >= a.until || now >= o.until) {
      if (now < a.until) log(`GUEST ${a.bot}: visit cut short (${o ? o.why : 'override cleared'})`);
      events.guests.active = null;
      saveEvents();
    }
    return;
  }
  if (!gc.enabled) return;
  const cands = guestCandidates(cfg, inRoom);
  if (!cands.length) return;
  const special = specialNight(cands, now);
  const slotBusy = [...GUESTS].some((g) => state[g].running || state[g].busy || state[g].override?.mode === 'on');
  if (!slotOpen(gc, { queryUp: room.queryUp, humans: room.humans, slotBusy, visits: events.guests.visits, special, now })) return;
  if (Math.random() >= visitChance(gc, cfg.reconcileSec, special)) return;
  const id = pickGuest(cfg, cands);
  if (id) startVisit(id, now, special ? 'dice, special night' : 'dice');
}

function eventsTick(now) {
  // Calendar-forced events fire once per entry per service day.
  const forced = {};
  for (const f of forcedEvents(cfg, calendar(), now)) {
    const k = `${f.entryId}@${f.day}`;
    if (!events.forced[k]) forced[f.event] = k;
  }
  takeoverTick(now, forced.takeover);
  benderTick(now, forced.bender);
  guestsTick(now);
  banterTick(now);
}

// ------------------------------------------------------------------ banter --
// PHA-3859. A couple of times a night two regulars have a longer bit with
// each other (scenes.json `banter:<a>+<b>`). Rules in banter.mjs. A bot
// that drops in for it comes in quietly, does the bit, and leaves without an
// exit line; the script's last word is his goodbye.

const banterFree = (id) => REGULARS.includes(id) && !state[id].busy;
const banterPresent = (id) => banterFree(id) && inRoom(id) && desired(id, Date.now()).on;
const banterCanDrop = (id) => banterFree(id) && state[id].running === false && !state[id].override
  && desired(id, Date.now()).why === 'off shift';

function stageBusy() {
  return Boolean(events.takeover.active || events.guests.active)
    || Object.values(state).some((s) => s.busy);
}

function startBanter(pick, now, why) {
  const day = serviceDay(now, cfg.tz).ymd;
  events.banter.plays = events.banter.plays.filter((p) => now - p.at < 7 * 24 * 60 * MIN);
  events.banter.plays.push({ day, at: now, key: pick.key, dropIn: pick.dropIn });
  saveEvents();
  log(`BANTER ${pick.key}${pick.dropIn ? `, ${pick.dropIn} drops in` : ''} (${why})`);
  const d = pick.dropIn;
  if (d) {
    // Held on for the bit; the summoner sends him back out right after it.
    state[d].override = { mode: 'on', until: now + 15 * MIN, why: 'banter drop-in' };
    state[d].lastAction = now;
    state[d].exitReason = null;
  }
  return backstage([pick.a, pick.b], 'banter', async () => {
    try {
      if (d) {
        if (!(await joinQuietly(d, 'summon'))) return;
        state[d].running = true;
        state[d].working = true;
      }
      await playScene(pick.key, tagFor(pick.a, Date.now(), 'banter'), undefined, []);
    } finally {
      if (d) {
        const st = state[d];
        if (st.override?.why === 'banter drop-in') st.override = null;
        if (!desired(d, Date.now()).on && (await coreRunning(cfg.bots[d]))) {
          st.working = false;
          st.exitReason = null;
          st.lastAction = Date.now();
          await exec(cfg.bots[d].container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
          log(`${d}: ${await stopCore(cfg.bots[d])} (banter over)`);
        }
      }
    }
  });
}

function banterTick(now) {
  const lastTalk = Math.max(room.lastHumanTalk, room.lastChat);
  const day = serviceDay(now, cfg.tz).ymd;
  if (!banterOpen(bc, { queryUp: room.queryUp, humans: room.humans, lastTalk, stageBusy: stageBusy(), plays: events.banter.plays, day, now })) return;
  if (Math.random() >= banterChance(bc, cfg.reconcileSec)) return;
  const sc = scenes();
  const pick = pickBanter(bc, {
    present: banterPresent, canDrop: banterCanDrop,
    hasScene: (k) => Array.isArray(sc[k]) && sc[k].length > 0,
    recent: events.banter.plays.filter((p) => p.day === day).map((p) => p.key),
  });
  if (pick) startBanter(pick, now, 'dice');
}

function startEventByHand(kind, who) {
  const now = Date.now();
  if (kind === 'guest' && GUESTS.size) {
    if (events.guests.active) return { ok: false, error: `${events.guests.active.bot} is already visiting` };
    const id = who ? resolveBot(who) : pickGuest(cfg, guestCandidates(cfg, inRoom)) ?? pickGuest(cfg, [...GUESTS]);
    if (!id || !GUESTS.has(id)) return { ok: false, error: `not a guest: ${who}` };
    startVisit(id, now, 'by hand');
    reconcile().catch((e) => log('reconcile', e.message));
    return { ok: true, guest: id, until: new Date(events.guests.active.until).toISOString() };
  }
  if (kind === 'takeover' && ev.takeover?.enabled) {
    if (events.takeover.active) return { ok: false, error: 'a takeover is already on' };
    const t = ev.takeover;
    if (!state[t.target].running || state[t.villain].running || state[t.villain].busy || state[t.target].busy) {
      return { ok: false, error: `needs ${t.target} in the room and ${t.villain} out of it` };
    }
    startTakeover(now, 'by hand');
    return { ok: true, until: new Date(events.takeover.active.until).toISOString() };
  }
  // who=<a>+<b> picks the pair; without it, any pair that can play now.
  if (kind === 'banter') {
    if (stageBusy()) return { ok: false, error: 'something else is on stage' };
    const ids = (who ?? '').split(/[+, ]+/).map(resolveBot).filter(Boolean);
    const sc = scenes();
    const only = ids.length === 2 ? banterKey(ids[0], ids[1]) : null;
    const pick = pickBanter(only ? { ...bc, pairs: [ids] } : bc, {
      present: banterPresent, canDrop: banterCanDrop,
      hasScene: (k) => Array.isArray(sc[k]) && sc[k].length > 0 && (!only || k === only),
    });
    if (!pick) return { ok: false, error: `no pair can play now${who ? ` (${who})` : ''}` };
    startBanter(pick, now, 'by hand');
    return { ok: true, ...pick };
  }
  if (kind === 'bender' && ev.bender?.enabled) {
    if (events.bender.active) return { ok: false, error: 'already on a bender' };
    startBender(now, 'by hand');
    return { ok: true, until: new Date(events.bender.active.until).toISOString() };
  }
  return { ok: false, error: `unknown or disabled event '${kind}'` };
}

function endEventByHand(kind) {
  const now = Date.now();
  if (kind === 'takeover' && events.takeover.active) {
    events.takeover.active.until = now;
    saveEvents();
    return { ok: true };
  }
  if (kind === 'bender' && events.bender.active) {
    events.bender.active.until = now;
    saveEvents();
    return { ok: true };
  }
  if (kind === 'guest' && events.guests.active) {
    const o = state[events.guests.active.bot].override;
    if (o?.visit) o.until = now;
    return { ok: true };
  }
  return { ok: false, error: `no ${kind} on` };
}

// --------------------------------------------------------------- reconcile --

let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const now = Date.now();
    // Summoned bots leave once the server has had no humans for a while.
    // (A takeover isn't a summons; it runs its hour.)
    for (const [id, st] of Object.entries(state)) {
      if (st.override?.mode === 'on' && st.override.why !== 'hostile takeover' && !st.override.cover && room.queryUp && room.humans === 0
          && now - room.lastHumanSeen > cfg.idleGraceMin * MIN) {
        log(`${id}: server empty, ending '${st.override.why}'`);
        st.override = null;
      }
    }
    for (const [id, bot] of Object.entries(cfg.bots)) {
      try {
        const up = await coreRunning(bot, id);
        if (up && state[id].running === false) state[id].onSince = now;
        state[id].running = up;
      } catch (e) {
        log(`${id}: status failed: ${e.message}`);
        state[id].running = null;
      }
    }
    eventsTick(now);
    for (const [id, st] of Object.entries(state)) {
      const p = onShift(id, now);
      if (st.plannedOn && !p) st.shiftEndedAt = now;
      st.plannedOn = p;
    }
    calloutTick(now);

    // Work out every bot's move first, so two moves in the same tick (Sexton
    // out, Lexton in, at midnight) can become one scene.
    const moves = [], present = [], lingering = [];
    for (const id of Object.keys(cfg.bots)) {
      const st = state[id];
      if (st.running === null || st.busy) continue;
      const d = desired(id, now);
      st.onDuty = d.on;
      if (d.on && st.running) st.working = true;
      if (d.on === st.running) {
        if (d.on) {
          st.exitReason = null;
          if (d.why === 'on shift') present.push(id);
          else if (d.why.startsWith('shift over')) lingering.push(id);
          else present.push(id);
        }
        continue;
      }
      if (now - st.lastAction < 60_000) continue; // one move per bot per minute
      if (d.on) {
        // PHA-3839 tags: `shift_start:late`, `shift_start:covering` ({who}).
        // Back after walking out of a quiet room is a summon (keeps the mood).
        if (d.visit) {
          // PHA-3842: a guest dropping in uses his shift_start pool, and an
          // `arrive:<guest>@<host>` scene when scenes.json has one.
          moves.push({ id, dir: 'start', base: 'shift_start', why: d.why });
        } else if (d.cover && st.leftQuiet !== d.cover) {
          moves.push({ id, dir: 'start', base: 'shift_start', tag: 'covering', vars: { who: cfg.bots[d.cover].nick }, why: d.why });
        } else if (d.why === 'on shift' && st.leftQuiet !== d.shift.key) {
          moves.push({ id, dir: 'start', base: 'shift_start', tag: isLate(vc, d.shift, now) ? 'late' : null, why: d.why });
        } else {
          moves.push({ id, dir: 'start', base: 'summon', why: d.why });
        }
      } else {
        // A core that came back by itself off shift (PHA-3831) leaves quietly.
        // Not `onDuty`: that flips the moment the decision does, and the
        // one-move-per-minute limit can put a reconcile in between.
        const base = st.working ? (st.exitReason ?? 'shift_end') : null;
        const tag = d.quiet && base === 'shift_end' ? 'early_out' : null;
        if (d.quiet) st.leftQuiet = planned(id, now)?.key ?? st.override?.cover ?? null;
        moves.push({ id, dir: 'stop', base, tag, why: d.why });
      }
    }

    const sceneOn = cfg.scenes?.enabled !== false && audience();
    // A late, covering or early-out move has its own line; no scene for it.
    const plain = moves.filter((m) => !m.tag);
    const { scenes: plays, rest } = sceneOn
      ? planScenes({ moves: plain, present, lingering, hasScene: (k) => Array.isArray(scenes()[k]) && scenes()[k].length > 0 })
      : { scenes: [], rest: plain };
    rest.push(...moves.filter((m) => m.tag));

    for (const p of plays) runScene(p, now);
    for (const m of rest) soloMove(m, now);
  } finally {
    reconciling = false;
  }
}

function runScene(p, now) {
  const ids = [p.start, p.stop, p.partner].filter(Boolean);
  const lead = p.start ?? p.stop;
  const tag = tagFor(lead, now, p.start ? 'shift_start' : 'shift_end');
  const vars = varsFor(lead, now);
  log(`${ids.join('+')}: ${p.key}`);
  for (const id of ids) state[id].lastAction = now;
  backstage(ids, p.key, async () => {
    if (p.start) {
      const st = state[p.start];
      st.exitReason = null;
      if (events.bender.returning === p.start) { events.bender.returning = null; saveEvents(); }
      await joinQuietly(p.start, tagged('shift_start', tag));
      st.running = true; // don't wait for the next reconcile to notice
      st.working = true;
    }
    await playScene(p.key, tag, vars, []);
    if (p.stop) {
      const st = state[p.stop];
      st.working = false;
      st.exitReason = null;
      await exec(cfg.bots[p.stop].container, ['rm', '-f', ANNOUNCE_FILE]).catch(() => {});
      log(`${p.stop}: ${await stopCore(cfg.bots[p.stop])}`);
      // Talk grace is over: the hand-off was his goodbye.
      st.lastAction = Date.now();
    }
  });
}

const mergeVars = (a, b) => (a || b ? { ...a, ...b } : undefined);

function soloMove(m, now) {
  const id = m.id, bot = cfg.bots[id], st = state[id];
  st.lastAction = now;
  log(`${id}: ${m.dir === 'start' ? 'START' : 'STOP'} core (${m.why})`);
  if (m.dir === 'start') {
    st.exitReason = null;
    st.onSince = now;
    if (m.base === 'shift_start') st.leftQuiet = null;
    const reason = tagged(tagged(m.base, m.tag), tagFor(id, now, m.base));
    if (m.base === 'shift_start' && events.bender.returning === id) { events.bender.returning = null; saveEvents(); }
    // A guest's persona switch can restart his gateway; hold reconcile off
    // him until he's up, or the next tick would start him a second time.
    if (bot.guest) st.busy = true;
    startWithLine(id, bot, reason, mergeVars(varsFor(id, now), m.vars))
      .then((out) => log(`${id}: ${out}`))
      .catch((e) => log(`${id}: action failed: ${e.message}`))
      .finally(() => { if (bot.guest) st.busy = false; });
    return;
  }
  const reason = m.base ? tagged(tagged(m.base, m.tag), tagFor(id, now, m.base)) : null;
  st.exitReason = null;
  st.working = false;
  // The exit line can take a while; don't hold up the other bots for it.
  st.busy = true;
  (reason ? stopWithLine(id, bot, reason, mergeVars(varsFor(id, now), m.vars)) : stopCore(bot))
    .then((out) => log(`${id}: ${out}`))
    .catch((e) => log(`${id}: action failed: ${e.message}`))
    .finally(() => { st.busy = false; });
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
  room.lastChat = now; // typing counts as the room being alive (PHA-3839 S3)
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
      // Guests don't get extended: a few minutes, then a graceful exit.
      if (st.override?.mode === 'on' && !GUESTS.has(id)) st.override.until = Math.max(st.override.until, now + cfg.summonStayMin * MIN);
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
  room.clients = clients;
  // A jailed Sexton who reconnects (core restart) lands back in the main
  // channel. He's serving an hour; put him back.
  const t = events.takeover.active;
  if (t?.jailed && !t.overthrown && now < t.until) {
    const c = findClient(ev.takeover.target);
    if (c && c.cid !== String(ev.takeover.jailChannelId)) {
      log(`${ev.takeover.target}: walked out of Bot Jail, putting him back`);
      await moveClient(ev.takeover.target, ev.takeover.jailChannelId).catch((e) => log('rejail:', e.message));
    }
  }
}

let liveQuery = null;
function findClient(id) {
  const nick = cfg.bots[id].nick.toLowerCase();
  return room.clients.find((c) => (c.client_nickname || '').toLowerCase() === nick);
}
async function moveClient(id, cid) {
  const c = findClient(id);
  if (!liveQuery || !c) throw new Error(`${id} is not on the server`);
  await liveQuery.cmd(`clientmove clid=${c.clid} cid=${cid}`);
  c.cid = String(cid);
}

async function runQuery() {
  const q = new Query();
  liveQuery = q;
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
  if (liveQuery === q) liveQuery = null;
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
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const today = local(now, cfg.tz);
  return {
    now: new Date(now).toISOString(), room: { ...room, clients: undefined },
    events: {
      takeover: { ...events.takeover, lastAt: iso(events.takeover.lastAt) },
      bender: { ...events.bender, lastAt: iso(events.bender.lastAt) },
      callouts: events.callouts,
      banter: { plays: events.banter.plays.map((p) => ({ ...p, at: iso(p.at) })) },
      guests: {
        active: events.guests.active && { ...events.guests.active, from: iso(events.guests.active.from), until: iso(events.guests.active.until) },
        visits: events.guests.visits.map(iso),
      },
    },
    bots: Object.fromEntries(Object.keys(cfg.bots).map((id) => [id, {
      running: state[id].running, busy: state[id].busy, desired: desired(id, now), onShift: onShift(id, now),
      shift: (({ key, startTs, endTs, lateMin }) => key && { key, start: iso(startTs), end: iso(endTs), lateMin })(planned(id, now) ?? {}),
      shiftsToday: shiftsFor(cfg, calendar(), id, today).shifts,
      flavor: flavorFor(cfg, calendar(), id, now),
      override: state[id].override && { ...state[id].override, until: iso(state[id].override.until) },
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
  // PHA-3841: fire or end a rare event by hand (testing, or Brandon's whim).
  // POST /event/takeover | /event/bender | /event/end?kind=takeover|bender
  if (req.method === 'POST' && verb === 'event') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const kind = id === 'end' ? qs.get('kind') : id;
    const out = id === 'end' ? endEventByHand(kind) : startEventByHand(kind, qs.get('who'));
    return send(out.ok ? 200 : 409, out);
  }
  if (req.method === 'POST' && verb === 'heard') {
    const by = new URL(req.url, 'http://x').searchParams.get('by') || '';
    let body = '';
    req.on('data', (c) => { if (body.length < 4000) body += c; });
    req.on('end', () => send(200, { summoned: onHeard(by, body) }));
    return;
  }
  send(404, { error: 'GET /status | POST /summon/<bot> | POST /dismiss/<bot> | POST /heard?by=<speaker> | POST /event/<takeover|bender|guest|banter>[?who=<guest>|<a>+<b>] | POST /event/end?kind=<takeover|bender|guest>' });
}).listen(cfg.httpPort, () => log(`http on :${cfg.httpPort}`));

setInterval(() => reconcile().catch((e) => log('reconcile', e.message)), cfg.reconcileSec * 1000);
reconcile().catch((e) => log('reconcile', e.message));
queryLoop();
