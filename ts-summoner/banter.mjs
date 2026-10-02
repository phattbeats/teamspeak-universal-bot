// PHA-3859: bot-on-bot banter. Pure functions; the summoner does the I/O.
// Tested in test/banter.test.mjs.
//
// Brandon loved the Johnny/Trixie introductions and wanted more of that:
// a couple of times a night, two of the regulars have a longer back-and-forth
// with each other, in character, on some topic. The scripts live in
// live/scenes.json under `banter:<a>+<b>` (ids sorted), so they're edited
// live like every other scene.
//
// The dice: while the room has humans who've talked recently and nothing
// else is on stage, every reconcile rolls a hazard-rate chance. A hard cap
// per night (service day, flips at 06:00) and a minimum gap keep it to "no
// more than a couple times a night". A pair that's both in the room is
// preferred; otherwise one of them can drop in for the bit and leave after
// (that's how Lexton and the Sexton ever share a room outside midnight).

import { tickChance } from './story.mjs';

const MIN = 60_000;

/** The `banter` block with defaults filled in. */
export function banterConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    maxPerNight: raw.maxPerNight ?? 2,
    minGapMin: raw.minGapMin ?? 75,
    meanEligibleMin: raw.meanEligibleMin ?? 150,
    minHumans: raw.minHumans ?? 1,
    recentTalkMin: raw.recentTalkMin ?? 20,
    dropIn: raw.dropIn !== false,
    pairs: Array.isArray(raw.pairs) ? raw.pairs : [['bexton', 'sexton'], ['bexton', 'lexton'], ['lexton', 'sexton']],
  };
}

/** scenes.json key for a pair, order-free. */
export const banterKey = (a, b) => `banter:${[a, b].sort().join('+')}`;

/** Plays on service day `day` ('YYYY-MM-DD'). */
export const playsOn = (plays, day) => (plays ?? []).filter((p) => p.day === day).length;

/**
 * May a bit start now? Plain values:
 *   { queryUp, humans, lastTalk (ms, voice or chat), stageBusy (another event,
 *     a scene, a guest), plays: [{ day, at, key }], day, now }
 */
export function banterOpen(bc, x) {
  if (!bc.enabled || !x.queryUp || x.stageBusy || x.humans < bc.minHumans) return false;
  if (!x.lastTalk || x.now - x.lastTalk > bc.recentTalkMin * MIN) return false;
  if (playsOn(x.plays, x.day) >= bc.maxPerNight) return false;
  const last = Math.max(0, ...(x.plays ?? []).map((p) => p.at));
  return !last || x.now - last >= bc.minGapMin * MIN;
}

export const banterChance = (bc, tickSec) => tickChance(tickSec, bc.meanEligibleMin);

/**
 * Which pair, and who (if anyone) drops in.
 *   present(id) -> in the room and free
 *   canDrop(id) -> out of the room and free to pop in for a few minutes
 *   hasScene(key) -> scenes.json has scripts for it
 *   recent: keys played tonight, avoided while another pair is possible
 * A pair that's already together is three times as likely as a drop-in.
 * Returns { key, a, b, dropIn: id|null } or null.
 */
export function pickBanter(bc, { present, canDrop, hasScene, recent = [], random = Math.random }) {
  const opts = [];
  for (const [a, b] of bc.pairs) {
    const key = banterKey(a, b);
    if (!hasScene(key)) continue;
    if (present(a) && present(b)) opts.push({ key, a, b, dropIn: null, w: 3 });
    else if (bc.dropIn && present(a) && canDrop(b)) opts.push({ key, a, b, dropIn: b, w: 1 });
    else if (bc.dropIn && present(b) && canDrop(a)) opts.push({ key, a, b, dropIn: a, w: 1 });
  }
  const fresh = opts.filter((o) => !recent.includes(o.key));
  const pool = fresh.length ? fresh : opts;
  const total = pool.reduce((s, o) => s + o.w, 0);
  let r = random() * total;
  for (const o of pool) {
    if ((r -= o.w) < 0) return { key: o.key, a: o.a, b: o.b, dropIn: o.dropIn };
  }
  return null;
}
