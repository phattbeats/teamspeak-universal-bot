#!/usr/bin/env node
// #3791: every TeamSpeak bot in ONE container, under ONE OpenClaw gateway.
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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

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
// #4372: the voice kill switch. UNIVERSAL_VOICE=0 is the boot-time switch:
// it writes the live file (so whisper and every gateway account see "off"
// the same way a POST /voice/off does) and starts the cores with no audio.
// The file alone is the live switch; ts-summoner writes and removes it.
const SUMMONER_OFF_FILE = env.UNIVERSAL_SUMMONER_OFF_FILE || `${CONFIG}/.summoner-off`;
const VOICE_OFF_FILE = env.UNIVERSAL_VOICE_OFF_FILE || `${CONFIG}/.voice-off`;
const VOICE_SWITCH_OFF = /^(0|false|no|off)$/i.test((env.UNIVERSAL_VOICE || '1').trim());
// Guests have no shifts of their own; they only visit (#3842).
const DEFAULT_BOTS = {
  sexton: {},
  bexton: {},
  lexton: { menace: true, noCatchup: true, noWelcome: true },
  johnny: { identity: 'guest', autostart: false, noCatchup: true, noWelcome: true },
  trixie: { identity: 'guest', autostart: false, noCatchup: true, noWelcome: true },
};

// PHA-4917: the `dm` block. Stack-wide under bots.json "dm", overridden per bot;
// noWelcome / noCatchup stay as aliases for dm.welcome / dm.catchup = false.
const DM_DEFAULTS = { welcome: true, catchup: true, cooldownMin: 240, quietNotice: false, includeBots: true, maxLines: 15, dmFallback: true };
function resolveDm(stackDm, b) {
  const dm = { ...DM_DEFAULTS, ...(stackDm ?? {}), ...(b.dm ?? {}) };
  if (b.noWelcome && b.dm?.welcome === undefined) dm.welcome = false;
  if (b.noCatchup && b.dm?.catchup === undefined) dm.catchup = false;
  return dm;
}
const flag = (v) => (v ? '1' : '0');

const log = (...a) => console.log('stack:', ...a);
const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v, mode) => {
  writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(`${p}.tmp`, p);
};
const tagNick = (nick, tag) => (tag && !nick.includes(tag) ? `${nick} ${tag}`.slice(0, 30) : nick); // TS nick max 30
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
  // #4374: a bot the dashboard removed is listed in `removed` so its pack is
  // not picked straight back up here; "add" takes it off that list again.
  const removed = new Set(Array.isArray(file?.removed) ? file.removed : []);
  for (const id of Object.keys(found)) if (!bots[id] && !removed.has(id)) { bots[id] = {}; log(`new persona pack '${id}', adding it`); }
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
  // Solo mode: only this bot runs, around the clock, with no summoner. The other
  // bots keep their entries (and enabled flags), so `solo off` restores them.
  const solo = typeof file?.solo === 'string' ? file.solo : '';
  if (solo && !bots[solo]) log(`WARNING solo '${solo}' is not in bots.json; solo ignored`);
  const soloId = solo && bots[solo] ? solo : '';
  for (const [id, b] of Object.entries(bots)) {
    if (soloId ? id !== soloId : b.enabled === false) continue;
    const dir = found[id];
    if (!dir) { log(`WARNING bots.json lists '${id}' but there is no persona pack for it; skipped`); continue; }
    const voice = readJson(`${dir}/voice.json`, {});
    const tools = readJson(`${dir}/tools.json`, {});
    list.push({
      id, pack: dir, voice, tools, ...b,
      nick: b.nick || voice.nick || titleCase(id),
      // TeamSpeak shows the tagged name; wake names keep the plain nick.
      tsNick: tagNick(b.nick || voice.nick || titleCase(id), b.botTag ?? file?.server?.botTag ?? '[BOT]'),
      home: `${CONFIG}/bots/${id}`,
      identityFile: `${CONFIG}/bots/${b.identity || id}/sexton-id.txt`,
      logDir: `${LOGS}/${id}`,
      // #4875: where each bot connects is bots.json's call: its own entry, else
      // the stack-wide `server` block, else the container env (a fallback only).
      address: b.address || file?.server?.address || env.SEXTON_ADDR || '',
      serverPort: Number(file?.server?.port || env.SEXTON_PORT || 9987),
      channel: b.channel || file?.server?.channel || env.SEXTON_CHANNEL || '',
      fallbackChannel: b.fallbackChannel || file?.server?.fallbackChannel || file?.server?.channel || env.SEXTON_CHANNEL || '',
      avatar: b.avatar || (existsSync(`${dir}/avatar.png`) ? `${dir}/avatar.png` : ''),
    });
  }
  list.solo = soloId;
  list.dm = file?.dm && typeof file.dm === 'object' ? file.dm : {};
  list.timezone = typeof file?.server?.timezone === 'string' ? file.server.timezone : '';
  list.botTag = file?.server?.botTag ?? '[BOT]';
  list.serverQuery = file?.server?.query && typeof file.server.query === 'object' ? file.server.query : null;
  return list;
}

