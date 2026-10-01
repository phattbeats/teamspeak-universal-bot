import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { offCooldown, parseStep, pickScene, planScenes, takeoverEligible, tickChance } from '../story.mjs';

const scenes = JSON.parse(readFileSync(new URL('../live/scenes.json', import.meta.url)));
const lines = (bot) => JSON.parse(readFileSync(new URL(`../../personas/${bot}/lines.json`, import.meta.url)));
const has = (k) => Array.isArray(scenes[k]);
const BOTS = ['sexton', 'bexton', 'lexton'];
const ALL = [...BOTS, 'johnny', 'trixie']; // PHA-3842 guests can be in scenes too

test('midnight: Sexton out + Lexton in is one hand-off, Bexton just watches', () => {
  const r = planScenes({
    moves: [{ id: 'sexton', dir: 'stop', base: 'shift_end' }, { id: 'lexton', dir: 'start', base: 'shift_start' }],
    present: ['bexton'], hasScene: has,
  });
  assert.deepEqual(r.scenes, [{ key: 'handoff:sexton>lexton', start: 'lexton', stop: 'sexton' }]);
  assert.deepEqual(r.rest, []);
});

test('talk grace: a lingering Sexton still hands off to Lexton', () => {
  const r = planScenes({ moves: [{ id: 'lexton', dir: 'start', base: 'shift_start' }], lingering: ['sexton'], hasScene: has });
  assert.deepEqual(r.scenes, [{ key: 'handoff:sexton>lexton', start: 'lexton', stop: 'sexton' }]);
});

test('18:00 Bexton arrives on Sexton; 02:00 Bexton leaves on Lexton', () => {
  assert.deepEqual(planScenes({ moves: [{ id: 'bexton', dir: 'start', base: 'shift_start' }], present: ['sexton'], hasScene: has }).scenes,
    [{ key: 'arrive:bexton@sexton', start: 'bexton', partner: 'sexton' }]);
  assert.deepEqual(planScenes({ moves: [{ id: 'bexton', dir: 'stop', base: 'shift_end' }], present: ['lexton'], hasScene: has }).scenes,
    [{ key: 'leave:bexton@lexton', stop: 'bexton', partner: 'lexton' }]);
});

test('summons, dismissals and lonely shift changes keep their solo lines', () => {
  const moves = [{ id: 'bexton', dir: 'start', base: 'summon' }, { id: 'lexton', dir: 'stop', base: 'dismiss' }];
  assert.deepEqual(planScenes({ moves, present: ['sexton'], hasScene: has }).rest, moves);
  const alone = [{ id: 'lexton', dir: 'stop', base: 'shift_end' }];
  assert.deepEqual(planScenes({ moves: alone, present: [], hasScene: has }).rest, alone);
});

test('a bot is in at most one scene per tick', () => {
  const r = planScenes({
    moves: [{ id: 'bexton', dir: 'start', base: 'shift_start' }, { id: 'lexton', dir: 'start', base: 'shift_start' }],
    present: ['sexton'], hasScene: () => true,
  });
  assert.equal(r.scenes.length, 1);
  assert.equal(r.rest.length, 1);
});

test('tagged scene wins on its night; never the same variant twice running', () => {
  assert.equal(pickScene(scenes, 'handoff:sexton>lexton', 'newyear', () => 0).key, 'handoff:sexton>lexton:newyear');
  assert.equal(pickScene(scenes, 'handoff:sexton>lexton', 'lounge', () => 0).key, 'handoff:sexton>lexton');
  const mem = {};
  const a = pickScene(scenes, 'arrive:bexton@sexton', null, () => 0, mem).index;
  const b = pickScene(scenes, 'arrive:bexton@sexton', null, () => 0, mem).index;
  assert.notEqual(a, b);
  assert.equal(pickScene(scenes, 'nope', null), null);
});

test('every scene step parses, every takeover jails/releases, lines stay short', () => {
  for (const [key, list] of Object.entries(scenes)) {
    if (key.startsWith('_')) continue;
    for (const steps of list) {
      for (const raw of steps) {
        const s = parseStep(raw, ALL);
        assert.ok(s, `${key}: bad step ${JSON.stringify(raw)}`);
        if (s.do) assert.ok(['jail', 'release'].includes(s.do), `${key}: unknown action ${s.do}`);
        else assert.ok(s.line.length <= 160, `${key}: line too long for one breath: ${s.line}`);
      }
      const acts = steps.map((x) => x.do).filter(Boolean);
      if (key === 'takeover:start') assert.deepEqual(acts, ['jail']);
      if (key.startsWith('takeover:') && key !== 'takeover:start') assert.deepEqual(acts, ['release']);
    }
  }
});

test('every calendar pool and event pool has lines for the bots that use them', () => {
  const cal = JSON.parse(readFileSync(new URL('../live/calendar.json', import.meta.url)));
  for (const e of cal.entries.filter((x) => x.enabled !== false)) {
    for (const bot of BOTS) {
      const pool = e.bots?.[bot]?.pool ?? e.pool;
      if (!pool) continue;
      if (e.bots?.[bot]?.pool === undefined && !e.pool) continue;
      // shift_start is the line a night is remembered by; it must exist when a bot works that night.
      if (pool === 'lounge' && bot !== 'bexton') continue;
      const l = lines(bot);
      if (!l[`shift_start:${pool}`]) assert.ok(l.shift_start, `${bot}: no shift_start fallback`);
    }
  }
  assert.ok(lines('sexton').bender_news.length >= 3);
  assert.ok(lines('sexton')['bender_news:day2'].length >= 2);
  assert.ok(lines('bexton')['shift_start:bender_return'].length >= 3);
  for (const bot of BOTS) for (const [k, v] of Object.entries(lines(bot))) {
    for (const l of v) assert.doesNotMatch(l, /\b(Noted|Understood|Fair enough|Anytime|Happy to|No worries)\b/, `${bot}.${k}: help-desk word`);
  }
});

test('dice and cooldowns', () => {
  assert.equal(tickChance(20, 480), 20 / 60 / 480);
  assert.equal(tickChance(20, 0), 0);
  const day = 86_400_000;
  assert.equal(offCooldown(0, 18, 5), true);
  assert.equal(offCooldown(1000, 18, 1000 + 17 * day), false);
  assert.equal(offCooldown(1000, 18, 1000 + 18 * day), true);
});

test('takeover only when Sexton is working, Lexton is not, and people are watching', () => {
  const ok = {
    enabled: true, queryUp: true, active: false, humans: 3, minHumans: 2,
    targetRunning: true, targetOnShift: true, targetOverride: false, targetBusy: false, targetOnShiftAfter: true,
    villainRunning: false, villainOnShift: false, villainOverride: false, villainBusy: false, offCooldown: true,
  };
  assert.equal(takeoverEligible(ok), true);
  for (const [k, v] of [['humans', 1], ['targetOnShiftAfter', false], ['villainRunning', true], ['offCooldown', false], ['active', true], ['targetOverride', true]]) {
    assert.equal(takeoverEligible({ ...ok, [k]: v }), false, k);
  }
});
