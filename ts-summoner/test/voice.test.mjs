// #4372: the voice kill switch behind POST /voice/off and POST /voice/on.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canBeHeard, createVoiceSwitch } from '../voice.mjs';

const fresh = () => {
  const offFile = join(mkdtempSync(join(tmpdir(), 'voice-')), '.voice-off');
  const calls = [];
  const sw = createVoiceSwitch({ offFile, exec: async (cmd) => { calls.push(cmd.join(' ')); return `${cmd[2]}: ${cmd[1]}ed`; } });
  return { offFile, calls, sw };
};

test('off writes the file and stops whisper; on removes it and starts whisper', async () => {
  const { offFile, calls, sw } = fresh();
  assert.equal(sw.state(), 'on');
  const off = await sw.off('sexton for Brandon');
  assert.deepEqual([off.voice, off.changed, off.by], ['off', true, 'sexton for Brandon']);
  assert.ok(existsSync(offFile));
  assert.equal(sw.state(), 'off');
  const on = await sw.on();
  assert.deepEqual([on.voice, on.changed], ['on', true]);
  assert.ok(!existsSync(offFile));
  assert.deepEqual(calls, ['supervisorctl stop whisper', 'supervisorctl start whisper']);
});

test('a repeat is idempotent and says so; whisper is still told each time', async () => {
  const { calls, sw } = fresh();
  await sw.off();
  const again = await sw.off();
  assert.equal(again.changed, false);
  assert.equal(sw.isOff(), true);
  const on1 = await sw.on();
  const on2 = await sw.on();
  assert.deepEqual([on1.changed, on2.changed], [true, false]);
  assert.deepEqual(calls, ['supervisorctl stop whisper', 'supervisorctl stop whisper', 'supervisorctl start whisper', 'supervisorctl start whisper']);
});

test('a supervisorctl failure never loses the file change', async () => {
  const offFile = join(mkdtempSync(join(tmpdir(), 'voice-')), '.voice-off');
  const sw = createVoiceSwitch({ offFile, program: 'ears', exec: async () => { throw new Error('socket gone'); } });
  const off = await sw.off();
  assert.equal(off.voice, 'off');
  assert.match(off.whisper, /stop ears failed: socket gone/);
  assert.ok(existsSync(offFile));
});

// Brandon (2026-10-23): voice off "needs to also affect intro/outros, the
// random conversations, etc. they should make 0 voices".
test('canBeHeard: voice off is nobody listening, whoever is on the server', () => {
  const room = { queryUp: true, humans: 3 };
  assert.equal(canBeHeard(room), true);
  assert.equal(canBeHeard({ ...room, voiceOff: true }), false);
  assert.equal(canBeHeard({ ...room, humans: 0 }), false);
  assert.equal(canBeHeard({ ...room, queryUp: false }), false);
  assert.equal(canBeHeard({ ...room, announceEnabled: false }), false);
});
