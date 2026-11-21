/**
 * The TeamSpeak plugin used to register all 49 tools in every
 * session. These tests pin the split: a small core set everywhere, the
 * admin/band surface only in TeamSpeak sessions.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createTeamSpeakToolFactory,
  isTeamSpeakToolVisible,
  resolveTeamSpeakSessionScope,
  resolveTeamSpeakToolScope,
  TEAMSPEAK_CORE_TOOL_NAMES,
} from "../src/tools/scope.js";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  contracts?: { tools?: string[] };
};
const DECLARED_TOOLS = manifest.contracts?.tools ?? [];

const TEAMSPEAK_VOICE_SESSION = { messageChannel: "teamspeak" };
const TEAMSPEAK_TEXT_SESSION = { messageChannel: "teamspeak" };
const SIGNAL_SESSION = { messageChannel: "signal" };
const DISCORD_SESSION = { messageChannel: "discord" };
const PAPERCLIP_SESSION = { messageChannel: "paperclip" };
const CRON_SESSION = { messageChannel: "cron" };
const WEBCHAT_SESSION = { messageChannel: "webchat" };
const NO_CHANNEL_SESSION = {};

describe("TeamSpeak tool scope", () => {
  it("keeps a small core set", () => {
    expect(TEAMSPEAK_CORE_TOOL_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(TEAMSPEAK_CORE_TOOL_NAMES.length).toBeLessThanOrEqual(14);
    expect(new Set(TEAMSPEAK_CORE_TOOL_NAMES).size).toBe(TEAMSPEAK_CORE_TOOL_NAMES.length);
  });

  it("classifies every declared tool, with core names taken from the manifest", () => {
    for (const name of TEAMSPEAK_CORE_TOOL_NAMES) {
      expect(DECLARED_TOOLS).toContain(name);
      expect(resolveTeamSpeakToolScope(name)).toBe("core");
    }
    for (const name of DECLARED_TOOLS) {
      expect(["core", "admin"]).toContain(resolveTeamSpeakToolScope(name));
    }
  });

  it("hides the admin surface outside TeamSpeak sessions", () => {
    const admin = DECLARED_TOOLS.filter((name) => resolveTeamSpeakToolScope(name) === "admin");
    expect(admin.length).toBeGreaterThan(30);
    for (const name of admin) {
      expect(isTeamSpeakToolVisible(name, SIGNAL_SESSION)).toBe(false);
      expect(isTeamSpeakToolVisible(name, DISCORD_SESSION)).toBe(false);
      expect(isTeamSpeakToolVisible(name, PAPERCLIP_SESSION)).toBe(false);
      expect(isTeamSpeakToolVisible(name, CRON_SESSION)).toBe(false);
      expect(isTeamSpeakToolVisible(name, WEBCHAT_SESSION)).toBe(false);
      expect(isTeamSpeakToolVisible(name, NO_CHANNEL_SESSION)).toBe(false);
    }
  });

  it("keeps the core set visible in every session", () => {
    for (const name of TEAMSPEAK_CORE_TOOL_NAMES) {
      for (const session of [
        SIGNAL_SESSION,
        DISCORD_SESSION,
        PAPERCLIP_SESSION,
        CRON_SESSION,
        WEBCHAT_SESSION,
        NO_CHANNEL_SESSION,
      ]) {
        expect(isTeamSpeakToolVisible(name, session)).toBe(true);
      }
    }
  });

  it("gives the TeamSpeak voice session every tool it had", () => {
    for (const name of DECLARED_TOOLS) {
      expect(isTeamSpeakToolVisible(name, TEAMSPEAK_VOICE_SESSION)).toBe(true);
    }
    expect(resolveTeamSpeakSessionScope(TEAMSPEAK_VOICE_SESSION)).toBe("admin");
  });

  it("gives the TeamSpeak text session the same surface", () => {
    for (const name of DECLARED_TOOLS) {
      expect(isTeamSpeakToolVisible(name, TEAMSPEAK_TEXT_SESSION)).toBe(true);
    }
  });

  it("recognizes a TeamSpeak session from the delivery context alone", () => {
    expect(resolveTeamSpeakSessionScope({ deliveryContext: { channel: "teamspeak" } })).toBe("admin");
    expect(resolveTeamSpeakSessionScope({ deliveryContext: { channel: "signal" } })).toBe("core");
  });

  it("returns null from the factory for hidden tools and the tool for visible ones", () => {
    const adminTool = { name: "ban_client" };
    const coreTool = { name: "play_music" };
    expect(createTeamSpeakToolFactory(adminTool)(SIGNAL_SESSION)).toBeNull();
    expect(createTeamSpeakToolFactory(adminTool)(TEAMSPEAK_VOICE_SESSION)).toBe(adminTool);
    expect(createTeamSpeakToolFactory(coreTool)(SIGNAL_SESSION)).toBe(coreTool);
  });

  it("fails closed: an unknown tool name is admin, not core", () => {
    expect(resolveTeamSpeakToolScope("tool_added_next_year")).toBe("admin");
    expect(isTeamSpeakToolVisible("tool_added_next_year", SIGNAL_SESSION)).toBe(false);
  });
});
