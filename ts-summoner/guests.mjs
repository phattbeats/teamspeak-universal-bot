// PHA-3842 G1: the guest-star slot. Pure functions; the summoner does the I/O.
// Tested in test/guests.test.mjs.
//
// Guests (Rotten Johnny, Trixie, ...) are bots in config.json with a `guest`
// block and no shifts. They all share ONE container, so at most one is ever
// in the room. Nobody schedules them: while the slot is open, the summoner
// rolls dice every reconcile, and a hit starts a 15-45 minute visit.
//
// Cost (PHA-3597) is bounded by construction: one guest at a time, a hard
// weekly cap, a minimum gap between visits, only while humans are on the
// server (the summoner already ends every summons on an empty server), and
// only while one of the guest's `needs` bots is in the room. Johnny and
// Trixie need Bexton: they drop in on Bexton nights.

import { tickChance } from './story.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

/** The `guests` block with defaults filled in. */
export function guestConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    visitMin: Array.isArray(raw.visitMin) ? raw.visitMin : [15, 45],
    meanEligibleMin: raw.meanEligibleMin ?? 240,
    maxPerWeek: raw.maxPerWeek ?? 3,
    specialNightExtra: raw.specialNightExtra ?? 1,
    specialBoost: raw.specialBoost ?? 3,
    minGapHours: raw.minGapHours ?? 20,
    minHumans: raw.minHumans ?? 1,
  };
}

/** Ids of the bots that are guests. */
export const guestIds = (cfg) => Object.keys(cfg.bots).filter((id) => cfg.bots[id].guest);

/** Visits started in the last 7 days. */
export const visitsThisWeek = (visits, now) => (visits ?? []).filter((t) => now - t < WEEK).length;

/**
 * May a visit start now? Everything as plain values:
 *   { queryUp, humans, slotBusy (a guest is in or getting in), visits: [ts], special, now }
 * A special night (calendar pool tonight) allows `specialNightExtra` more per
 * week and halves the gap, so a Friday lounge can get a guest even after a
 * Wednesday one.
 */
export function slotOpen(g, x) {
  if (!g.enabled || !x.queryUp || x.slotBusy || x.humans < g.minHumans) return false;
  const cap = g.maxPerWeek + (x.special ? g.specialNightExtra : 0);
  if (visitsThisWeek(x.visits, x.now) >= cap) return false;
  const last = Math.max(0, ...(x.visits ?? []));
  const gap = (x.special ? g.minGapHours / 2 : g.minGapHours) * HOUR;
  return !last || x.now - last >= gap;
}

/** This tick's chance of a visit, boosted on special nights. */
export const visitChance = (g, tickSec, special) => Math.min(1, tickChance(tickSec, g.meanEligibleMin) * (special ? g.specialBoost : 1));

/**
 * Guests who could walk in now: `needs` (any of) is in the room.
 * `inRoom(id)` -> bool. A guest with no `needs` can visit any time.
 */
export function candidates(cfg, inRoom) {
  return guestIds(cfg).filter((id) => {
    const needs = cfg.bots[id].guest.needs ?? [];
    return !needs.length || needs.some(inRoom);
  });
}

/** Weighted pick (`guest.weight`, default 1). */
export function pickGuest(cfg, ids, random = Math.random) {
  if (!ids.length) return null;
  const w = ids.map((id) => Math.max(0, cfg.bots[id].guest.weight ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let r = random() * total;
  for (let i = 0; i < ids.length; i++) {
    r -= w[i];
    if (r < 0) return ids[i];
  }
  return ids[ids.length - 1];
}

/** Visit length in minutes, uniform over `visitMin` (bot's own wins). */
export function visitLength(g, bot, random = Math.random) {
  const [lo, hi] = bot.guest?.visitMin ?? g.visitMin;
  return Math.round(lo + random() * Math.max(0, hi - lo));
}

/**
 * The other guest holding the shared container, if any: running or busy
 * (mid-switch, mid-goodbye). `st` = summoner state by id.
 */
export function slotHolder(cfg, st, id) {
  const container = cfg.bots[id].container;
  return guestIds(cfg).find((o) => o !== id && cfg.bots[o].container === container && (st[o]?.running || st[o]?.busy)) ?? null;
}
