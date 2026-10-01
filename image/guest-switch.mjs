#!/usr/bin/env node
// PHA-3842 G1: put guest persona <id> in the chair of the shared `guest`
// container. ts-summoner runs this (docker exec) before every visit, with the
// TeamSpeak core stopped:
//
//   node /usr/local/bin/guest-switch.mjs johnny
//
// One container, many guests: the gateway, bridge and TS identity stay; what
// changes per visit is
//   - the agent the teamspeak channel is bound to (its workspace = the persona),
//   - wake names / excludes and the TTS voice (voiceId, pitch, speed),
//   - tools.moderation and tools.music, from the persona's tools.json,
//   - the core's nick and avatar (/config/.guest-env, read by run-sexton.sh).
//
// The persona packs are the ones image/Dockerfile bakes for every bot:
// /opt/sexton-persona/<id>/ (workspace files) and <id>.config/ (voice.json,
// tools.json, lines.json). A workspace that already exists is never
// overwritten, same rule as run-gateway.sh: live edits survive.
//
// Binding changes do not hot-reload (reference: sexton gateway config traps),
// so when the config actually changed the gateway is restarted and this waits
// for it to answer again. Same persona as last time: nothing to do, no restart.
//
// Prints one JSON line: {"ok":true,"guest":"johnny","changed":true,"nick":...}.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const id = (process.argv[2] || '').trim().toLowerCase();
const STATE = process.env.OPENCLAW_STATE_DIR || '/config/openclaw';
const CFG = process.env.OPENCLAW_CONFIG_PATH || `${STATE}/openclaw.json`;
const PERSONAS = process.env.GUEST_PERSONA_ROOT || '/opt/sexton-persona';
const AVATARS = process.env.GUEST_AVATAR_ROOT || '/usr/local/share/sexton-avatar';
const GUEST_FILE = process.env.GUEST_FILE || '/config/.guest';
const GUEST_ENV = process.env.GUEST_ENV_FILE || '/config/.guest-env';
const PORT = Number(process.env.SEXTON_GATEWAY_PORT || 18789);
const NO_RESTART = process.env.GUEST_SWITCH_NO_RESTART === '1'; // tests

const fail = (msg) => {
  console.log(JSON.stringify({ ok: false, guest: id, error: msg }));
  process.exit(1);
};
if (!/^[a-z][a-z0-9_-]*$/.test(id)) fail('usage: guest-switch.mjs <persona id>');
const personaDir = `${PERSONAS}/${id}`;
const configDir = `${personaDir}.config`;
if (!existsSync(personaDir)) fail(`no persona pack at ${personaDir}`);

const readJson = (p, fallback = {}) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};
const voice = readJson(`${configDir}/voice.json`);
const tools = readJson(`${configDir}/tools.json`);
const nick = voice.nick || id[0].toUpperCase() + id.slice(1);

// --- the workspace (seed once, like run-gateway.sh step 1c) ---
const ws = `${STATE}/workspace/agents/${id}`;
if (!existsSync(ws)) {
  mkdirSync(ws, { recursive: true });
  cpSync(personaDir, ws, { recursive: true });
}
if (!existsSync(`${ws}/lines.json`) && existsSync(`${configDir}/lines.json`)) {
  cpSync(`${configDir}/lines.json`, `${ws}/lines.json`);
}
if (!existsSync(`${ws}/moods.json`) && existsSync(`${configDir}/moods.json`)) {
  cpSync(`${configDir}/moods.json`, `${ws}/moods.json`);
}
if (!existsSync(`${ws}/mood/AGENTS.md`)) {
  mkdirSync(`${ws}/mood`, { recursive: true });
  writeFileSync(`${ws}/mood/AGENTS.md`, '# How today is going\n\nNothing special about today. Just dropping by.\n');
}
if (existsSync(`${personaDir}/HUMAN.md`)) {
  // PHA-3829: shared tone reaches the prompt only as an AGENTS.md-class file.
  mkdirSync(`${ws}/shared-tone`, { recursive: true });
  cpSync(`${personaDir}/HUMAN.md`, `${ws}/shared-tone/AGENTS.md`);
  writeFileSync(`${ws}/HUMAN.md`, '# HUMAN.md\n\nMoved to shared-tone/AGENTS.md (PHA-3829). OpenClaw only injects AGENTS.md-type files, so this file never reached the prompt.\n');
}

