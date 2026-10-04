#!/usr/bin/env node
// PHA-3791: every TeamSpeak bot in ONE container, under ONE OpenClaw gateway.
//
// Brandon, 2026-10-02: "since openclaw can handle multiple agents, cant they
// all be under one, expanding container?" This is the "expanding" part. A bot
// is a persona pack (personas/<id>/, baked at /opt/personas, or dropped into
// /config/personas without a rebuild) plus one line in /config/bots.json, and
// from those this script derives everything the old per-bot containers each
// carried by hand:
//
//   node stack.mjs supervisor   (entrypoint, before supervisord)
//     - /config/bots.json: seeded from the packs on first boot; a pack that
//       appears later is added with the next free bridge port. Ports are
//       written back so they never move under a running config.
//     - one `core-<id>` supervisor program per bot (the Rust core: its own
//       TeamSpeak identity, nick, avatar and bridge port) and `menace-<id>`
//       for a bot that has menace on, into /run/universal/bots.conf.
//     - the summoner's effective config: /config/summoner/config.json (the
//       editable shifts/scenes/guests file) plus this container's wiring.
//
//   node stack.mjs gateway      (run-gateway, after the plugin link install)
//     - per bot: agent entry + workspace (seeded once, never overwritten),
//       channels.teamspeak.accounts.<id> (seeded once from the pack), and a
//       binding of that account to that agent.
//     - wiring keys are re-applied every boot (bridgeUrl, announce/villain
//       paths, log dir, summoner self/url): they are this container's layout,
//       not tuning, and must follow bots.json. Everything else in an account
//       is the operator's after first boot, same rule as before.
//
// Per-bot state lives in /config/bots/<id>/ (identity, .announce, .off-duty);
// guests that take turns in one TeamSpeak identity share it via `identity`.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';

const env = process.env;
const CONFIG = env.UNIVERSAL_CONFIG_DIR || '/config';
const BOTS_FILE = `${CONFIG}/bots.json`;
const PACK_ROOTS = [`${CONFIG}/personas`, env.UNIVERSAL_PERSONA_ROOT || '/opt/personas'];
const RUN = env.UNIVERSAL_RUN_DIR || '/run/universal';
const LOGS = env.SEXTON_LOG_DIR || '/var/sexton-logs';
const STATE = env.OPENCLAW_STATE_DIR || `${CONFIG}/openclaw`;
const CFG_PATH = env.OPENCLAW_CONFIG_PATH || `${STATE}/openclaw.json`;
const FIRST_PORT = 9101;
const SUMMONER_PORT = Number(env.SUMMONER_PORT || 8099);
const WHISPER_URL = env.UNIVERSAL_WHISPER_URL || 'http://127.0.0.1:8082/inference';
const SUNO_URL = env.UNIVERSAL_SUNO_URL || 'http://127.0.0.1:3000';
const POT_PORT = env.POT_PORT || 4416;
const SEED = env.UNIVERSAL_SEED || '/opt/sexton-gateway/openclaw.seed.json';
const SUMMONER_DEFAULTS = env.UNIVERSAL_SUMMONER_DEFAULTS || '/opt/ts-summoner';
// Guests have no shifts of their own; they only visit (PHA-3842).
const DEFAULT_BOTS = {
  sexton: {},
  bexton: {},
  lexton: { menace: true, noCatchup: true, noWelcome: true },
  johnny: { identity: 'guest', autostart: false, noCatchup: true, noWelcome: true },
  trixie: { identity: 'guest', autostart: false, noCatchup: true, noWelcome: true },
};

const log = (...a) => console.log('stack:', ...a);
const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v, mode) => {
  writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(`${p}.tmp`, p);
};
const titleCase = (id) => id[0].toUpperCase() + id.slice(1);

