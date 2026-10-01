// node --test ts-summoner/test  (no deps)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { flavorFor, forcedEvents, local, matchesWhen, onShift, serviceDay, shiftsFor } from '../schedule.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const calendar = JSON.parse(readFileSync(new URL('../live/calendar.json', import.meta.url)));
const none = { entries: [] };
// New York wall clock -> epoch ms. October/November are EDT (-4) until Nov 1 2026 02:00, then EST (-5).
const ny = (s, off = '-04:00') => Date.parse(`${s}${off}`);

test('plain schedule matches the PHA-3821 shifts', () => {
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-07T23:59:00')), true);
  assert.equal(onShift(cfg, none, 'sexton', ny('2026-10-08T00:00:00')), false);
  assert.equal(onShift(cfg, none, 'lexton', ny('2026-10-08T00:00:00')), true);
  assert.equal(onShift(cfg, none, 'bexton', ny('2026-10-08T01:59:00')), true);
  assert.equal(onShift(cfg, none, 'bexton', ny('2026-10-08T02:00:00')), false);
  // Sun/Mon matinee
  assert.equal(onShift(cfg, none, 'bexton', ny('2026-10-04T10:00:00')), true); // Sunday
  assert.equal(onShift(cfg, none, 'bexton', ny('2026-10-06T10:00:00')), false); // Tuesday
});

test('Friday lounge: Bexton plays till four, Friday night only', () => {
  // Fri Oct 2 2026
  assert.equal(onShift(cfg, calendar, 'bexton', ny('2026-10-03T03:30:00')), true);
  assert.equal(onShift(cfg, calendar, 'bexton', ny('2026-10-03T04:00:00')), false);
  // Thursday night still ends at two
  assert.equal(onShift(cfg, calendar, 'bexton', ny('2026-10-02T03:00:00')), false);
  assert.equal(flavorFor(cfg, calendar, 'bexton', ny('2026-10-03T03:30:00')).pool, 'lounge');
  // Sexton gets no lounge pool (it's Bexton's entry only)
  assert.equal(flavorFor(cfg, calendar, 'sexton', ny('2026-10-02T20:00:00')).pool, null);
});

test('Halloween: Lexton at nine, halloween pool runs past midnight into Nov 1', () => {
  assert.equal(onShift(cfg, calendar, 'lexton', ny('2026-10-31T21:30:00')), true);
  assert.equal(onShift(cfg, calendar, 'lexton', ny('2026-10-30T21:30:00')), false);
  // 01:00 on Nov 1 is still EDT
  assert.equal(onShift(cfg, calendar, 'lexton', ny('2026-11-01T01:00:00')), true);
  assert.equal(flavorFor(cfg, calendar, 'sexton', ny('2026-11-01T00:00:00')).pool, 'halloween');
  assert.equal(flavorFor(cfg, calendar, 'sexton', ny('2026-11-01T07:00:00', '-05:00')).pool, null);
  // extraShifts keep the default 00:00-04:00 too (early hours of the 31st)
  assert.equal(onShift(cfg, calendar, 'lexton', ny('2026-10-31T01:00:00')), true);
});

test('Thanksgiving is the 4th Thursday of November', () => {
  assert.equal(matchesWhen({ month: 11, weekday: 'thu', nth: 4 }, local(ny('2026-11-26T12:00:00', '-05:00'), cfg.tz)), true);
  assert.equal(matchesWhen({ month: 11, weekday: 'thu', nth: 4 }, local(ny('2026-11-19T12:00:00', '-05:00'), cfg.tz)), false);
  assert.equal(matchesWhen({ month: 11, weekday: 'thu', nth: -1 }, local(ny('2026-11-26T12:00:00', '-05:00'), cfg.tz)), true);
});

test('ranges wrap the new year', () => {
  const p = (s) => local(ny(s, '-05:00'), cfg.tz);
  assert.equal(matchesWhen({ from: '12-30', to: '01-02' }, p('2027-01-01T12:00:00')), true);
  assert.equal(matchesWhen({ from: '12-30', to: '01-02' }, p('2026-12-29T12:00:00')), false);
});

test("New Year's Eve: midnight hand-off is still the newyear night", () => {
  assert.equal(flavorFor(cfg, calendar, 'lexton', ny('2027-01-01T00:00:00', '-05:00')).pool, 'newyear');
  assert.equal(onShift(cfg, calendar, 'bexton', ny('2027-01-01T03:30:00', '-05:00')), true);
});

test('disabled entries and an off day', () => {
  assert.equal(flavorFor(cfg, calendar, 'sexton', ny('2027-01-01T12:00:00', '-05:00')).pool, null);
  const cal = { entries: [{ id: 'x', when: { date: '10-07' }, bots: { sexton: { off: true } } }] };
  assert.deepEqual(shiftsFor(cfg, cal, 'sexton', local(ny('2026-10-07T12:00:00'), cfg.tz)).shifts, []);
  assert.equal(onShift(cfg, cal, 'sexton', ny('2026-10-07T12:00:00')), false);
});

test('vars and forced events come from the service day', () => {
  const cal = { entries: [{ id: 'kyle', when: { date: '10-07' }, pool: 'birthday', vars: { who: 'Kyle' }, events: ['takeover'] }] };
  const f = flavorFor(cfg, cal, 'lexton', ny('2026-10-08T01:00:00'));
  assert.equal(f.pool, 'birthday');
  assert.deepEqual(f.vars, { who: 'Kyle' });
  assert.deepEqual(forcedEvents(cfg, cal, ny('2026-10-08T01:00:00')), [{ event: 'takeover', entryId: 'kyle', day: '2026-10-07' }]);
  assert.equal(serviceDay(ny('2026-10-08T06:00:00'), cfg.tz).ymd, '2026-10-08');
});
