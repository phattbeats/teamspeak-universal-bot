// PHA-3839: schedule variety. Pure functions, no I/O, no clock.
//
//   S1 jitter   every shift starts and ends a random 0-45 min late, rolled
//               once per shift. A start late enough gets a "sorry I'm late".
//   S2 call-out about 1 shift in 10 a bot doesn't show. An off-duty bot
//               usually covers; otherwise someone in the room says so.
//   S3 the room a bot stays past its shift while people are talking (up to an
//               hour), and clocks out early once nobody has said a word for 30
//               min. It comes back when someone speaks up again.
//
// Rolls hash the shift's key (`sexton@2026-10-02@08:00`) with a salt, so a
// restart mid-shift lands on the same answer instead of re-rolling.

const MIN = 60_000;

/** A stable number in [0, 1) for `s`. FNV-1a, then a murmur finaliser. */
export function roll(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

export const defaults = {
  salt: 'pha-3839',
  jitter: { enabled: true, startMaxMin: 45, endMaxMin: 45, lateMin: 20, lateWindowMin: 15 },
  callout: { enabled: true, chance: 0.1, coverChance: 0.7, skipCalendarNights: true },
  room: { enabled: true, overtimeMaxMin: 60, quietOutMin: 30 },
};

/** cfg.variety merged over the defaults, one level deep. */
export function varietyConfig(v = {}) {
  return {
    salt: v.salt ?? defaults.salt,
    jitter: { ...defaults.jitter, ...v.jitter },
    callout: { ...defaults.callout, ...v.callout },
    room: { ...defaults.room, ...v.room },
  };
}

/** S1: { start, end } minutes this shift is pushed by. */
export function jitterFor(vc, key) {
  const j = vc.jitter;
  if (!j.enabled) return { start: 0, end: 0 };
  return {
    start: Math.floor(roll(`${vc.salt}|${key}|start`) * (j.startMaxMin + 1)),
    end: Math.floor(roll(`${vc.salt}|${key}|end`) * (j.endMaxMin + 1)),
  };
}

/** S1: should this entrance be the late one? `shift` is from shiftAt(). */
export function isLate(vc, shift, now) {
  return Boolean(vc.jitter.enabled && shift && shift.lateMin >= vc.jitter.lateMin
    && now - shift.startTs < vc.jitter.lateWindowMin * MIN);
}

/** S2: does this shift's bot call out? Special nights never do. */
export function calledOut(vc, shift) {
  const c = vc.callout;
  if (!c.enabled || !shift) return false;
  if (c.skipCalendarNights && shift.calendar) return false;
  return roll(`${vc.salt}|${shift.key}|callout`) < c.chance;
}

/**
 * S2: who covers a call-out, or null (nobody does, the room goes quiet).
 * `candidates` are bots free to come in, in config order; one is picked by
 * the same stable roll.
 */
export function pickCover(vc, key, candidates) {
  if (!candidates.length || roll(`${vc.salt}|${key}|cover`) >= vc.callout.coverChance) return null;
  return candidates[Math.floor(roll(`${vc.salt}|${key}|who`) * candidates.length)];
}

/**
 * S3: should a bot on shift clock out because the room has gone quiet?
 * `lastActivity` = the latest of a human talking, a human chatting, and the
 * bot (or the summoner) coming up, so a fresh start always gets the full wait.
 */
export function quietOut(vc, { lastActivity, now, queryUp }) {
  return Boolean(vc.room.enabled && queryUp && now - lastActivity > vc.room.quietOutMin * MIN);
}

/** S3: may a bot whose shift just ended stay for the conversation? */
export function overtimeOk(vc, { shiftEndedAt, now, talking }) {
  if (!talking) return false;
  if (!vc.room.enabled) return true; // the old behaviour: no cap
  return shiftEndedAt != null && now - shiftEndedAt < vc.room.overtimeMaxMin * MIN;
}