/** personas/<id>/ dirs that are real packs (a voice.json says so). */
function packs() {
  const out = {};
  for (const root of [...PACK_ROOTS].reverse()) {
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      if (/^[a-z][a-z0-9_-]*$/.test(id) && existsSync(`${root}/${id}/voice.json`)) out[id] = `${root}/${id}`;
    }
  }
  return out; // /config/personas wins over the image's copy
}
const humanMd = () => PACK_ROOTS.map((r) => `${r}/HUMAN.md`).find((p) => existsSync(p));

/** The bot list, ports assigned and persisted. Disabled bots stay listed. */
function loadBots() {
  const found = packs();
  const file = readJson(BOTS_FILE, null);
  const before = JSON.stringify(file);
  const bots = file?.bots ?? Object.fromEntries(Object.keys(DEFAULT_BOTS).filter((id) => found[id]).map((id) => [id, { ...DEFAULT_BOTS[id] }]));
  for (const id of Object.keys(found)) if (!bots[id]) { bots[id] = {}; log(`new persona pack '${id}', adding it`); }
  const used = new Set(Object.values(bots).map((b) => b.port).filter(Boolean));
  let next = FIRST_PORT;
  for (const b of Object.values(bots)) {
    if (b.port) continue;
    while (used.has(next)) next += 1;
    b.port = next;
    used.add(next);
  }
  const out = { ...(file ?? {}), bots };
  if (JSON.stringify(out) !== before) {
    mkdirSync(CONFIG, { recursive: true });
    writeJson(BOTS_FILE, out);
  }
  const list = [];
  for (const [id, b] of Object.entries(bots)) {
    if (b.enabled === false) continue;
    const dir = found[id];
    if (!dir) { log(`WARNING bots.json lists '${id}' but there is no persona pack for it; skipped`); continue; }
    const voice = readJson(`${dir}/voice.json`, {});
    const tools = readJson(`${dir}/tools.json`, {});
    list.push({
      id, pack: dir, voice, tools, ...b,
      nick: b.nick || voice.nick || titleCase(id),
      home: `${CONFIG}/bots/${id}`,
      identityFile: `${CONFIG}/bots/${b.identity || id}/sexton-id.txt`,
      logDir: `${LOGS}/${id}`,
      avatar: b.avatar || (existsSync(`${dir}/avatar.png`) ? `${dir}/avatar.png` : ''),
    });
  }
  return list;
}

// ------------------------------------------------------------- supervisor --

const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

function supervisor() {
  const bots = loadBots();
  mkdirSync(RUN, { recursive: true });
  let conf = '; Generated by /opt/universal/stack.mjs at boot. Edit /config/bots.json instead.\n';
  for (const b of bots) {
    mkdirSync(b.home, { recursive: true });
    mkdirSync(b.identityFile.replace(/\/[^/]+$/, ''), { recursive: true });
    mkdirSync(b.logDir, { recursive: true });
    const vars = {
      SEXTON_NICK: b.nick,
      SEXTON_AVATAR: b.avatar,
      SEXTON_WS_BIND: `127.0.0.1:${b.port}`,
      SEXTON_IDENTITY_FILE: b.identityFile,
      SEXTON_LOG_DIR: b.logDir,
      SEXTON_CHANNEL: b.channel || env.SEXTON_CHANNEL || 'General Shit',
      SEXTON_NO_CATCHUP: b.noCatchup ? '1' : '0',
      SEXTON_NO_WELCOME: b.noWelcome ? '1' : '0',
      SEXTON_GUEST_ENV: '/nonexistent',
      ...(b.env || {}),
    };
    // Off duty at boot stays off: the summoner starts it when the shift says
    // so. Guests sharing one identity never autostart (two cores, one UID).
    const off = existsSync(`${b.home}/.off-duty`) || b.autostart === false;
    conf += `
[program:core-${b.id}]
command=/usr/local/bin/run-sexton
environment=${Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`).join(',')}
autostart=${off ? 'false' : 'true'}
autorestart=true
startsecs=10
startretries=1000000
priority=10
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
redirect_stderr=true
stopsignal=TERM
stopwaitsecs=15
`;
    if (b.menace) {
      conf += `
