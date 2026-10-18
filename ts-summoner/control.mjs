// #3963: the dashboard's Control pages. What the bots may use (tools, skills),
// who they are (persona files) and when they work (shifts).
//
// Everything here edits the files the bots already run from, never a second
// copy of the truth:
//   tools + skills  /config/openclaw/openclaw.json   agents.entries.<id>, channels.teamspeak.accounts.<id>.tools
//   persona         /config/openclaw/workspace/agents/<id>/*.md (+ lines.json, moods.json)
//   shifts          /config/summoner/config.json     bots.<id>.shifts (and the merged /run copy the summoner reads)
// Each write keeps the previous version (openclaw.json.ctl-bak, <bot>/.ctl-history/, config.json.ctl-bak).
// Pure helpers take their inputs as arguments so test/control.test.mjs needs no container.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// ------------------------------------------------------------------ files --

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Write via a temp file so a reader never sees half a file. */
export function writeAtomic(path, text, mode = 0o644) {
  const tmp = `${path}.ctl-tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');

// ------------------------------------------------------------ tools catalog --

/** The voice-lane tools the TeamSpeak plugin registers, by the switch that gates them. */
export const PLUGIN_GROUPS = [
  {
    id: 'music', label: 'Music', path: ['music', 'enabled'],
    tools: ['play_music', 'stop_music', 'set_volume', 'now_playing', 'show_queue', 'skip', 'remove_from_queue',
      'move_in_queue', 'clear_queue', 'search_music', 'play_source', 'pause', 'resume', 'seek'],
  },
  {
    id: 'band', label: 'Band (song composing)', path: ['band', 'enabled'],
    tools: ['compose_song', 'band_status', 'song_lyrics', 'replay_song'],
  },
  {
    id: 'villain', label: 'Villain (Lexton)', path: ['villain', 'enabled'],
    tools: ['sentence', 'silence', 'summon', 'dossier'],
  },
  {
    id: 'mod_kick', label: 'Moderation: kick', path: ['moderation', 'kick'], sensitive: true,
    tools: ['kick_client', 'move_client', 'mute_client'],
  },
  {
    id: 'mod_ban', label: 'Moderation: ban', path: ['moderation', 'ban'], sensitive: true,
    tools: ['ban_client', 'unban_client', 'list_bans'],
  },
  {
    id: 'mod_edit', label: 'Moderation: edit server', path: ['moderation', 'edit'], sensitive: true,
    tools: ['edit_channel', 'create_channel', 'delete_channel', 'edit_server', 'add_to_server_group'],
  },
];
/** Always on; they are the bot being a bot in the room, not something to opt into. */
export const PLUGIN_ALWAYS = ['what_did_i_miss', 'who_is_here', 'poke', 'leave_voice', 'join_voice', 'list_channels',
  'move_to_channel', 'where_is', 'send_text', 'summon_bot', 'dismiss_bot', 'show_persona', 'edit_persona',
  'set_voice', 'set_wake_names', 'set_follow_up_window'];

/** OpenClaw core tools an agent may be given or denied. */
export const CORE_TOOLS = [
  { name: 'web_search', note: 'Search the web (DuckDuckGo).' },
  { name: 'web_fetch', note: 'Read a web page.' },
  { name: 'process', note: 'Run and manage processes. Denied on every bot by default.' },
  { name: 'sessions_spawn', note: 'Start sub-agents. Denied on every bot by default.' },
];

const getPath = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  let x = o;
  for (const k of path.slice(0, -1)) x = (x[k] ??= {});
  x[path.at(-1)] = v;
}

/** `skills` dirs → [{ name, description }]. A skill is a dir with a SKILL.md. */
export function scanSkills(dirs) {
  const out = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = `${dir}/${n}/SKILL.md`;
      if (!existsSync(f)) continue;
      const head = readFileSync(f, 'utf8').slice(0, 2000);
      const d = /^description:\s*(.+)$/m.exec(head)?.[1]?.replace(/^['"]|['"]$/g, '').trim() ?? '';
      if (!out.has(n)) out.set(n, { name: n, description: d });
    }
  }
  return out;
}

/**
 * Per bot: core-tool states, plugin groups, skills. `cfg` is openclaw.json.
 * Core tool state: 'on' (alsoAllow), 'off' (deny), 'default' (neither).
 * `skills: null` on an agent means it has no allow-list, so every skill is on.
 */
export function readTools(cfg, botIds, skillCatalog) {
  const entries = cfg?.agents?.entries ?? {};
  const accounts = cfg?.channels?.teamspeak?.accounts ?? {};
  const known = new Map([...skillCatalog]);
  for (const id of botIds) for (const s of entries[id]?.skills ?? []) if (!known.has(s)) known.set(s, { name: s, description: '' });
  const bots = {};
  for (const id of botIds) {
    const t = entries[id]?.tools ?? {};
    const acct = accounts[id]?.tools ?? {};
    bots[id] = {
      core: Object.fromEntries(CORE_TOOLS.map(({ name }) => [name,
        (t.deny ?? []).includes(name) ? 'off' : (t.alsoAllow ?? []).includes(name) ? 'on' : 'default'])),
      groups: Object.fromEntries(PLUGIN_GROUPS.map((g) => [g.id, getPath(acct, g.path) === true])),
      moderationGroups: acct.moderation?.allowGroups ?? [],
      skills: Array.isArray(entries[id]?.skills) ? entries[id].skills : null,
    };
  }
  return {
    bots,
    core: CORE_TOOLS,
    groups: PLUGIN_GROUPS.map(({ id, label, tools, sensitive }) => ({ id, label, tools, sensitive: !!sensitive })),
    always: PLUGIN_ALWAYS,
    skills: [...known.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const uniq = (a) => [...new Set(a)];

/**
 * Apply `patch` to bot `id` in cfg (mutates). patch = { core?: {tool: 'on'|'off'|'default'},
 * groups?: {groupId: bool}, skills?: string[] | null }. Throws on anything unknown.
 */
export function applyTools(cfg, id, patch, skillCatalog) {
  const entry = cfg?.agents?.entries?.[id];
  const acct = cfg?.channels?.teamspeak?.accounts?.[id];
  if (!entry || !acct) throw new Error(`unknown bot ${id}`);
  if (patch.core) {
    const tools = (entry.tools ??= {});
    for (const [name, state] of Object.entries(patch.core)) {
      if (!CORE_TOOLS.some((c) => c.name === name)) throw new Error(`unknown core tool ${name}`);
      if (!['on', 'off', 'default'].includes(state)) throw new Error(`bad state for ${name}`);
      const allow = (tools.alsoAllow ?? []).filter((x) => x !== name);
      const deny = (tools.deny ?? []).filter((x) => x !== name);
      if (state === 'on') allow.push(name);
      if (state === 'off') deny.push(name);
      if (allow.length) tools.alsoAllow = uniq(allow); else delete tools.alsoAllow;
      if (deny.length) tools.deny = uniq(deny); else delete tools.deny;
    }
  }
  if (patch.groups) {
    const t = (acct.tools ??= {});
    for (const [gid, on] of Object.entries(patch.groups)) {
      const g = PLUGIN_GROUPS.find((x) => x.id === gid);
      if (!g) throw new Error(`unknown tool group ${gid}`);
      if (typeof on !== 'boolean') throw new Error(`${gid} must be true or false`);
      // A group a bot was never configured with (e.g. band keys, villain state)
      // cannot be conjured by a flag: the plugin needs its other settings.
      if (on && g.path[0] === 'villain' && !t.villain) throw new Error('villain tools need the villain settings the persona pack ships');
      if (on && g.path[0] === 'band' && !t.band) throw new Error('band tools need the band settings (provider, songs dir) the persona pack ships');
      setPath(t, g.path, on);
    }
  }
  if (patch.skills !== undefined) {
    if (patch.skills === null) delete entry.skills;
    else {
      if (!Array.isArray(patch.skills) || patch.skills.some((s) => typeof s !== 'string')) throw new Error('skills must be a list of names');
      for (const s of patch.skills) if (!skillCatalog.has(s) && !(entry.skills ?? []).includes(s)) throw new Error(`unknown skill ${s}`);
      entry.skills = uniq(patch.skills);
    }
  }
  return cfg;
}

// ----------------------------------------------------------------- persona --

const PERSONA_FILE = /^(?:[A-Za-z0-9_-]+\.md|lines\.json|moods\.json)$/;
const MAX_PERSONA_BYTES = 256 * 1024;

export function personaFiles(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => PERSONA_FILE.test(n) && statSync(`${dir}/${n}`).isFile()).sort().map((name) => ({
    name, bytes: statSync(`${dir}/${name}`).size, mtime: statSync(`${dir}/${name}`).mtimeMs,
  }));
}

export function readPersona(dir, file) {
  if (!PERSONA_FILE.test(file)) throw new Error('not an editable persona file');
  return readFileSync(`${dir}/${file}`, 'utf8');
}

/** Save `text` as `file`, keeping the old copy in .ctl-history/. Returns the backup name or null. */
export function writePersona(dir, file, text) {
  if (!PERSONA_FILE.test(file)) throw new Error('not an editable persona file');
  if (typeof text !== 'string') throw new Error('text must be a string');
  if (Buffer.byteLength(text) > MAX_PERSONA_BYTES) throw new Error('file too large');
  if (file.endsWith('.json')) JSON.parse(text); // refuse invalid JSON: the announcer would silently skip it
  if (!text.trim()) throw new Error('refusing to save an empty file');
  const path = `${dir}/${file}`;
  let backup = null;
  if (existsSync(path)) {
    mkdirSync(`${dir}/.ctl-history`, { recursive: true });
    backup = `${file}.${stamp()}`;
    writeFileSync(`${dir}/.ctl-history/${backup}`, readFileSync(path));
    pruneHistory(`${dir}/.ctl-history`, file, 20);
  }
  writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`);
  return backup;
}

