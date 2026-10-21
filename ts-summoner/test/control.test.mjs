// node --test ts-summoner/test  (no deps)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  applyTools, cleanShifts, personaHistory, readHistory, readPersona, readTools, scanSkills, writePersona, writeShifts,
} from '../control.mjs';

const live = () => ({
  agents: { entries: { sexton: { tools: { deny: ['process', 'sessions_spawn'], alsoAllow: ['web_search', 'web_fetch'] }, skills: ['weather'] } } },
  channels: { teamspeak: { accounts: { sexton: { tools: { music: { enabled: true }, band: { enabled: false, provider: 'x' }, moderation: { kick: true, ban: false, edit: false, allowGroups: ['Server Admin'] } } } } } },
});
const skills = new Map([['weather', { name: 'weather', description: '' }], ['summarize', { name: 'summarize', description: '' }]]);

test('readTools reports core, group and skill state per bot', () => {
  const t = readTools(live(), ['sexton'], skills).bots.sexton;
  assert.deepEqual(t.core, { web_search: 'on', web_fetch: 'on', process: 'off', sessions_spawn: 'off' });
  assert.equal(t.groups.music, true);
  assert.equal(t.groups.band, false);
  assert.equal(t.groups.mod_kick, true);
  assert.equal(t.groups.mod_ban, false);
  assert.deepEqual(t.skills, ['weather']);
});

test('core tools move between allow, deny and default without leaving dupes', () => {
  const c = live();
  applyTools(c, 'sexton', { core: { web_search: 'off', process: 'on' } }, skills);
  const t = c.agents.entries.sexton.tools;
  assert.deepEqual(t.alsoAllow, ['web_fetch', 'process']);
  assert.deepEqual(t.deny, ['sessions_spawn', 'web_search']);
  applyTools(c, 'sexton', { core: { web_search: 'default', web_fetch: 'default', process: 'default' } }, skills);
  assert.equal(c.agents.entries.sexton.tools.alsoAllow, undefined);
});

test('group toggles flip the plugin flags and refuse what the pack never configured', () => {
  const c = live();
  applyTools(c, 'sexton', { groups: { music: false, mod_ban: true, band: true } }, skills);
  const t = c.channels.teamspeak.accounts.sexton.tools;
  assert.equal(t.music.enabled, false);
  assert.equal(t.moderation.ban, true);
  assert.deepEqual(t.moderation.allowGroups, ['Server Admin']); // untouched
  assert.equal(t.band.enabled, true);
  assert.throws(() => applyTools(c, 'sexton', { groups: { nope: true } }, skills), /unknown tool group/);
  assert.throws(() => applyTools(c, 'sexton', { groups: { villain: true } }, skills), /villain settings/);
  assert.throws(() => applyTools(c, 'sexton', { groups: { music: 'yes' } }, skills), /true or false/);
});

test('skills: set a list, reject unknown names, null clears the allow-list', () => {
  const c = live();
  applyTools(c, 'sexton', { skills: ['weather', 'summarize'] }, skills);
  assert.deepEqual(c.agents.entries.sexton.skills, ['weather', 'summarize']);
  assert.throws(() => applyTools(c, 'sexton', { skills: ['rm-rf'] }, skills), /unknown skill/);
  applyTools(c, 'sexton', { skills: null }, skills);
  assert.equal(c.agents.entries.sexton.skills, undefined);
  assert.throws(() => applyTools(c, 'nobody', {}, skills), /unknown bot/);
});

test('scanSkills reads SKILL.md descriptions', () => {
  const d = mkdtempSync(`${tmpdir()}/skills-`);
  mkdirSync(`${d}/weather`);
  writeFileSync(`${d}/weather/SKILL.md`, "---\nname: weather\ndescription: 'Get the weather'\n---\n");
  mkdirSync(`${d}/notaskill`);
  assert.deepEqual([...scanSkills([d, '/nonexistent']).values()], [{ name: 'weather', description: 'Get the weather' }]);
});

