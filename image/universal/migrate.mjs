#!/usr/bin/env node
// PHA-3791: one-time move from the per-bot containers (sexton, bexton, lexton,
// guest) and the sidecars (ts-summoner, suno-api) to the one container.
//
// Run inside the new image, with the old appdata root and the new one mounted:
//   docker run --rm --entrypoint node \
//     -v /mnt/user/appdata:/old:ro -v /mnt/user/appdata/teamspeak-universal-bot:/new \
//     phattbeats/teamspeak-universal-bot:<tag> /opt/universal/migrate.mjs
//
// Read-only on the old side. Refuses to run over an existing new config.
// What carries over:
//   - sexton's openclaw.json as the base (models, auth, tts, env, tools, hooks,
//     agents.defaults), plus each bot's own agent entry from its own config;
//   - each bot's channels.teamspeak block, as accounts.<id>; the guests get
//     theirs from the guest container's block with their pack's voice/tools
//     applied (the same thing guest-switch.mjs did per visit);
//   - each bot's workspace and agent state (transcripts: dossier, history);
//   - TeamSpeak identities (the guests share the guest container's one);
//   - Bexton's band songs, Lexton's pending villain reverts, off-duty markers;
//   - the summoner's config, live/, state/ and query password;
//   - suno-api's env file and public/.
// Wiring (ports, paths, URLs) is not migrated: stack.mjs sets it every boot.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OLD = process.env.MIGRATE_OLD || '/old';
const NEW = process.env.MIGRATE_NEW || '/new';
const PACKS = process.env.UNIVERSAL_PERSONA_ROOT || '/opt/personas';
const C = `${NEW}/config`;
const log = (...a) => console.log('migrate:', ...a);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const copy = (from, to) => {
  if (!existsSync(from)) { log(`  (no ${from})`); return false; }
  mkdirSync(to.replace(/\/[^/]+$/, ''), { recursive: true });
  cpSync(from, to, { recursive: true, preserveTimestamps: true });
  log(`  ${from} -> ${to}`);
  return true;
};

if (existsSync(`${C}/openclaw/openclaw.json`) && process.env.MIGRATE_FORCE !== '1') {
  console.error(`migrate: ${C}/openclaw/openclaw.json exists; refusing (MIGRATE_FORCE=1 to overwrite)`);
  process.exit(1);
}

// owner container -> bots that lived in it
const HOMES = { sexton: ['sexton'], bexton: ['bexton'], lexton: ['lexton'], guest: ['johnny', 'trixie'] };
const old = Object.fromEntries(Object.keys(HOMES).map((c) => [c, readJson(`${OLD}/${c}/config/openclaw/openclaw.json`)]));

const cfg = structuredClone(old.sexton);
delete cfg.gateway?.auth; // run-gateway writes a fresh token
cfg.channels = { teamspeak: { accounts: {} } };
cfg.bindings = (cfg.bindings || []).filter((b) => b?.match?.channel !== 'teamspeak');
cfg.agents.defaults = { ...cfg.agents.defaults, ...old.guest.agents.defaults }; // PHA-3792 block streaming lives there

for (const [container, ids] of Object.entries(HOMES)) {
  const src = old[container];
  for (const id of ids) {
    const entry = src.agents.entries[id];
    if (!entry) throw new Error(`no agents.entries.${id} in ${container}'s config`);
    cfg.agents.entries[id] = entry;
    let account = structuredClone(src.channels.teamspeak);
    if (container === 'guest') account = guestAccount(account, id);
    cfg.channels.teamspeak.accounts[id] = account;
    log(`${id}: agent + account from ${container}`);
  }
}

/** guest-switch.mjs, applied once per guest instead of once per visit. */
function guestAccount(ts, id) {
  const voice = readJson(`${PACKS}/${id}/voice.json`);
  const tools = readJson(`${PACKS}/${id}/tools.json`);
  const names = voice.wakeNames?.length ? voice.wakeNames : [voice.nick || id];
  ts.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
  ts.voice.wakeAliases = voice.wakeAliases || [];
  ts.voice.excludeWakeNames = voice.excludeWakeNames || [];
  const speech = (ts.voice.streaming.speech ??= {});
  for (const k of ['voiceId', 'pitch', 'speed']) {
    if (voice[k] === undefined || voice[k] === null) delete speech[k];
    else speech[k] = voice[k];
  }
  ts.tools.moderation = tools.moderation || { kick: false, ban: false, edit: false, allowGroups: [] };
  if (typeof tools.music?.enabled === 'boolean') ts.tools.music.enabled = tools.music.enabled;
  return ts;
}

mkdirSync(`${C}/openclaw`, { recursive: true });
writeFileSync(`${C}/openclaw/openclaw.json`, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
log(`wrote ${C}/openclaw/openclaw.json (${Object.keys(cfg.channels.teamspeak.accounts).join(', ')})`);

for (const [container, ids] of Object.entries(HOMES)) {
  const oc = `${OLD}/${container}/config/openclaw`;
  for (const id of ids) {
    copy(`${oc}/workspace/agents/${id}`, `${C}/openclaw/workspace/agents/${id}`);
    copy(`${oc}/agents/${id}`, `${C}/openclaw/agents/${id}`);
    // Off duty now = off duty after the move; the summoner takes it from there.
    mkdirSync(`${C}/bots/${id}`, { recursive: true });
    if (container === 'guest' || existsSync(`${OLD}/${container}/config/.off-duty`)) writeFileSync(`${C}/bots/${id}/.off-duty`, '');
  }
  const identity = container === 'guest' ? 'guest' : container;
  copy(`${OLD}/${container}/config/sexton-id.txt`, `${C}/bots/${identity}/sexton-id.txt`);
  copy(`${OLD}/${container}/logs`, `${NEW}/logs/${ids[0]}`);
}
copy(`${OLD}/sexton/config/openclaw/plugin-skills`, `${C}/openclaw/plugin-skills`);
copy(`${OLD}/bexton/config/band-songs`, `${C}/bots/bexton/band-songs`);
copy(`${OLD}/lexton/config/openclaw/teamspeak-villain-pending.json`, `${C}/bots/lexton/villain-pending.json`);

const S = `${OLD}/ts-summoner`;
copy(`${S}/config.json`, `${C}/summoner/config.json`);
copy(`${S}/live`, `${C}/summoner/live`);
copy(`${S}/state`, `${C}/summoner/state`);
if (copy(`${S}/query-pass.txt`, `${C}/summoner/query-pass.txt`)) chmodSync(`${C}/summoner/query-pass.txt`, 0o600);
if (copy(`${OLD}/suno-api/.env`, `${C}/suno-api.env`)) chmodSync(`${C}/suno-api.env`, 0o600);
copy(`${OLD}/suno-api/public`, `${C}/suno-api/public`);

log('done. bots.json is written on first boot from the packs; check it before the cutover.');