[program:menace-${b.id}]
command=/usr/local/bin/run-menace
environment=SEXTON_MENACE="1",MENACE_AGENT=${q(b.id)},MENACE_BRIDGE_URL=${q(`ws://127.0.0.1:${b.port}`)}
autostart=true
autorestart=unexpected
exitcodes=0
startsecs=5
startretries=1000000
priority=50
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
redirect_stderr=true
`;
    }
  }
  writeFileSync(`${RUN}/bots.conf`, conf);
  writeSummonerConfig(bots);
  log(`${bots.length} bots: ${bots.map((b) => `${b.id}:${b.port}`).join(' ')}`);
}

function writeSummonerConfig(bots) {
  const dir = `${CONFIG}/summoner`;
  mkdirSync(`${dir}/state`, { recursive: true });
  const editable = `${dir}/config.json`;
  if (!existsSync(editable) && existsSync(`${SUMMONER_DEFAULTS}/config.json`)) cpSync(`${SUMMONER_DEFAULTS}/config.json`, editable);
  if (!existsSync(`${dir}/live`) && existsSync(`${SUMMONER_DEFAULTS}/live`)) cpSync(`${SUMMONER_DEFAULTS}/live`, `${dir}/live`, { recursive: true });
  const cfg = readJson(editable, null);
  if (!cfg) { log(`WARNING no summoner config at ${editable}`); return; }
  cfg.local = true;
  cfg.httpPort = SUMMONER_PORT;
  cfg.query = { ...cfg.query, passFile: `${dir}/query-pass.txt` };
  cfg.calendarFile = `${dir}/live/calendar.json`;
  cfg.stateFile = `${dir}/state/state.json`;
  cfg.scenes = { ...cfg.scenes, file: `${dir}/live/scenes.json` };
  cfg.insights = { ...cfg.insights, db: `${CONFIG}/insights/insights.db` }; // PHA-3963
  if (cfg.chatLog) cfg.chatLog = { ...cfg.chatLog, dir: `${LOGS}/${cfg.chatLog.whenOff}/${env.SEXTON_CHANNEL || 'General Shit'}` };
  cfg.bots = cfg.bots || {};
  const live = new Set(bots.map((b) => b.id));
  for (const id of Object.keys(cfg.bots)) if (!live.has(id)) delete cfg.bots[id];
  for (const b of bots) {
    // A pack the summoner has never heard of is on duty around the clock until
    // someone gives it shifts in /config/summoner/config.json.
    const s = (cfg.bots[b.id] ??= { nick: b.nick, names: [b.id], shifts: [{ start: '00:00', end: '24:00' }] });
    s.nick ??= b.nick;
    s.container ??= b.identity || b.id; // guests sharing an identity share a slot
    s.program = `core-${b.id}`;
    s.dir = b.home;
  }
  writeJson(`${RUN}/summoner.json`, cfg);
}

// ---------------------------------------------------------------- gateway --

function gateway() {
  const bots = loadBots();
  const cfg = readJson(CFG_PATH, null);
  if (!cfg) throw new Error(`cannot read ${CFG_PATH}`);
  const before = JSON.stringify(cfg);
  const human = humanMd();
  cfg.agents ??= {};
  cfg.agents.entries ??= {};
  cfg.channels ??= {};
  const ts = (cfg.channels.teamspeak ??= {});
  ts.accounts ??= {};
  const seed = readJson(SEED, {}).channels?.teamspeak ?? {};

  for (const b of bots) {
    // --- the agent and its workspace: seeded once, then the operator's ---
    const ws = `${STATE}/workspace/agents/${b.id}`;
    if (!existsSync(ws)) {
      log(`seeding the ${b.id} workspace from ${b.pack}`);
      mkdirSync(ws, { recursive: true });
      for (const f of readdirSync(b.pack)) if (f.endsWith('.md')) cpSync(`${b.pack}/${f}`, `${ws}/${f}`);
    }
    for (const f of ['lines.json', 'moods.json']) {
      if (!existsSync(`${ws}/${f}`) && existsSync(`${b.pack}/${f}`)) cpSync(`${b.pack}/${f}`, `${ws}/${f}`);
    }
    if (!existsSync(`${ws}/mood/AGENTS.md`)) {
      mkdirSync(`${ws}/mood`, { recursive: true });
      writeFileSync(`${ws}/mood/AGENTS.md`, '# How today is going\n\nNothing special about today. Just a regular shift.\n');
    }
    if (human) {
      // PHA-3829: shared tone reaches the prompt only as an AGENTS.md-class
      // file; synced every boot so a HUMAN.md fix ships without re-seeding.
      mkdirSync(`${ws}/shared-tone`, { recursive: true });
      cpSync(human, `${ws}/shared-tone/AGENTS.md`);
    }
    if (!cfg.agents.entries[b.id]) {
      const donor = Object.values(cfg.agents.entries).find((e) => e?.workspace?.startsWith(`${STATE}/workspace/agents/`)) || {};
      const agent = b.tools.agent || {};
      cfg.agents.entries[b.id] = {
        name: b.nick,
        workspace: ws,
        ...(donor.model ? { model: donor.model } : {}),
        identity: { name: b.nick },
        thinkingDefault: 'off',
        tools: { deny: ['process', 'sessions_spawn'], ...(agent.alsoAllow ? { alsoAllow: agent.alsoAllow } : {}) },
        ...(agent.skills ? { skills: agent.skills } : {}),
      };
      log(`added agents.entries.${b.id}`);
    }

    // --- the account: seeded once from the pack ---
    if (!ts.accounts[b.id]) {
      ts.accounts[b.id] = accountFromPack(b, seed, cfg);
      log(`added channels.teamspeak.accounts.${b.id}`);
    }
    // --- wiring: follows bots.json every boot ---
    const a = ts.accounts[b.id];
    a.bridgeUrl = `ws://127.0.0.1:${b.port}`;
    a.tools ??= {};
    a.tools.logDir = b.logDir;
    a.tools.announce = {
      ...a.tools.announce,
      requestFile: `${b.home}/.announce`,
      linesFile: `${ws}/lines.json`,
      moodsFile: `${ws}/moods.json`,
      moodPromptFile: `${ws}/mood/AGENTS.md`,
    };
    a.tools.summoner = { ...a.tools.summoner, url: `http://127.0.0.1:${SUMMONER_PORT}`, self: b.id };
    if (a.tools.villain) {
      a.tools.villain.stateFile = `${b.home}/villain-pending.json`;
      a.tools.villain.transcriptDb = `${STATE}/agents/${b.id}/agent/openclaw-agent.sqlite`;
    }
    if (a.tools.band) {
      a.tools.band.songsDir = `${b.home}/band-songs`;
      if (a.tools.band.provider === 'suno-api') a.tools.band.sunoApi = { ...a.tools.band.sunoApi, baseUrl: SUNO_URL };
    }
    if (a.tools.music) {
      a.tools.music.extraYtdlpArgs = ['--extractor-args', `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${POT_PORT}`];
    }
    // The in-container whisper pool is the transcriber unless an account
    // was moved to another provider by hand.
    const stt = a.voice?.streaming?.transcription;
    if (stt && (stt.provider ?? 'whisper-local') === 'whisper-local') stt.url = WHISPER_URL;
  }
  // Accounts for bots no longer in bots.json are switched off, not deleted:
  // their tuning comes back if the bot does.
  const live = new Set(bots.map((b) => b.id));
  for (const [id, a] of Object.entries(ts.accounts)) a.enabled = live.has(id) ? a.enabled !== false : false;
  for (const [id, a] of Object.entries(ts.accounts)) if (a.enabled === true) delete a.enabled;
  // No top-level account: every bot is a named one.
  for (const k of Object.keys(ts)) if (k !== 'accounts' && k !== 'enabled') delete ts[k];

  // --- bindings: account <id> -> agent <id>, nothing else on teamspeak ---
  cfg.bindings = [
    ...(cfg.bindings || []).filter((x) => x?.match?.channel !== 'teamspeak'),
    ...bots.map((b) => ({ agentId: b.id, match: { channel: 'teamspeak', accountId: b.id } })),
  ];

  // PHA-3829/3840: the hook that injects shared tone and the day's mood.
  cfg.hooks ??= {};
  cfg.hooks.internal ??= {};
  cfg.hooks.internal.enabled = true;
  const entries = (cfg.hooks.internal.entries ??= {});
  const hook = (entries['bootstrap-extra-files'] ??= {});
  hook.enabled = true;
  hook.paths = [...new Set([...(hook.paths || []), 'shared-tone/AGENTS.md', 'mood/AGENTS.md'])];
  // PHA-3792: sentence-sized blocks for the voice lane, only when unset.
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.blockStreamingChunk ??= { minChars: 24, maxChars: 400, breakPreference: 'sentence' };
  cfg.agents.defaults.blockStreamingCoalesce ??= { minChars: 24, maxChars: 400, idleMs: 0 };

  if (JSON.stringify(cfg) !== before) {
    writeJson(CFG_PATH, cfg, 0o600);
    log(`updated ${CFG_PATH}`);
  }
}

