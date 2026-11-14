// #3791: the one-container wiring, run against the repo's own persona packs.
//   node --test image/universal/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

function stack(root, mode, extraEnv = {}) {
  return execFileSync('node', [join(here, 'stack.mjs'), mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UNIVERSAL_VOICE: '1',
      ...extraEnv,
      UNIVERSAL_CONFIG_DIR: `${root}/config`,
      UNIVERSAL_RUN_DIR: `${root}/run`,
      UNIVERSAL_PERSONA_ROOT: join(repo, 'personas'),
      UNIVERSAL_SEED: join(repo, 'image', 'gateway', 'openclaw.seed.json'),
      UNIVERSAL_SUMMONER_DEFAULTS: join(repo, 'ts-summoner'),
      SEXTON_LOG_DIR: `${root}/logs`,
      OPENCLAW_STATE_DIR: `${root}/config/openclaw`,
      OPENCLAW_CONFIG_PATH: `${root}/config/openclaw/openclaw.json`,
    },
  });
}
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'universal-'));
  mkdirSync(`${root}/config/openclaw`, { recursive: true });
  writeFileSync(`${root}/config/openclaw/openclaw.json`, JSON.stringify({
    agents: { entries: { main: { name: 'Ledger', workspace: '/root/.openclaw/workspace/agents/ledger' } } },
    bindings: [{ agentId: 'sexton', match: { channel: 'teamspeak', accountId: '*' } }],
    channels: { teamspeak: { bridgeUrl: 'ws://127.0.0.1:9099', voice: {} } },
  }));
  return root;
}

test('supervisor: one core per pack, guests share an identity and never autostart', () => {
  const root = fresh();
  stack(root, 'supervisor');
  const bots = json(`${root}/config/bots.json`).bots;
  assert.deepEqual(Object.keys(bots), ['sexton', 'bexton', 'lexton', 'johnny', 'trixie', 'ledger']);
  assert.deepEqual(Object.values(bots).map((b) => b.port), [9101, 9102, 9103, 9104, 9105, 9106]);
  // PHA-4364: the transport-only Ledger pack joins switched off, with no core.
  assert.deepEqual(bots.ledger, { externalGateway: true, enabled: false, port: 9106 });
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  for (const id of Object.keys(bots).filter((id) => id !== 'ledger')) assert.match(conf, new RegExp(`\\[program:core-${id}\\]`));
  assert.doesNotMatch(conf, /\[program:core-ledger\]/);
  assert.match(conf, /\[program:menace-lexton\]/);
  assert.match(conf, /SEXTON_IDENTITY_FILE="[^"]*\/bots\/guest\/sexton-id.txt"[^\n]*\nautostart=false/);
  assert.match(conf, /SEXTON_NICK="Rotten Johnny \[BOT\]"/); // TS shows the bot tag
  const summoner = json(`${root}/run/summoner.json`);
  assert.equal(summoner.local, true);
  assert.equal(summoner.bots.bexton.program, 'core-bexton');
  assert.equal(summoner.bots.johnny.container, summoner.bots.trixie.container);
  assert.match(summoner.query.passFile, /summoner\/query-pass.txt$/);
});

test('supervisor: a new pack is picked up with the next free port; ports never move', () => {
  const root = fresh();
  stack(root, 'supervisor');
  mkdirSync(`${root}/config/personas/dexton`, { recursive: true });
  writeFileSync(`${root}/config/personas/dexton/voice.json`, '{"wakeNames":["Dexton"]}');
  stack(root, 'supervisor');
  const bots = json(`${root}/config/bots.json`).bots;
  assert.equal(bots.dexton.port, 9107);
  assert.equal(bots.sexton.port, 9101);
  assert.equal(json(`${root}/run/summoner.json`).bots.dexton.shifts[0].end, '24:00');
});