test('persona saves keep history, validate JSON, and refuse odd names', () => {
  const d = mkdtempSync(`${tmpdir()}/persona-`);
  writeFileSync(`${d}/SOUL.md`, 'old soul\n');
  const backup = writePersona(d, 'SOUL.md', 'new soul');
  assert.equal(readPersona(d, 'SOUL.md'), 'new soul\n');
  assert.deepEqual(personaHistory(d, 'SOUL.md'), [backup]);
  assert.equal(readHistory(d, 'SOUL.md', backup), 'old soul\n');
  assert.throws(() => writePersona(d, '../x.md', 'x'), /not an editable/);
  assert.throws(() => writePersona(d, 'lines.json', '{nope'));
  assert.throws(() => writePersona(d, 'SOUL.md', '  '), /empty/);
  assert.throws(() => readHistory(d, 'SOUL.md', '../SOUL.md'), /bad version/);
});

test('cleanShifts accepts the config shapes and rejects bad times and days', () => {
  assert.deepEqual(cleanShifts([{ start: '08:00', end: '24:00' }]), [{ start: '08:00', end: '24:00' }]);
  assert.deepEqual(cleanShifts([{ start: '18:00', end: '02:00', days: [5, 1, 1] }]), [{ start: '18:00', end: '02:00', days: [1, 5] }]);
  assert.deepEqual(cleanShifts([{ start: '09:00', end: '12:00', days: [0, 1, 2, 3, 4, 5, 6] }]), [{ start: '09:00', end: '12:00' }]);
  assert.deepEqual(cleanShifts([]), []);
  assert.throws(() => cleanShifts([{ start: '8:00', end: '12:00' }]), /start must be/);
  assert.throws(() => cleanShifts([{ start: '24:00', end: '12:00' }]), /start must be/);
  assert.throws(() => cleanShifts([{ start: '08:00', end: '08:00' }]), /same time/);
  assert.throws(() => cleanShifts([{ start: '08:00', end: '12:00', days: [7] }]), /days must be/);
  assert.throws(() => cleanShifts('x'), /list/);
});

test('writeShifts edits one bot and keeps a backup', () => {
  const d = mkdtempSync(`${tmpdir()}/sched-`);
  const p = `${d}/config.json`;
  writeFileSync(p, JSON.stringify({ tz: 'UTC', bots: { a: { shifts: [] }, b: { shifts: [{ start: '01:00', end: '02:00' }] } } }));
  assert.equal(writeShifts(p, 'a', [{ start: '08:00', end: '09:00' }]), true);
  const out = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(out.bots.a.shifts, [{ start: '08:00', end: '09:00' }]);
  assert.deepEqual(out.bots.b.shifts, [{ start: '01:00', end: '02:00' }]);
  assert.deepEqual(JSON.parse(readFileSync(`${p}.ctl-bak`, 'utf8')).bots.a.shifts, []);
  assert.equal(writeShifts(p, 'zzz', []), false);
});

// #4374: the Bots tab's edits to bots.json.
import { addBot, cleanBot, editBot, listBots, nextFreePort, parseSupervisorStatus, removeBot, setBotEnabled } from '../control.mjs';

const botsFile = () => ({ bots: {
  sexton: { port: 9101 },
  lexton: { port: 9103, menace: true, noCatchup: true, noWelcome: true },
  johnny: { port: 9104, identity: 'guest', autostart: false, enabled: false },
  trixie: { port: 9105, identity: 'guest', autostart: false },
} });

