// PHA-3841: which two-bot scene a shift change gets, and the rare-event dice.
// Pure functions; the summoner does the I/O. Tested in test/story.test.mjs.

/**
 * Turns this tick's shift changes into scenes.
 *
 * moves:   [{ id, dir: 'start'|'stop', base }] where base is 'shift_start',
 *          'shift_end', 'summon' or 'dismiss'. Only shift_start/shift_end
 *          moves can become scenes; summons and dismissals keep their solo lines.
 * present: ids that are in the room and staying (running, wanted, not moving).
 * lingering: ids that are in the room past the end of their shift (talk grace).
 *          An arriving bot takes the hand-off from them, then they leave.
 * hasScene(key) -> bool, for the base key (no calendar tag).
 *
 * Returns { scenes: [{ key, start?, stop?, partner? }], rest: moves left solo }.
 * Precedence: handoff, then arrive, then leave. A bot is in at most one scene.
 */
export function planScenes({ moves, present = [], lingering = [], hasScene }) {
  const used = new Set();
  const scenes = [];
  const starts = moves.filter((m) => m.dir === 'start' && m.base === 'shift_start');
  const stops = moves.filter((m) => m.dir === 'stop' && m.base === 'shift_end');

  // Handoff: someone clocks in while someone else clocks out (same tick, or
  // still hanging around in talk grace).
  for (const s of starts) {
    const outs = [...stops.map((m) => m.id), ...lingering];
    for (const out of outs) {
      if (used.has(out) || used.has(s.id) || out === s.id) continue;
      const key = `handoff:${out}>${s.id}`;
      if (!hasScene(key)) continue;
      scenes.push({ key, start: s.id, stop: out });
      used.add(out); used.add(s.id);
    }
  }
  // Arrive: clocks in while someone is already working.
  for (const s of starts) {
    if (used.has(s.id)) continue;
    for (const p of present) {
      if (used.has(p)) continue;
      const key = `arrive:${s.id}@${p}`;
      if (!hasScene(key)) continue;
      scenes.push({ key, start: s.id, partner: p });
      used.add(s.id); used.add(p);
      break;
    }
  }
  // Leave: clocks out while someone stays.
  for (const m of stops) {
    if (used.has(m.id)) continue;
    for (const p of present) {
      if (used.has(p)) continue;
      const key = `leave:${m.id}@${p}`;
      if (!hasScene(key)) continue;
      scenes.push({ key, stop: m.id, partner: p });
      used.add(m.id); used.add(p);
      break;
    }
  }
  return { scenes, rest: moves.filter((m) => !used.has(m.id)) };
}

/** Steps for `key`, preferring the `key:tag` variant. Avoids repeating `lastIndex[key]`. */
export function pickScene(scenes, key, tag, random = Math.random, lastIndex = {}) {
  const variants = tag && Array.isArray(scenes?.[`${key}:${tag}`]) && scenes[`${key}:${tag}`].length
    ? { k: `${key}:${tag}`, list: scenes[`${key}:${tag}`] }
    : { k: key, list: scenes?.[key] };
  const list = Array.isArray(variants.list) ? variants.list.filter((s) => Array.isArray(s) && s.length) : [];
  if (!list.length) return null;
  let i = Math.floor(random() * list.length);
  if (list.length > 1 && i === lastIndex[variants.k]) i = (i + 1) % list.length;
  lastIndex[variants.k] = i;
  return { key: variants.k, index: i, steps: list[i] };
}

/** A scene step as { bot, line } or { do }. Unknown shapes come back null. */
export function parseStep(step, botIds) {
  if (!step || typeof step !== 'object') return null;
  if (typeof step.do === 'string') return { do: step.do };
  const bot = Object.keys(step).find((k) => botIds.includes(k));
  return bot && typeof step[bot] === 'string' ? { bot, line: step[bot] } : null;
}

/**
 * One reconcile tick's chance of a hazard-rate event, so that over
 * `meanMin` minutes of eligible time it fires once on average.
 */
export const tickChance = (tickSec, meanMin) => (meanMin > 0 ? Math.min(1, tickSec / 60 / meanMin) : 0);

const DAY_MS = 24 * 60 * 60_000;

/** Off cooldown? `lastAt` = when the event last started (ms, 0 = never). */
export const offCooldown = (lastAt, cooldownDays, now) => !lastAt || now - lastAt >= cooldownDays * DAY_MS;

/**
 * Takeover eligibility. Everything the dice need to know, as plain booleans and
 * numbers, so the rule is in one place:
 *   target (Sexton) in the room on his own shift, nobody overriding him;
 *   villain (Lexton) off and not scheduled; enough people to see it;
 *   enough shift left that the hour doesn't run into the target's shift end.
 */
export function takeoverEligible(x) {
  return Boolean(
    x.enabled && x.queryUp && !x.active && x.humans >= x.minHumans
    && x.targetRunning && x.targetOnShift && !x.targetOverride && !x.targetBusy
    && x.targetOnShiftAfter
    && !x.villainRunning && !x.villainOnShift && !x.villainOverride && !x.villainBusy
    && x.offCooldown,
  );
}