// ------------------------------------------------------------- supervisor --

/** PHA-4917: env for the core's DM behaviour; the welcome copy is built from what is really on. */
function dmVars(b, bots) {
  const dm = resolveDm(bots.dm, b);
  const cfg = readJson(CFG_PATH, {});
  const voiceMode = cfg?.channels?.teamspeak?.accounts?.[b.id]?.voice?.mode ?? cfg?.channels?.teamspeak?.voice?.mode ?? '';
  const stream = b.tools?.stream?.enabled === true;
  const welcome = `${b.pack}/welcome.json`;
  return {
    SEXTON_DM_WELCOME: flag(dm.welcome),
    SEXTON_DM_CATCHUP: flag(dm.catchup),
    SEXTON_DM_COOLDOWN_MIN: String(dm.cooldownMin),
    SEXTON_DM_QUIET_NOTICE: flag(dm.quietNotice),
    SEXTON_DM_INCLUDE_BOTS: flag(dm.includeBots),
    SEXTON_DM_MAX_LINES: String(dm.maxLines),
    SEXTON_DM_FALLBACK: flag(dm.dmFallback),
    SEXTON_BOT_NAME: b.voice?.welcomeName || `the ${b.nick}`,
    SEXTON_BOT_TAG: bots.botTag ?? '[BOT]',
    SEXTON_VOICE_MODE: voiceMode,
    SEXTON_VOICE_OFF_FILE: VOICE_OFF_FILE,
    SEXTON_CAP_STREAM: flag(stream),
    SEXTON_CAP_MUSIC: flag(b.tools?.music?.enabled !== false),
    ...(existsSync(welcome) ? { SEXTON_WELCOME_FILE: welcome } : {}),
    ...(bots.timezone ? { TZ: bots.timezone } : {}),
  };
}

const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

