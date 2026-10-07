// #3841: the schedule, with the special-nights calendar folded in.
//
// Pure functions only (no I/O, no clock), so test/schedule.test.mjs can pin
// every edge: midnight crossings, a calendar entry replacing a shift, the
// "night belongs to the day it started" rule for pools.
//
// Two different "days" are in play, and mixing them up is the classic bug:
//   - shifts: a shift belongs to the date it STARTS on. Bexton's 18:00-02:00
//     on Friday is Friday's shift even at 01:30 Saturday.
//   - pools (which entrance/exit lines a night uses): the "service day",
//     which flips at 06:00. Lexton's 00:00 shift on Nov 1 is still Halloween
//     night, so it gets the halloween pool.

export const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MIN = 60_000;
export const SERVICE_DAY_FLIP_MIN = 6 * 60;

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(tz);
}

/** Wall-clock parts of `ts` in `tz`: { y, m, d, day (0=Sun), min (since midnight), md: 'MM-DD' }. */
export function local(ts, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, day: DAYS[p.weekday], min: Number(p.hour) * 60 + Number(p.minute), md: `${p.month}-${p.day}`, ymd: `${p.year}-${p.month}-${p.day}` };
}

/** The local date before `ts`'s date. Steps back past midnight with an hour to spare for DST. */
export function yesterday(ts, tz) {
  const { min } = local(ts, tz);
  return local(ts - (min + 61) * MIN, tz);
}

/** The service day: the date this night started on (the day flips at 06:00). */
export function serviceDay(ts, tz) {
  return local(ts - SERVICE_DAY_FLIP_MIN * MIN, tz);
}

export const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

const dayNum = (v) => (typeof v === 'number' ? v : DAY_NAMES[String(v).slice(0, 3).toLowerCase()]);

// ------------------------------------------------------------- matching --

/**
 * Does a calendar `when` match local date `p`? Forms (any one, plus optional `year`):
 *   { "date": "10-31" }                         one day every year
 *   { "from": "12-24", "to": "12-26" }          inclusive range, may wrap the new year
 *   { "weekday": "fri" } / ["fri","sat"]        every such weekday
 *   { "month": 11, "weekday": "thu", "nth": 4 } 4th Thursday of November; nth -1 = last
 */
export function matchesWhen(when, p) {
  if (!when || typeof when !== 'object') return false;
  if (when.year !== undefined && Number(when.year) !== p.y) return false;
  if (when.date) return when.date === p.md;
  if (when.from && when.to) {
    return when.from <= when.to ? p.md >= when.from && p.md <= when.to : p.md >= when.from || p.md <= when.to;
  }
  if (when.weekday !== undefined) {
    const days = [].concat(when.weekday).map(dayNum);
    if (!days.includes(p.day)) return false;
    if (when.month !== undefined && Number(when.month) !== p.m) return false;
    if (when.nth === undefined) return true;
    const nth = Number(when.nth);
    if (nth > 0) return Math.ceil(p.d / 7) === nth;
    const daysInMonth = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
    return p.d + 7 > daysInMonth; // last such weekday of the month
  }
  return false;
}

/** Enabled calendar entries that match date `p`, in file order (later entries win). */
export function entriesFor(calendar, p) {
  return (calendar?.entries ?? []).filter((e) => e && e.enabled !== false && matchesWhen(e.when, p));
}

// ------------------------------------------------------------- the plan --

/**
 * Bot `id`'s plan for shifts STARTING on date `p`:
 *   { shifts: [{start,end}], entries: [ids] }
 * Default shifts (filtered by their `days`) unless a matching entry gives the
 * bot `shifts` (replace; [] or `off: true` = day off) or `extraShifts` (add).
 */
export function shiftsFor(cfg, calendar, id, p) {
  const bot = cfg.bots[id];
  let shifts = (bot.shifts ?? []).filter((s) => (s.days ?? [0, 1, 2, 3, 4, 5, 6]).includes(p.day));
  const entries = [];
  for (const e of entriesFor(calendar, p)) {
    const b = e.bots?.[id];
    if (!b) continue;
    if (b.off) shifts = [];
    else if (Array.isArray(b.shifts)) shifts = b.shifts.slice();
    if (Array.isArray(b.extraShifts)) shifts = shifts.concat(b.extraShifts);
    if (b.off || b.shifts || b.extraShifts) entries.push(e.id);
  }
  return { shifts, entries };
}

/**
 * The shift `id` is on at `ts`, or null (calendar included, rare events not):
 *   { key, start, end, startTs, endTs, lateMin }
 * `jit(key)` (#3839) returns { start, end } minutes to push the shift by;
 * without it the schedule is exact. `key` names one shift on one date, so a
 * call-out or a jitter roll sticks to that shift.
 */
export function shiftAt(cfg, calendar, id, ts, jit) {
  const today = local(ts, cfg.tz);
  const days = [[today, today.min], [yesterday(ts, cfg.tz), today.min + 24 * 60]];
  for (const [p, min] of days) {
    const { shifts, entries } = shiftsFor(cfg, calendar, id, p);
    for (const s of shifts) {
      const key = `${id}@${p.ymd}@${s.start}`;
      const j = jit ? jit(key) : { start: 0, end: 0 };
      const a = hm(s.start), b0 = hm(s.end);
      const lo = a + j.start, hi = (b0 > a ? b0 : b0 + 24 * 60) + j.end;
      if (min >= lo && min < hi) {
        return {
          key, start: s.start, end: s.end, calendar: entries.length > 0, lateMin: j.start,
          startTs: ts - (min - lo) * MIN, endTs: ts + (hi - min) * MIN,
        };
      }
    }
  }
  return null;
}

/** Is `id` scheduled on at `ts`? */
export function onShift(cfg, calendar, id, ts, jit) {
  return shiftAt(cfg, calendar, id, ts, jit) !== null;
}

/** First minute at or after `ts` where pred(t) is `want` (24h horizon). */
export function nextFlip(pred, ts, want, horizonMin = 24 * 60) {
  for (let t = ts; t < ts + horizonMin * MIN; t += MIN) if (pred(t) === want) return t;
  return ts + horizonMin * MIN;
}

/**
 * The night's flavour for bot `id` at `ts`: { pool, vars, entries }.
 * pool = the last matching entry's per-bot `pool`, else its top-level `pool`.
 * vars merge in order (an entry's `vars`, then the bot's).
 */
export function flavorFor(cfg, calendar, id, ts) {
  const p = serviceDay(ts, cfg.tz);
  let pool = null;
  const vars = {};
  const entries = [];
  for (const e of entriesFor(calendar, p)) {
    const b = e.bots?.[id] ?? {};
    const pl = b.pool ?? e.pool;
    if (pl) pool = pl;
    Object.assign(vars, e.vars ?? {}, b.vars ?? {});
    entries.push(e.id);
  }
  return { pool, vars, entries, serviceDay: p.ymd };
}

/** Entries that force a rare event on today's service day: [{event, entryId}]. */
export function forcedEvents(cfg, calendar, ts) {
  const p = serviceDay(ts, cfg.tz);
  return entriesFor(calendar, p).flatMap((e) => [].concat(e.events ?? []).map((event) => ({ event, entryId: e.id, day: p.ymd })));
}

/** `base:tag`, or just `base`. */
export const tagged = (base, tag) => (tag ? `${base}:${tag}` : base);
