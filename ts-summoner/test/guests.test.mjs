import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  candidates, guestConfig, guestIds, pickGuest, slotHolder, slotOpen, visitChance, visitLength, visitsThisWeek,
} from '../guests.mjs';
import { planScenes } from '../story.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const scenes = JSON.parse(readFileSync(new URL('../live/scenes.json', import.meta.url)));
const g = guestConfig(cfg.guests);
const H = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 2, 1, 0);
const open = (over = {}) => ({ queryUp: true, humans: 2, slotBusy: false, visits: [], special: false, now: NOW, ...over });

test('config: Johnny and Trixie are the guests, both share the guest container, neither has shifts', () => {
  assert.deepEqual(guestIds(cfg).sort(), ['johnny', 'trixie']);
  for (const id of guestIds(cfg)) {
    assert.equal(cfg.bots[id].container, 'guest');
    assert.deepEqual(cfg.bots[id].shifts, []);
    assert.deepEqual(cfg.bots[id].guest.needs, ['bexton']);
  }
});

test('the slot is open with people on and nothing recent', () => {
  assert.equal(slotOpen(g, open()), true);
});

test('closed: nobody on, query down, a guest already in', () => {
  assert.equal(slotOpen(g, open({ humans: 0 })), false);
  assert.equal(slotOpen(g, open({ queryUp: false })), false);
  assert.equal(slotOpen(g, open({ slotBusy: true })), false);
});

test('weekly cap, with one extra on a special night', () => {
  const visits = [NOW - 6 * 24 * H, NOW - 4 * 24 * H, NOW - 2 * 24 * H];
  assert.equal(visitsThisWeek(visits, NOW), 3);
  assert.equal(slotOpen(g, open({ visits })), false);
  assert.equal(slotOpen(g, open({ visits, special: true })), true);
  // A visit 8 days ago no longer counts.
  assert.equal(slotOpen(g, open({ visits: [NOW - 8 * 24 * H, ...visits.slice(1)] })), true);
});

test('minimum gap between visits, halved on a special night', () => {
  assert.equal(slotOpen(g, open({ visits: [NOW - 12 * H] })), false);
  assert.equal(slotOpen(g, open({ visits: [NOW - 12 * H], special: true })), true);
  assert.equal(slotOpen(g, open({ visits: [NOW - 21 * H] })), true);
});

test('the dice: about one visit per meanEligibleMin of eligible time, boosted on special nights', () => {
  const plain = visitChance(g, cfg.reconcileSec, false);
  assert.ok(Math.abs(plain - cfg.reconcileSec / 60 / g.meanEligibleMin) < 1e-12);
  assert.ok(Math.abs(visitChance(g, cfg.reconcileSec, true) - plain * g.specialBoost) < 1e-12);
});

test('Bexton nights only: no Bexton in the room, no guest', () => {
  assert.deepEqual(candidates(cfg, () => false), []);
  assert.deepEqual(candidates(cfg, (id) => id === 'sexton'), []);
  assert.deepEqual(candidates(cfg, (id) => id === 'bexton').sort(), ['johnny', 'trixie']);
});

test('weighted pick, and visit length inside 15-45', () => {
  assert.equal(pickGuest(cfg, ['johnny', 'trixie'], () => 0), 'johnny');
  assert.equal(pickGuest(cfg, ['johnny', 'trixie'], () => 0.99), 'trixie');
  assert.equal(pickGuest(cfg, [], () => 0), null);
  assert.equal(visitLength(g, cfg.bots.johnny, () => 0), 15);
  assert.equal(visitLength(g, cfg.bots.johnny, () => 1), 45);
});

test('one container, one guest: whoever is in or busy holds the slot', () => {
  assert.equal(slotHolder(cfg, { johnny: { running: true }, trixie: {} }, 'trixie'), 'johnny');
  assert.equal(slotHolder(cfg, { johnny: { busy: true }, trixie: {} }, 'trixie'), 'johnny');
  assert.equal(slotHolder(cfg, { johnny: {}, trixie: {} }, 'trixie'), null);
  assert.equal(slotHolder(cfg, { johnny: { running: true }, trixie: {} }, 'johnny'), null);
});

test('a guest dropping in on Bexton gets an arrive scene, and leaving one', () => {
  const has = (k) => Array.isArray(scenes[k]);
  for (const id of ['johnny', 'trixie']) {
    assert.deepEqual(planScenes({ moves: [{ id, dir: 'start', base: 'shift_start' }], present: ['bexton'], hasScene: has }).scenes,
      [{ key: `arrive:${id}@bexton`, start: id, partner: 'bexton' }]);
    assert.deepEqual(planScenes({ moves: [{ id, dir: 'stop', base: 'shift_end' }], present: ['bexton'], hasScene: has }).scenes,
      [{ key: `leave:${id}@bexton`, stop: id, partner: 'bexton' }]);
  }
});

test('guest scenes only use the guest and Bexton', () => {
  for (const [k, list] of Object.entries(scenes)) {
    if (!/johnny|trixie/.test(k)) continue;
    const id = k.match(/(johnny|trixie)/)[1];
    for (const sc of list) for (const step of sc) {
      const who = Object.keys(step)[0];
      assert.ok([id, 'bexton'].includes(who), `${k}: ${who}`);
    }
  }
});