function supervisor() {
  const bots = loadBots();
  mkdirSync(RUN, { recursive: true });
  if (VOICE_SWITCH_OFF) {
    // Both the pool script and the plugin read the file, so the env switch
    // becomes the file; it stays until a POST /voice/on removes it.
    mkdirSync(CONFIG, { recursive: true });
    if (!existsSync(VOICE_OFF_FILE)) writeFileSync(VOICE_OFF_FILE, `UNIVERSAL_VOICE=${env.UNIVERSAL_VOICE} at boot ${new Date().toISOString()}\n`);
    log(`voice OFF (UNIVERSAL_VOICE=${env.UNIVERSAL_VOICE}): ${VOICE_OFF_FILE} written, cores start with SEXTON_NO_AUDIO=1`);
  } else if (existsSync(VOICE_OFF_FILE)) {
    log(`voice OFF (${VOICE_OFF_FILE} exists from an earlier POST /voice/off); POST /voice/on turns it back on`);
  }
  let conf = '; Generated by /opt/universal/stack.mjs (boot and dashboard rewires). Edit /config/bots.json or use the Bots tab instead.\n';
  for (const b of bots) {
    mkdirSync(b.home, { recursive: true });
    mkdirSync(b.identityFile.replace(/\/[^/]+$/, ''), { recursive: true });
    mkdirSync(b.logDir, { recursive: true });
    if (!b.address || !b.channel) log(`WARNING ${b.id} has no ${!b.address ? 'server address' : 'channel'}: set it on the bot or in bots.json "server"; its core will not start`);
    const vars = {
      SEXTON_NICK: b.tsNick,
      SEXTON_AVATAR: b.avatar,
      SEXTON_WS_BIND: `127.0.0.1:${b.port}`,
      SEXTON_IDENTITY_FILE: b.identityFile,
      SEXTON_LOG_DIR: b.logDir,
      SEXTON_ADDR: b.address,
      SEXTON_PORT: String(b.serverPort),
      SEXTON_CHANNEL: b.channel,
      SEXTON_FALLBACK_CHANNEL: b.fallbackChannel,
      SEXTON_NO_CATCHUP: b.noCatchup ? '1' : '0',
      SEXTON_NO_WELCOME: b.noWelcome ? '1' : '0',
      ...dmVars(b, bots),
      SEXTON_GUEST_ENV: '/nonexistent',
      ...(VOICE_SWITCH_OFF ? { SEXTON_NO_AUDIO: '1' } : {}),
      ...(b.env || {}),
    };
    // Off duty at boot stays off: the summoner starts it when the shift says
    // so. Guests sharing one identity never autostart (two cores, one UID).
    const off = !bots.solo && (existsSync(`${b.home}/.off-duty`) || b.autostart === false);
    conf += `
[program:core-${b.id}]
command=/usr/local/bin/run-sexton
stdout_events_enabled=true
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
  // Solo mode idles the summoner (run-summoner.sh looks for this file).
  if (bots.solo) writeFileSync(SUMMONER_OFF_FILE, `solo ${bots.solo}\n`); else rmSync(SUMMONER_OFF_FILE, { force: true });
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
  cfg.insights = { ...cfg.insights, db: `${CONFIG}/insights/insights.db` }; // #3963
  cfg.voice = { ...cfg.voice, offFile: VOICE_OFF_FILE, whisperProgram: 'whisper' }; // #4372
  // The room log lives where the off-duty bot writes it: <its log dir>/<its channel>.
  const logBot = cfg.chatLog && bots.find((b) => b.id === cfg.chatLog.whenOff);
  if (logBot) cfg.chatLog = { ...cfg.chatLog, dir: `${logBot.logDir}/${logBot.channel}` };
  else if (cfg.chatLog) log(`WARNING chatLog.whenOff '${cfg.chatLog.whenOff}' is not a live bot; chatLog.dir left as configured`);
  // #4875: the summoner's ServerQuery host follows bots.json "server".query when set.
  if (bots.serverQuery) cfg.query = { ...cfg.query, ...bots.serverQuery };
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
      // #3829: shared tone reaches the prompt only as an AGENTS.md-class
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
    // PHA-4499: the plugin only registers stream_url when the account says so; follow the pack/bots.json every boot.
    if (typeof b.tools.stream?.enabled === 'boolean') a.tools.stream = { ...a.tools.stream, enabled: b.tools.stream.enabled };
    a.tools.summoner = { ...a.tools.summoner, url: `http://127.0.0.1:${SUMMONER_PORT}`, self: b.id };
    // #4372: every account watches the one kill-switch file. `voice.mode`
    // itself stays the operator's (an account pinned to "off" stays off).
    a.voice ??= {};
    a.voice.offFile = VOICE_OFF_FILE;
    // PHA-4917: a human DM always gets a reply; the fallback line is bots.json's call.
    a.dmFallback = resolveDm(bots.dm, b).dmFallback !== false;
    a.botTag = bots.botTag ?? '[BOT]';
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
  // their tuning comes back if the bot does (#4374: and so does the account;
  // bots.json is the one switch, an account is never left off by hand).
  const live = new Set(bots.map((b) => b.id));
  for (const [id, a] of Object.entries(ts.accounts)) { if (live.has(id)) delete a.enabled; else a.enabled = false; }
  // No top-level account: every bot is a named one.
  for (const k of Object.keys(ts)) if (k !== 'accounts' && k !== 'enabled') delete ts[k];

  // --- bindings: account <id> -> agent <id>, nothing else on teamspeak ---
  cfg.bindings = [
    ...(cfg.bindings || []).filter((x) => x?.match?.channel !== 'teamspeak'),
    ...bots.map((b) => ({ agentId: b.id, match: { channel: 'teamspeak', accountId: b.id } })),
  ];

  // #3829/3840: the hook that injects shared tone and the day's mood.
  cfg.hooks ??= {};
  cfg.hooks.internal ??= {};
  cfg.hooks.internal.enabled = true;
  const entries = (cfg.hooks.internal.entries ??= {});
  const hook = (entries['bootstrap-extra-files'] ??= {});
  hook.enabled = true;
  hook.paths = [...new Set([...(hook.paths || []), 'shared-tone/AGENTS.md', 'mood/AGENTS.md'])];
  // #3792: sentence-sized blocks for the voice lane, only when unset.
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
  a.channel = b.channel || a.channel;
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
  // Fail closed: moderation only where the pack grants it (#3793).
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
// #4374: the dashboard's Bots tab edits bots.json while the stack is up, then
// runs this: bots.conf and the gateway wiring follow the file, and
// `supervisorctl reread && update` restarts only the cores whose program changed.
else if (mode === 'rewire') { supervisor(); gateway(); }
// `solo <id>` runs only that bot 24/7 with the summoner idle; `solo off` restores the roster.
else if (mode === 'solo') {
  const arg = process.argv[3];
  const f = readJson(BOTS_FILE, null);
  if (!arg || !f?.bots || (arg !== 'off' && !f.bots[arg])) { console.error('usage: stack.mjs solo <bot-id in bots.json>|off'); process.exit(2); }
  copyFileSync(BOTS_FILE, `${BOTS_FILE}.pre-solo`);
  if (arg === 'off') delete f.solo; else f.solo = arg; // an overlay: no bot entry changes
  writeJson(BOTS_FILE, f);
  supervisor(); gateway();
  log(arg === 'off' ? 'solo off' : `solo ${arg}`);
}
else if (mode === 'list') console.log(JSON.stringify(loadBots().map(({ id, port, nick, identity }) => ({ id, port, nick, identity })), null, 2));
else if (mode === 'packs') console.log(JSON.stringify(packs(), null, 2));
else { console.error('usage: stack.mjs supervisor|gateway|rewire|solo|list|packs'); process.exit(2); }
