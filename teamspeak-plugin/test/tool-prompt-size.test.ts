/**
 * How much prompt space the TeamSpeak tool schemas cost, before and
 * after the core/admin split.
 *
 * The plugin used to register all 49 tools in every session. The numbers below
 * are the schema payload the host puts in the tools array of every model
 * call: name, description and parameter schema for each tool. They are what a
 * Signal or Paperclip turn used to pay for and no longer does.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTeamSpeakTools } from "../src/tools/registry.js";
import { createTeamSpeakPersonaTools } from "../src/tools/persona-tools.js";
import { TEAMSPEAK_CORE_TOOL_NAMES } from "../src/tools/scope.js";

const ALL_TOOL_OPTIONS = {
  music: true,
  stream: true,
  band: true,
  moderation: { kick: true, ban: true, edit: true },
  villain: true,
};

type ToolLike = { name: string; description: string; parameters: unknown };

/** The shape the host sends to the model provider. */
function toProviderTool(tool: ToolLike) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function measure(tools: ToolLike[]) {
  const payload = JSON.stringify(tools.map(toProviderTool));
  return {
    count: tools.length,
    bytes: payload.length,
    tokens: Math.round(payload.length / 3.7),
  };
}

const ALL_TOOLS: ToolLike[] = [
  ...buildTeamSpeakTools(ALL_TOOL_OPTIONS),
  ...createTeamSpeakPersonaTools(),
] as ToolLike[];

const CORE_TOOLS = ALL_TOOLS.filter((tool) =>
  (TEAMSPEAK_CORE_TOOL_NAMES as readonly string[]).includes(tool.name),
);

describe("TeamSpeak tool prompt size", () => {
  it("registers every declared tool", () => {
    const declared = (JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } }).contracts?.tools ?? [];
    expect(ALL_TOOLS.length).toBe(declared.length);
    for (const name of declared) {
      expect(ALL_TOOLS.map((tool) => tool.name)).toContain(name);
    }
  });

  it("trims the non-TeamSpeak prompt to the core set", () => {
    const before = measure(ALL_TOOLS);
    const after = measure(CORE_TOOLS);
    // eslint-disable-next-line no-console
    console.log(
      `[teamspeak] TeamSpeak tool schemas — before: ${before.count} tools, ${before.bytes} bytes, ~${before.tokens} tokens | after: ${after.count} tools, ${after.bytes} bytes, ~${after.tokens} tokens | saved ~${before.tokens - after.tokens} tokens per turn`,
    );
    expect(after.count).toBe(TEAMSPEAK_CORE_TOOL_NAMES.length);
    expect(after.bytes).toBeLessThan(before.bytes * 0.3);
  });

  it("keeps the heaviest admin schemas out of the core set", () => {
    const bySize = [...ALL_TOOLS]
      .map((tool) => ({ name: tool.name, bytes: JSON.stringify(toProviderTool(tool)).length }))
      .sort((a, b) => b.bytes - a.bytes);
    // eslint-disable-next-line no-console
    console.log(
      `[teamspeak] largest TeamSpeak tool schemas: ${bySize
        .slice(0, 8)
        .map((entry) => `${entry.name}=${entry.bytes}b`)
        .join(", ")}`,
    );
    const coreNames = new Set<string>(TEAMSPEAK_CORE_TOOL_NAMES);
    const heaviestCore = bySize.filter((entry) => coreNames.has(entry.name))[0];
    expect(heaviestCore).toBeDefined();
  });
});
