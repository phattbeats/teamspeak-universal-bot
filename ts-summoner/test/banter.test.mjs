import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { banterConfig, banterKey, banterOpen, isStreaming, pickBanter, playsOn } from '../banter.mjs';
import { parseStep } from '../story.mjs';

const scenes = JSON.parse(readFileSync(new URL('../live/scenes.json', import.meta.url)));
const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const bc = banterConfig(cfg.banter);
const has = (k) => Array.isArray(scenes[k]) && scenes[k].length > 0;
const MIN = 60_000;
const now = Date.UTC(2026, 9, 2, 2, 0);
const open = (x) => banterOpen(bc, { queryUp: true, humans: 2, lastTalk: now - 10 * MIN, stageBusy: false, plays: [], day: '2026-10-01', now, ...x });

test('every configured pair has several long-ish scripts, every step a real bot line', () => {
  for (const [a, b] of bc.pairs) {
    const list = scenes[banterKey(a, b)];
    assert.ok(Array.isArray(list) && list.length >= 5, `${a}+${b}`);
    for (const sc of list) {
      assert.ok(sc.length >= 8, `${a}+${b}: a bit should be extended, got ${sc.length} lines`);
      const who = new Set();
      for (const st of sc) {
        const p = parseStep(st, [a, b]);
        assert.ok(p?.line, `${a}+${b}: bad step ${JSON.stringify(st)}`);
        who.add(p.bot);
      }
      assert.equal(who.size, 2, `${a}+${b}: both talk`);
    }
  }
});

test('key is order-free', () => assert.equal(banterKey('sexton', 'bexton'), 'banter:bexton+sexton'));

test('no more than maxPerNight a night, with a gap between', () => {
  assert.equal(open({}), true);
  const two = [{ day: '2026-10-01', at: now - 300 * MIN }, { day: '2026-10-01', at: now - 200 * MIN }];
  assert.equal(playsOn(two, '2026-10-01'), 2);
  assert.equal(open({ plays: two }), false);
  assert.equal(open({ plays: [two[0]], day: '2026-10-02' }), true);
  assert.equal(open({ plays: [{ day: '2026-10-01', at: now - 10 * MIN }] }), false);
});

test('needs humans who are actually talking, and a free stage', () => {
  assert.equal(open({ humans: 0 }), false);
  assert.equal(open({ lastTalk: now - 60 * MIN }), false);
  assert.equal(open({ lastTalk: 0 }), false);
  assert.equal(open({ stageBusy: true }), false);
  assert.equal(open({ queryUp: false }), false);
});

test('only in a lull: nobody talked for quietMin, but somebody did within recentTalkMin', () => {
  assert.equal(open({ lastTalk: now - MIN }), false);
  assert.equal(open({ lastTalk: now - 4 * MIN }), false);
  assert.equal(open({ lastTalk: now - 5 * MIN }), true);
  assert.equal(open({ lastTalk: now - 40 * MIN }), true);
});

test('a streaming client is spotted from clientinfo', () => {
  assert.equal(isStreaming({ client_is_streaming: '1' }), true);
  assert.equal(isStreaming({ client_is_streaming: '0' }), false);
  assert.equal(isStreaming(undefined), false);
});

test('pair in the room beats a drop-in; Lexton can drop in on the Sexton', () => {
  const inRoom = new Set(['sexton', 'bexton']);
  const p = pickBanter(bc, { present: (i) => inRoom.has(i), canDrop: (i) => i === 'lexton', hasScene: has, random: () => 0 });
  assert.deepEqual(p, { key: 'banter:bexton+sexton', a: 'bexton', b: 'sexton', dropIn: null });
  const solo = pickBanter(bc, { present: (i) => i === 'sexton', canDrop: (i) => i === 'lexton', hasScene: has, random: () => 0 });
  assert.deepEqual(solo, { key: 'banter:lexton+sexton', a: 'lexton', b: 'sexton', dropIn: 'lexton' });
  assert.equal(pickBanter({ ...bc, dropIn: false }, { present: (i) => i === 'sexton', canDrop: () => true, hasScene: has }), null);
});

test('a pair already played tonight waits while another is possible', () => {
  const all = () => true;
  for (let r = 0; r < 1; r += 0.1) {
    const p = pickBanter(bc, { present: all, canDrop: () => false, hasScene: has, recent: ['banter:bexton+sexton'], random: () => r });
    assert.notEqual(p.key, 'banter:bexton+sexton');
  }
  const only = pickBanter(bc, { present: (i) => i !== 'lexton', canDrop: () => false, hasScene: has, recent: ['banter:bexton+sexton'] });
  assert.equal(only.key, 'banter:bexton+sexton');
});
