// node --test ts-summoner/test/*.mjs  (no deps)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { onShift, shiftAt } from '../schedule.mjs';
import { calledOut, isLate, jitterFor, overtimeOk, pickCover, quietOut, roll, varietyConfig } from '../variety.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const none = { entries: [] };
const ny = (s, off = '-04:00') => Date.parse(`${s}${off}`);
const MIN = 60_000;
const vc = varietyConfig(cfg.variety);

test('roll is stable and spread over [0, 1)', () => {
  assert.equal(roll('a'), roll('a'));
  const xs = Array.from({ length: 2000 }, (_, i) => roll(`k${i}`));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
});

test('jitter stays inside 0-45 and pushes the whole shift', () => {
  for (let i = 0; i < 500; i++) {
    const j = jitterFor(vc, `sexton@2026-10-${i}@08:00`);
    assert.ok(j.start >= 0 && j.start <= 45 && j.end >= 0 && j.end <= 45);
  }
  const fixed = () => ({ start: 30, end: 40 });
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-07T08:20:00'), fixed), false);
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-07T08:30:00'), fixed), true);
  // 24:00 + 40 min runs into the next date, still the 7th's shift
  const late = shiftAt(cfg, none, 'sexton', ny('2026-10-08T00:30:00'), fixed);
  assert.equal(late.key, 'sexton@2026-10-07@08:00');
  assert.equal(late.endTs, ny('2026-10-08T00:40:00'));
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-08T00:40:00'), fixed), false);
  // Bexton's midnight crosser: 02:00 + 40
  assert.equal(shiftAt(cfg, none, 'bexton', ny('2026-10-08T02:30:00'), fixed).key, 'bexton@2026-10-07@18:00');
  // no jitter = the old exact schedule
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-07T08:00:00')), true);
});

test('late only near a late start', () => {
  const sh = { lateMin: 30, startTs: ny('2026-10-07T08:30:00') };
  assert.equal(isLate(vc, sh, sh.startTs + 2 * MIN), true);
  assert.equal(isLate(vc, sh, sh.startTs + 20 * MIN), false); // back later in the shift
  assert.equal(isLate(vc, { ...sh, lateMin: 10 }, sh.startTs), false);
});

test('about one shift in ten calls out; special nights never do', () => {
  let n = 0;
  for (let i = 0; i < 3000; i++) if (calledOut(vc, { key: `bexton@d${i}@18:00`, calendar: false })) n++;
  assert.ok(n > 240 && n < 360, `${n}/3000`);
  const key = Array.from({ length: 200 }, (_, i) => `x${i}`).find((k) => calledOut(vc, { key: k }));
  assert.equal(calledOut(vc, { key, calendar: true }), false);
  assert.equal(calledOut(varietyConfig({ callout: { enabled: false } }), { key }), false);
});

test('cover is picked from the free bots, or nobody', () => {
  assert.equal(pickCover(vc, 'k', []), null);
  let covered = 0;
  for (let i = 0; i < 1000; i++) {
    const c = pickCover(vc, `k${i}`, ['sexton', 'lexton']);
    if (c) { covered++; assert.ok(['sexton', 'lexton'].includes(c)); }
  }
  assert.ok(covered > 640 && covered < 760, `${covered}/1000`);
});

test('quiet room: out after 30 min, never while the query is down', () => {
  const now = ny('2026-10-07T12:00:00');
  assert.equal(quietOut(vc, { lastActivity: now - 31 * MIN, now, queryUp: true }), true);
  assert.equal(quietOut(vc, { lastActivity: now - 29 * MIN, now, queryUp: true }), false);
  assert.equal(quietOut(vc, { lastActivity: now - 90 * MIN, now, queryUp: false }), false);
});

test('overtime: only while talking, capped at an hour', () => {
  const end = ny('2026-10-08T00:00:00');
  assert.equal(overtimeOk(vc, { shiftEndedAt: end, now: end + 59 * MIN, talking: true }), true);
  assert.equal(overtimeOk(vc, { shiftEndedAt: end, now: end + 61 * MIN, talking: true }), false);
  assert.equal(overtimeOk(vc, { shiftEndedAt: end, now: end + 5 * MIN, talking: false }), false);
});