test('gateway: an account, agent and binding per bot; wiring follows bots.json', () => {
  const root = fresh();
  stack(root, 'supervisor');
  stack(root, 'gateway');
  const cfg = json(`${root}/config/openclaw/openclaw.json`);
  const ts = cfg.channels.teamspeak;
  assert.deepEqual(Object.keys(ts), ['accounts']); // the old top-level account is gone
  assert.equal(ts.accounts.bexton.bridgeUrl, 'ws://127.0.0.1:9102');
  assert.equal(ts.accounts.bexton.tools.summoner.self, 'bexton');
  assert.equal(ts.accounts.bexton.tools.band.sunoApi.baseUrl, 'http://127.0.0.1:3000');
  assert.match(ts.accounts.bexton.tools.announce.requestFile, /bots\/bexton\/.announce$/);
  assert.equal(ts.accounts.lexton.tools.villain.enabled, true);
  assert.equal(ts.accounts.johnny.voice.streaming.speech.pitch, -3);
  assert.equal(ts.accounts.sexton.voice.streaming.transcription.url, 'http://127.0.0.1:8082/inference');
  const tsBindings = cfg.bindings.filter((b) => b.match.channel === 'teamspeak');
  assert.equal(tsBindings.length, 5);
  assert.deepEqual(tsBindings.find((b) => b.agentId === 'trixie').match, { channel: 'teamspeak', accountId: 'trixie' });
  assert.ok(cfg.agents.entries.lexton.workspace.endsWith('/workspace/agents/lexton'));
  assert.deepEqual(cfg.agents.entries.sexton.tools.alsoAllow, ['web_search', 'web_fetch']);
  assert.ok(existsSync(`${root}/config/openclaw/workspace/agents/trixie/SOUL.md`));
  assert.ok(existsSync(`${root}/config/openclaw/workspace/agents/trixie/shared-tone/AGENTS.md`));

  // Tuning is the operator's after first boot; wiring is not.
  ts.accounts.bexton.voice.wakeNames = ['Bex'];
  ts.accounts.bexton.bridgeUrl = 'ws://elsewhere:1';
  writeFileSync(`${root}/config/openclaw/openclaw.json`, JSON.stringify(cfg));
  stack(root, 'gateway');
  const again = json(`${root}/config/openclaw/openclaw.json`).channels.teamspeak.accounts.bexton;
  assert.deepEqual(again.voice.wakeNames, ['Bex']);
  assert.equal(again.bridgeUrl, 'ws://127.0.0.1:9102');
});

test('gateway: a bot switched off in bots.json keeps its account, disabled', () => {
  const root = fresh();
  stack(root, 'supervisor');
  stack(root, 'gateway');
  const file = json(`${root}/config/bots.json`);
  file.bots.trixie.enabled = false;
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'gateway');
  const cfg = json(`${root}/config/openclaw/openclaw.json`);
  assert.equal(cfg.channels.teamspeak.accounts.trixie.enabled, false);
  assert.equal(cfg.channels.teamspeak.accounts.sexton.enabled, undefined);
  assert.ok(!cfg.bindings.some((b) => b.agentId === 'trixie'));
});

// #4372: the voice kill switch at the stack level.
test('voice: every account and the summoner are wired to the one kill-switch file; cores keep their audio', () => {
  const root = fresh();
  stack(root, 'supervisor');
  stack(root, 'gateway');
  const cfg = json(`${root}/config/openclaw/openclaw.json`);
  for (const a of Object.values(cfg.channels.teamspeak.accounts)) assert.equal(a.voice.offFile, `${root}/config/.voice-off`);
  assert.equal(cfg.channels.teamspeak.accounts.sexton.voice.mode, 'stt-tts'); // the seed's, untouched
  assert.deepEqual(json(`${root}/run/summoner.json`).voice, { offFile: `${root}/config/.voice-off`, whisperProgram: 'whisper' });
  assert.ok(!existsSync(`${root}/config/.voice-off`));
  assert.doesNotMatch(readFileSync(`${root}/run/bots.conf`, 'utf8'), /SEXTON_NO_AUDIO/);
});