/** A fresh account from the pack's voice.json / tools.json and the seed. */
function accountFromPack(b, seed, cfg) {
  const a = JSON.parse(JSON.stringify(seed));
  delete a.bridgeUrl;
  a.channel = b.channel || env.SEXTON_CHANNEL || a.channel || 'General Shit';
  a.voice ??= {};
  const v = b.voice;
  const names = Array.isArray(v.wakeNames) && v.wakeNames.length ? v.wakeNames : [b.nick];
  a.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
  a.voice.wakeAliases = v.wakeAliases || [];
  a.voice.excludeWakeNames = v.excludeWakeNames || [];
  if (typeof v.followUpSilenceMs === 'number') a.voice.followUpSilenceMs = v.followUpSilenceMs;
  a.voice.streaming ??= {};
  a.voice.streaming.transcription = { ...a.voice.streaming.transcription, url: WHISPER_URL };
  const speech = (a.voice.streaming.speech ??= {});
  for (const k of ['voiceId', 'pitch', 'speed']) if (v[k] !== undefined && v[k] !== null) speech[k] = v[k];
  a.tools ??= {};
  const t = b.tools;
  if (typeof t.music?.enabled === 'boolean') a.tools.music = { ...a.tools.music, enabled: t.music.enabled };
  // Fail closed: moderation only where the pack grants it (PHA-3793).
  a.tools.moderation = t.moderation || { kick: false, ban: false, edit: false, allowGroups: [] };
  if (t.villain) a.tools.villain = { ...t.villain };
  if (t.band?.enabled) {
    const band = { ...t.band };
    if ((band.provider ?? 'minimax') === 'minimax' && cfg.tts?.providers?.minimax?.apiKey) {
      band.minimax = { apiKey: cfg.tts.providers.minimax.apiKey, ...band.minimax };
    }
    a.tools.band = band;
  }
  return a;
}

const mode = process.argv[2];
if (mode === 'supervisor') supervisor();
else if (mode === 'gateway') gateway();
else if (mode === 'list') console.log(JSON.stringify(loadBots().map(({ id, port, nick, identity }) => ({ id, port, nick, identity })), null, 2));
else { console.error('usage: stack.mjs supervisor|gateway|list'); process.exit(2); }
