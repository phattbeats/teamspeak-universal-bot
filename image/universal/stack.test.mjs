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

function stack(root, mode) {
  return execFileSync('node', [join(here, 'stack.mjs'), mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
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
  assert.deepEqual(Object.keys(bots), ['sexton', 'bexton', 'lexton', 'johnny', 'trixie']);
  assert.deepEqual(Object.values(bots).map((b) => b.port), [9101, 9102, 9103, 9104, 9105]);
  const conf = readFileSync(`${root}/run/bots.conf`, 'utf8');
  for (const id of Object.keys(bots)) assert.match(conf, new RegExp(`\\[program:core-${id}\\]`));
  assert.match(conf, /\[program:menace-lexton\]/);
  assert.match(conf, /SEXTON_IDENTITY_FILE="[^"]*\/bots\/guest\/sexton-id.txt"[^\n]*\nautostart=false/);
  assert.match(conf, /SEXTON_NICK="Rotten Johnny"/);
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
  assert.equal(bots.dexton.port, 9106);
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