test('cleanBot keeps the file small: defaults are dropped, text is trimmed, bad values are refused', () => {
  const f = botsFile();
  const e = cleanBot(f.bots, 'sexton', { nick: '  Sexton Prime ', channel: '', autostart: true, noCatchup: true, menace: false, env: { SEXTON_X: '1' }, port: 9110 });
  assert.deepEqual(e, { port: 9110, nick: 'Sexton Prime', noCatchup: true, env: { SEXTON_X: '1' } });
  assert.throws(() => cleanBot(f.bots, 'sexton', { port: 9103 }), /lexton's/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { port: 80 }), /1024 to 65535/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { env: { 'bad-name': 'x' } }), /UPPER_CASE/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { identity: 'Guest!' }), /lowercase/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { identity: 'lexton' }), /lexton's own/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { colour: 'red' }), /unknown bot setting/);
  assert.throws(() => cleanBot(f.bots, 'sexton', { menace: 'yes' }), /true or false/);
});

test('two enabled bots cannot share an identity', () => {
  const f = botsFile();
  assert.throws(() => setBotEnabled(f, 'johnny', true), /trixie/); // trixie holds 'guest'
  setBotEnabled(f, 'trixie', false);
  setBotEnabled(f, 'johnny', true);
  assert.equal(f.bots.johnny.enabled, undefined);
  assert.equal(f.bots.trixie.enabled, false);
  assert.throws(() => editBot(f, 'sexton', { identity: 'guest' }), /johnny/); // sexton is enabled, so is johnny now
  editBot(f, 'trixie', { identity: 'guest2' }); // a disabled bot may be re-pointed freely
  assert.throws(() => setBotEnabled(f, 'nobody', true), /unknown bot/);
});

test('add picks the next free port and clears the removed list; remove keeps the pack from coming back', () => {
  const f = botsFile();
  const gone = removeBot(f, 'lexton');
  assert.equal(gone.menace, true);
  assert.deepEqual(f.removed, ['lexton']);
  assert.throws(() => addBot(f, 'dexton', {}, ['lexton']), /no persona pack/);
  assert.throws(() => addBot(f, 'sexton', {}, ['sexton']), /already/);
  assert.equal(nextFreePort(f.bots), 9102);
  const e = addBot(f, 'lexton', { nick: 'Lexton II', menace: true }, ['lexton']);
  assert.deepEqual(e, { nick: 'Lexton II', menace: true, port: 9102 });
  assert.equal(f.removed, undefined);
});

test('listBots joins the file with packs, supervisor and the summoner', () => {
  const f = botsFile();
  const packs = { sexton: { dir: '/p/sexton', nick: 'The Sexton' }, lexton: { dir: '/p/lexton', nick: null }, johnny: { dir: '/p/johnny', nick: 'Rotten Johnny' }, trixie: { dir: '/p/trixie', nick: 'Trixie' }, dexton: { dir: '/p/dexton', nick: 'Dexton' } };
  const programs = parseSupervisorStatus('core-sexton    RUNNING   pid 12, uptime 1:00:00\ncore-lexton STOPPED Oct 21 01:00 AM\nmenace-lexton  BACKOFF  Exited too quickly\ncore-trixie STOPPED  not started\n');
  const l = listBots(f, packs, { programs, live: { bots: { sexton: { running: true } } }, accounts: { sexton: { voice: { mode: 'stt-tts' } }, lexton: { voice: { mode: 'off' } } } });
  const by = Object.fromEntries(l.bots.map((b) => [b.id, b]));
  assert.equal(by.sexton.nick, 'The Sexton');
  assert.equal(by.sexton.nickFromPack, true);
  assert.equal(by.lexton.nick, 'Lexton');
  assert.equal(by.sexton.core, 'RUNNING');
  assert.equal(by.sexton.live.running, true);
  assert.equal(by.lexton.menaceState, 'BACKOFF');
  assert.equal(by.lexton.voiceMode, 'off');
  assert.equal(by.johnny.core, 'ABSENT');
  assert.equal(by.johnny.enabled, false);
  assert.equal(by.johnny.clash, 'trixie');
  assert.equal(by.trixie.voiceMode, null);
  assert.deepEqual(l.available.map((p) => p.id), ['dexton']);
  assert.equal(l.nextPort, 9102);
});