test('voice: UNIVERSAL_VOICE=0 writes the kill-switch file and starts every core with no audio', () => {
  const root = fresh();
  const out = stack(root, 'supervisor', { UNIVERSAL_VOICE: '0' });
  assert.match(out, /voice OFF/);
  assert.ok(existsSync(`${root}/config/.voice-off`));
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  const cores = conf.match(/\[program:core-/g).length;
  assert.equal(conf.match(/SEXTON_NO_AUDIO="1"/g).length, cores);
  // A pinned account stays pinned; the switch never rewrites voice.mode.
  stack(root, 'gateway', { UNIVERSAL_VOICE: '0' });
  const cfg = json(`${root}/config/openclaw/openclaw.json`);
  cfg.channels.teamspeak.accounts.lexton.voice.mode = 'off';
  writeFileSync(`${root}/config/openclaw/openclaw.json`, JSON.stringify(cfg));
  stack(root, 'gateway', { UNIVERSAL_VOICE: '1' });
  const again = json(`${root}/config/openclaw/openclaw.json`).channels.teamspeak.accounts;
  assert.equal(again.lexton.voice.mode, 'off');
  assert.equal(again.lexton.voice.offFile, `${root}/config/.voice-off`);
  // The file outlives the env switch: voice stays off until POST /voice/on.
  assert.match(stack(root, 'supervisor', { UNIVERSAL_VOICE: '1' }), /voice OFF .*exists/);
});

// #4374: the dashboard edits bots.json while the stack is up and runs `rewire`.
test('rewire: bots.conf and the gateway follow bots.json; a removed bot stays removed, add brings it back', () => {
  const root = fresh();
  stack(root, 'supervisor');
  stack(root, 'gateway');
  const file = json(`${root}/config/bots.json`);
  file.bots.trixie.channel = 'Lounge';
  file.bots.trixie.env = { SEXTON_EXTRA: 'x' };
  delete file.bots.lexton;
  file.removed = ['lexton'];
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'rewire');
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  assert.match(conf, /SEXTON_CHANNEL="Lounge"/);
  assert.match(conf, /SEXTON_EXTRA="x"/);
  assert.doesNotMatch(conf, /core-lexton/);
  assert.doesNotMatch(conf, /menace-lexton/);
  const again = json(`${root}/config/bots.json`);
  assert.equal(again.bots.lexton, undefined); // the pack is still on disk, but it is not re-added
  assert.equal(again.bots.trixie.port, 9105); // ports never move
  const cfg = json(`${root}/config/openclaw/openclaw.json`);
  assert.equal(cfg.channels.teamspeak.accounts.lexton.enabled, false); // switched off, not deleted
  assert.ok(!cfg.bindings.some((b) => b.agentId === 'lexton'));
  assert.equal(json(`${root}/run/summoner.json`).bots.lexton, undefined);
  // Add it back the way the tab does: an entry, no port.
  again.bots.lexton = { menace: true };
  delete again.removed;
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(again));
  stack(root, 'rewire');
  assert.equal(json(`${root}/config/bots.json`).bots.lexton.port, 9103);
  assert.match(readFileSync(`${root}/run/bots.conf`, 'utf8'), /\[program:menace-lexton\]/);
  assert.equal(json(`${root}/config/openclaw/openclaw.json`).channels.teamspeak.accounts.lexton.enabled, undefined);
  assert.deepEqual(JSON.parse(stack(root, 'packs')).lexton, join(repo, 'personas', 'lexton'));
});

// #4875: address and channel come from bots.json (bot entry, then the `server` block); nothing is baked in.
test('server block: bots inherit address, port, channel and fallback; a bot entry overrides; chatLog follows', () => {
  const root = fresh();
  stack(root, 'supervisor', { SEXTON_ADDR: '', SEXTON_CHANNEL: '' });
  const file = json(`${root}/config/bots.json`);
  file.server = { address: 'ts.example.net', port: 9988, channel: 'Lobby', fallbackChannel: 'Spare', query: { host: '100.1.2.3', port: 10022 } };
  file.bots.bexton.address = 'other.example.net';
  file.bots.bexton.channel = 'Side Room';
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'rewire', { SEXTON_ADDR: '', SEXTON_CHANNEL: '' });
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  const core = (id) => conf.split('[program:').find((c) => c.startsWith(`core-${id}]`));
  assert.match(core('sexton'), /SEXTON_ADDR="ts.example.net"/);
  assert.match(core('sexton'), /SEXTON_PORT="9988"/);
  assert.match(core('sexton'), /SEXTON_CHANNEL="Lobby"/);
  assert.match(core('sexton'), /SEXTON_FALLBACK_CHANNEL="Spare"/);
  assert.match(core('bexton'), /SEXTON_ADDR="other.example.net"/);
  assert.match(core('bexton'), /SEXTON_CHANNEL="Side Room"/);
  const sum = json(`${root}/run/summoner.json`);
  assert.equal(sum.query.host, '100.1.2.3');
  assert.ok(!/General Shit/.test(JSON.stringify(sum)));
  assert.ok(sum.chatLog.dir.endsWith(`/${sum.chatLog.whenOff}/Lobby`));
});