// --- the config ---
const cfg = readJson(CFG, null);
if (!cfg) fail(`cannot read ${CFG}`);
const before = JSON.stringify(cfg);

cfg.agents ??= {};
cfg.agents.entries ??= {};
const bound = (cfg.bindings || []).find((b) => b?.match?.channel === 'teamspeak')?.agentId;
if (!cfg.agents.entries[id]) {
  const donor = (bound && cfg.agents.entries[bound]) || Object.values(cfg.agents.entries)[0] || {};
  cfg.agents.entries[id] = {
    name: nick,
    workspace: ws,
    ...(donor.model ? { model: donor.model } : {}),
    identity: { name: nick },
    thinkingDefault: 'off',
    tools: { deny: ['process', 'sessions_spawn'] },
  };
}
if (bound !== id) {
  cfg.bindings = [
    ...(cfg.bindings || []).filter((b) => b?.match?.channel !== 'teamspeak'),
    { agentId: id, match: { channel: 'teamspeak', accountId: '*' } },
  ];
}

const ts = cfg.channels?.teamspeak;
if (!ts) fail('no channels.teamspeak block yet (first boot not finished?)');
ts.voice ??= {};
const names = Array.isArray(voice.wakeNames) && voice.wakeNames.length ? voice.wakeNames : [nick];
ts.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
ts.voice.wakeAliases = voice.wakeAliases || [];
ts.voice.excludeWakeNames = voice.excludeWakeNames || [];
ts.voice.streaming ??= {};
const speech = (ts.voice.streaming.speech ??= {});
for (const k of ['voiceId', 'pitch', 'speed']) {
  if (voice[k] === undefined || voice[k] === null) delete speech[k];
  else speech[k] = voice[k];
}
ts.tools ??= {};
ts.tools.moderation = tools.moderation || { kick: false, ban: false, edit: false, allowGroups: [] };
if (typeof tools.music?.enabled === 'boolean') {
  ts.tools.music ??= {};
  ts.tools.music.enabled = tools.music.enabled;
}

const changed = JSON.stringify(cfg) !== before;
if (changed) {
  writeFileSync(`${CFG}.tmp`, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${CFG}.tmp`, CFG);
}

// --- the core's face: nick + avatar, read by run-sexton.sh on its next start ---
const avatar = [`${configDir}/avatar.png`, `${AVATARS}/${id}.png`].find((p) => existsSync(p)) || '';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
writeFileSync(GUEST_ENV, `SEXTON_NICK=${q(nick)}\nSEXTON_AVATAR=${q(avatar)}\n`);
writeFileSync(GUEST_FILE, `${id}\n`);

// --- restart the gateway only if the config moved ---
if (changed && !NO_RESTART) {
  execFileSync('supervisorctl', ['restart', 'gateway'], { stdio: 'ignore' });
  const deadline = Date.now() + 120_000;
  let up = false;
  while (!up && Date.now() < deadline) {
    try {
      // Any HTTP answer (even 401) means it is listening; curl rc 7 = refused.
      execFileSync('curl', ['-sS', '-m', '3', '-o', '/dev/null', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });
      up = true;
    } catch {
      execFileSync('sleep', ['2']);
    }
  }
  if (!up) fail('gateway did not come back within 120s');
  // The listener is up a moment before the channel plugin has loaded its
  // account; give it that moment so the announcer is polling before the
  // summoner writes the entrance request.
  execFileSync('sleep', ['8']);
}

console.log(JSON.stringify({ ok: true, guest: id, changed, nick, avatar: avatar || null }));
