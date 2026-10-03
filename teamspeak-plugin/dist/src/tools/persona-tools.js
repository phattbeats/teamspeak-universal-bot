import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { getOptionalTeamSpeakRuntime } from "../runtime.js";
import { currentTeamSpeakTurnContext } from "./turn-context.js";
const SHOW_PERSONA_TOOL = "show_persona";
const EDIT_PERSONA_TOOL = "edit_persona";
const SET_VOICE_TOOL = "set_voice";
const SET_WAKE_NAMES_TOOL = "set_wake_names";
const SET_FOLLOW_UP_WINDOW_TOOL = "set_follow_up_window";
const PERSONA_FILES = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md", "HUMAN.md"];
const MAX_FILE_CHARS = 2e3;
function createTeamSpeakPersonaTools() {
  return [
    {
      name: SHOW_PERSONA_TOOL,
      label: SHOW_PERSONA_TOOL,
      description: "Read back a summary of your own configured persona: SOUL.md, AGENTS.md, IDENTITY.md, USER.md (the room's regulars) and HUMAN.md from your workspace. Use it when someone asks who you are, what your instructions say, or how you're configured \u2014 that is a legitimate question here, not the internals you otherwise keep quiet about.",
      parameters: { type: "object", properties: {} },
      execute: async () => jsonResult(await showPersona())
    },
    {
      name: EDIT_PERSONA_TOOL,
      label: EDIT_PERSONA_TOOL,
      description: "Add a standing rule to your own SOUL.md \u2014 a lasting change to how you behave going forward, not a one-off. Use it only when someone with the standing to change you (an operator, or Brandon) tells you to be different from now on. Say what changed out loud in the same turn; SOUL.md itself says a persona that rewrites itself announces it.",
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description: "The new rule, in one or two sentences, as it should read in SOUL.md."
          }
        },
        required: ["rule"]
      },
      execute: async (_id, params) => jsonResult(await editPersona(readArgs(params)))
    },
    {
      name: SET_VOICE_TOOL,
      label: SET_VOICE_TOOL,
      description: "Change your own live TTS voice (MiniMax voice id). Takes effect on your next spoken reply. Only do this when asked.",
      parameters: {
        type: "object",
        properties: {
          voiceId: { type: "string", description: 'A MiniMax voice id, e.g. "English_WiseScholar".' }
        },
        required: ["voiceId"]
      },
      execute: async (_id, params) => jsonResult(await setVoice(readArgs(params)))
    },
    {
      name: SET_WAKE_NAMES_TOOL,
      label: SET_WAKE_NAMES_TOOL,
      description: "Change the name(s) that wake you in voice. Replaces the current list. Takes effect immediately. Only do this when asked.",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: 'Wake names, e.g. ["Sexton"]. Case variants are added automatically.'
          }
        },
        required: ["names"]
      },
      execute: async (_id, params) => jsonResult(await setWakeNames(readArgs(params)))
    },
    {
      name: SET_FOLLOW_UP_WINDOW_TOOL,
      label: SET_FOLLOW_UP_WINDOW_TOOL,
      description: "Change how long, in seconds, a follow-up after your own speech is accepted with no wake name needed. 0 means every turn needs your name again. Takes effect immediately. Only do this when asked.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Dead-air window in seconds, 0 or more." }
        },
        required: ["seconds"]
      },
      execute: async (_id, params) => jsonResult(await setFollowUpWindow(readArgs(params)))
    }
  ];
}
async function currentAgentId() {
  const runtime = getOptionalTeamSpeakRuntime();
  const cfg = runtime?.config.current();
  const accountId = currentTeamSpeakTurnContext()?.accountId;
  const bindings = (cfg?.bindings ?? []).filter((b) => b?.match?.channel === "teamspeak");
  const bound = bindings.find((b) => accountId !== void 0 && b.match?.accountId === accountId)?.agentId ?? bindings.find((b) => !b.match?.accountId || b.match.accountId === "*")?.agentId;
  return bound ?? accountId ?? "sexton";
}
async function showPersona() {
  const runtime = getOptionalTeamSpeakRuntime();
  if (!runtime) {
    return { ok: false, error: "No runtime attached; cannot read the persona workspace." };
  }
  const cfg = runtime.config.current();
  const agentId = await currentAgentId();
  const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const files = {};
  for (const name of PERSONA_FILES) {
    try {
      const text = await fs.readFile(path.join(workspaceDir, name), "utf8");
      files[name] = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}
\u2026(truncated)` : text;
    } catch {
    }
  }
  return { ok: true, agentId, workspaceDir, files };
}
async function editPersona(args) {
  const rule = readString(args.rule);
  if (!rule) {
    return { ok: false, error: "Say what the new rule is." };
  }
  const runtime = getOptionalTeamSpeakRuntime();
  if (!runtime) {
    return { ok: false, error: "No runtime attached; cannot edit the persona workspace." };
  }
  const cfg = runtime.config.current();
  const agentId = await currentAgentId();
  const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const soulPath = path.join(workspaceDir, "SOUL.md");
  let soul;
  try {
    soul = await fs.readFile(soulPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Could not read ${soulPath}: ${describe(error)}` };
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const addition = `
- **(${stamp}, edit_persona)** ${rule}
`;
  await fs.writeFile(soulPath, soul.trimEnd() + "\n" + addition, "utf8");
  return {
    ok: true,
    agentId,
    rule,
    // The tool cannot itself speak into the channel — it runs inside the same
    // agent turn as the request. Saying it out loud is the agent's job, and
    // SOUL.md's own Continuity rule already requires that for a self-rewrite.
    next: `Say out loud, in your own voice, that you're adding: "${rule}"`
  };
}
async function setVoice(args) {
  const voiceId = readString(args.voiceId);
  if (!voiceId) {
    return { ok: false, error: "Give a voice id." };
  }
  return mutateTeamSpeakChannelConfig((ts) => {
    ts.voice = ts.voice ?? {};
    ts.voice.streaming = ts.voice.streaming ?? {};
    ts.voice.streaming.speech = ts.voice.streaming.speech ?? {};
    ts.voice.streaming.speech.voiceId = voiceId;
    return { voiceId };
  });
}
async function setWakeNames(args) {
  const names = readStringArray(args.names);
  if (!names || names.length === 0) {
    return { ok: false, error: "Give at least one wake name." };
  }
  return mutateTeamSpeakChannelConfig((ts) => {
    ts.voice = ts.voice ?? {};
    ts.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
    return { wakeNames: ts.voice.wakeNames };
  });
}
async function setFollowUpWindow(args) {
  const seconds = readNumber(args.seconds);
  if (seconds === void 0 || seconds < 0) {
    return { ok: false, error: "Give a follow-up window in seconds, 0 or more." };
  }
  const followUpSilenceMs = Math.round(seconds * 1e3);
  return mutateTeamSpeakChannelConfig((ts) => {
    ts.voice = ts.voice ?? {};
    ts.voice.followUpSilenceMs = followUpSilenceMs;
    return { followUpSilenceMs };
  });
}
async function mutateTeamSpeakChannelConfig(apply) {
  const runtime = getOptionalTeamSpeakRuntime();
  if (!runtime) {
    return { ok: false, error: "No runtime attached; cannot change the live config." };
  }
  let applied;
  try {
    await runtime.config.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        draft.channels = draft.channels ?? {};
        draft.channels.teamspeak = draft.channels.teamspeak ?? {};
        const accountId = currentTeamSpeakTurnContext()?.accountId;
        const account = accountId ? draft.channels.teamspeak.accounts?.[accountId] : void 0;
        applied = apply(account ?? draft.channels.teamspeak);
      }
    });
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
  return { ok: true, ...applied ?? {} };
}
function readArgs(raw) {
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function readStringArray(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const names = value.filter((v) => typeof v === "string" && v.trim().length > 0);
  return names.length > 0 ? names : void 0;
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  EDIT_PERSONA_TOOL,
  SET_FOLLOW_UP_WINDOW_TOOL,
  SET_VOICE_TOOL,
  SET_WAKE_NAMES_TOOL,
  SHOW_PERSONA_TOOL,
  createTeamSpeakPersonaTools
};
