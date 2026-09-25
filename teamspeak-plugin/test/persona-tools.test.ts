import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState: {
  cfg: Record<string, unknown>;
  workspaceDir: string;
} = { cfg: {}, workspaceDir: "" };

vi.mock("../src/runtime.js", () => ({
  getOptionalTeamSpeakRuntime: () => ({
    config: {
      current: () => runtimeState.cfg,
      mutateConfigFile: async (params: { mutate: (draft: any) => unknown }) => {
        params.mutate(runtimeState.cfg);
        return { result: undefined };
      },
    },
    agent: {
      resolveAgentWorkspaceDir: () => runtimeState.workspaceDir,
    },
  }),
}));

const {
  createTeamSpeakPersonaTools,
  SHOW_PERSONA_TOOL,
  EDIT_PERSONA_TOOL,
  SET_VOICE_TOOL,
  SET_WAKE_NAMES_TOOL,
  SET_FOLLOW_UP_WINDOW_TOOL,
} = await import("../src/tools/persona-tools.js");

function toolByName(name: string) {
  const tool = createTeamSpeakPersonaTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

async function callTool(name: string, params: Record<string, unknown>) {
  const result = (await toolByName(name).execute("call-1", params)) as { details: unknown };
  return result.details as Record<string, unknown>;
}

describe("persona tools", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "sexton-persona-"));
    writeFileSync(join(workspaceDir, "SOUL.md"), "# SOUL.md — Sexton\n\n## Core\n\n- Dry.\n");
    writeFileSync(join(workspaceDir, "AGENTS.md"), "# AGENTS.md — Sexton\n");
    writeFileSync(join(workspaceDir, "IDENTITY.md"), "# IDENTITY.md\n");
    runtimeState.cfg = { bindings: [{ agentId: "sexton", match: { channel: "teamspeak" } }] };
    runtimeState.workspaceDir = workspaceDir;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("show_persona reads back the workspace files that exist", async () => {
    const result = await callTool(SHOW_PERSONA_TOOL, {});
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("sexton");
    const files = result.files as Record<string, string>;
    expect(files["SOUL.md"]).toContain("Dry.");
    expect(files["HUMAN.md"]).toBeUndefined();
  });

  it("edit_persona appends the rule to SOUL.md and tells the agent to say so", async () => {
    const result = await callTool(EDIT_PERSONA_TOOL, { rule: "Never mention the weather." });
    expect(result.ok).toBe(true);
    expect(result.next).toContain("Never mention the weather.");
    const soul = readFileSync(join(workspaceDir, "SOUL.md"), "utf8");
    expect(soul).toContain("Never mention the weather.");
    expect(soul).toContain("edit_persona");
  });

  it("edit_persona rejects an empty rule", async () => {
    const result = await callTool(EDIT_PERSONA_TOOL, {});
    expect(result.ok).toBe(false);
  });

  it("set_voice writes the voiceId into channels.teamspeak.voice.streaming.speech", async () => {
    const result = await callTool(SET_VOICE_TOOL, { voiceId: "English_BossyLeader" });
    expect(result.ok).toBe(true);
    const cfg = runtimeState.cfg as any;
    expect(cfg.channels.teamspeak.voice.streaming.speech.voiceId).toBe("English_BossyLeader");
  });

  it("set_wake_names dedupes and adds a lowercase variant", async () => {
    const result = await callTool(SET_WAKE_NAMES_TOOL, { names: ["Sexton"] });
    expect(result.ok).toBe(true);
    const cfg = runtimeState.cfg as any;
    expect(cfg.channels.teamspeak.voice.wakeNames.sort()).toEqual(["Sexton", "sexton"]);
  });

  it("set_follow_up_window converts seconds to milliseconds", async () => {
    const result = await callTool(SET_FOLLOW_UP_WINDOW_TOOL, { seconds: 20 });
    expect(result.ok).toBe(true);
    const cfg = runtimeState.cfg as any;
    expect(cfg.channels.teamspeak.voice.followUpSilenceMs).toBe(20000);
  });

  it("set_follow_up_window rejects a negative window", async () => {
    const result = await callTool(SET_FOLLOW_UP_WINDOW_TOOL, { seconds: -1 });
    expect(result.ok).toBe(false);
  });
});