// Solo mode: one bot around the clock, summoner idle; an overlay that `solo off` undoes exactly.
test('solo: only that bot runs and autostarts, the summoner idles, and off restores the roster untouched', () => {
  const root = fresh();
  stack(root, 'supervisor');
  const before = json(`${root}/config/bots.json`).bots;
  execFileSync('node', [join(here, 'stack.mjs'), 'solo', 'johnny'], { encoding: 'utf8', env: { ...process.env, UNIVERSAL_VOICE: '1', UNIVERSAL_CONFIG_DIR: `${root}/config`, UNIVERSAL_RUN_DIR: `${root}/run`, UNIVERSAL_PERSONA_ROOT: join(repo, 'personas'), UNIVERSAL_SEED: join(repo, 'image', 'gateway', 'openclaw.seed.json'), UNIVERSAL_SUMMONER_DEFAULTS: join(repo, 'ts-summoner'), SEXTON_LOG_DIR: `${root}/logs`, OPENCLAW_STATE_DIR: `${root}/config/openclaw`, OPENCLAW_CONFIG_PATH: `${root}/config/openclaw/openclaw.json` } });
  let conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  assert.deepEqual([...conf.matchAll(/\[program:core-(\w+)\]/g)].map((m) => m[1]), ['johnny']);
  assert.match(conf.split("[program:core-johnny]")[1], /\nautostart=true\n/); // guests normally never autostart
  assert.ok(existsSync(`${root}/config/.summoner-off`));
  assert.deepEqual(json(`${root}/config/bots.json`).bots, before);
  const file = json(`${root}/config/bots.json`);
  delete file.solo;
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'rewire');
  conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  assert.equal([...conf.matchAll(/\[program:core-/g)].length, 5);
  assert.ok(!existsSync(`${root}/config/.summoner-off`));
});

test('PHA-4917: dm settings reach each core as env, per bot over stack-wide, aliases honoured', () => {
  const root = fresh();
  stack(root, 'supervisor');
  const file = json(`${root}/config/bots.json`);
  file.dm = { cooldownMin: 90, maxLines: 10 };
  file.bots.sexton.dm = { cooldownMin: 30, quietNotice: true };
  file.server = { ...file.server, timezone: 'America/New_York' };
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'supervisor');
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  const prog = (id) => conf.split('[program:').find((p) => p.startsWith(`core-${id}]`));
  const sexton = prog('sexton');
  assert.match(sexton, /SEXTON_DM_COOLDOWN_MIN="30"/);
  assert.match(sexton, /SEXTON_DM_QUIET_NOTICE="1"/);
  assert.match(sexton, /SEXTON_DM_MAX_LINES="10"/);
  assert.match(sexton, /SEXTON_WELCOME_FILE="[^"]*personas\/sexton\/welcome.json"/);
  assert.match(sexton, /TZ="America\/New_York"/);
  assert.match(prog('bexton'), /SEXTON_DM_COOLDOWN_MIN="90"/);
  assert.match(prog('lexton'), /SEXTON_DM_WELCOME="0"/, 'noWelcome is an alias for dm.welcome=false');
  assert.match(prog('lexton'), /SEXTON_DM_CATCHUP="0"/);
});

test('PHA-4102: a phattId block reaches only that core as env; the secret is never written to bots.conf', () => {
  const root = fresh();
  stack(root, 'supervisor');
  const file = json(`${root}/config/bots.json`);
  file.bots.sexton.phattId = { arcadeUrl: 'https://arcade.example', serverGroup: 42, vipGroup: 11 };
  file.bots.bexton.phattId = { arcadeUrl: 'https://arcade.example', kid: 'teamspeak2' };
  writeFileSync(`${root}/config/bots.json`, JSON.stringify(file));
  stack(root, 'rewire', { ARCADE_SURFACE_SECRET: 'do-not-write-me', ARCADE_URL: 'https://container.example' });
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  const prog = (id) => conf.split('[program:').find((p) => p.startsWith(`core-${id}]`));
  assert.match(prog('sexton'), /ARCADE_URL="https:\/\/arcade.example",ARCADE_SURFACE_KID="teamspeak1",PHATT_ID_SERVER_GROUP="42",PHATT_ID_VIP_GROUP="11"/);
  assert.match(prog('bexton'), /ARCADE_SURFACE_KID="teamspeak2",PHATT_ID_SERVER_GROUP=""/);
  // No block: linking explicitly off, whatever the container env says.
  assert.match(prog('lexton'), /ARCADE_URL="",ARCADE_SURFACE_KID="",PHATT_ID_SERVER_GROUP="",PHATT_ID_VIP_GROUP=""/);
  assert.doesNotMatch(conf, /do-not-write-me|ARCADE_SURFACE_SECRET/);
});