function pruneHistory(hist, file, keep) {
  const mine = readdirSync(hist).filter((n) => n.startsWith(`${file}.`)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    try { renameSync(`${hist}/${old}`, `${hist}/.gone-${old}`); } catch { /* best effort */ }
  }
}

export function personaHistory(dir, file) {
  try {
    return readdirSync(`${dir}/.ctl-history`).filter((n) => n.startsWith(`${file}.`) && !n.startsWith('.gone')).sort().reverse();
  } catch { return []; }
}

export function readHistory(dir, file, version) {
  if (!PERSONA_FILE.test(file) || basename(version) !== version || !version.startsWith(`${file}.`)) throw new Error('bad version');
  return readFileSync(`${dir}/.ctl-history/${version}`, 'utf8');
}

// ---------------------------------------------------------------- schedule --

const HM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** Validate and normalise a shift list. Throws a message fit to show a person. */
export function cleanShifts(list) {
  if (!Array.isArray(list)) throw new Error('shifts must be a list');
  if (list.length > 8) throw new Error('at most 8 shifts per bot');
  return list.map((s, i) => {
    const n = `shift ${i + 1}`;
    const ok = (t, end) => HM.test(t) || (end && t === '24:00');
    if (!ok(s.start, false)) throw new Error(`${n}: start must be HH:MM (00:00-23:59)`);
    if (!ok(s.end, true)) throw new Error(`${n}: end must be HH:MM (24:00 is midnight)`);
    if (mins(s.start) === mins(s.end)) throw new Error(`${n}: start and end are the same time`);
    const out = { start: s.start, end: s.end };
    if (s.days !== undefined && s.days !== null) {
      if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new Error(`${n}: days must be numbers 0 (Sunday) to 6 (Saturday)`);
      }
      const days = uniq(s.days).sort((a, b) => a - b);
      if (days.length < 7) out.days = days;
    }
    return out;
  });
}

/**
 * Set bots.<id>.shifts in the summoner config file at `path` (editable or merged).
 * Returns true when it wrote. Keeps `<path>.ctl-bak`.
 */
export function writeShifts(path, id, shifts) {
  const cfg = readJson(path);
  if (!cfg?.bots?.[id]) return false;
  cfg.bots[id].shifts = shifts;
  writeAtomic(`${path}.ctl-bak`, readFileSync(path, 'utf8'));
  writeAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return true;
}
