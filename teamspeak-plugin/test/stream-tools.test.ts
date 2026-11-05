/**
 * PHA-4499 screen-share queue tools: argument checks and what reaches the
 * Sexton's stream actor. The actor itself (queue order, playlists, swaps
 * under live viewers) is Rust and tested there.
 */
import { describe, expect, it } from "vitest";
import {
  buildTeamSpeakTools,
  createTeamSpeakToolRegistration,
  EDIT_STREAM_QUEUE_TOOL,
  SKIP_STREAM_TOOL,
  STREAM_PLAYLIST_TOOL,
  STREAM_URL_TOOL,
  type StreamController,
  type TeamSpeakToolDeps,
} from "../src/tools/registry.js";

function harness(reply: { ok: boolean; detail: string } = { ok: true, detail: "{}" }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const stream: StreamController = {
    start: async (...args) => (calls.push({ fn: "start", args }), reply),
    stop: async () => (calls.push({ fn: "stop", args: [] }), reply),
    status: async () => (calls.push({ fn: "status", args: [] }), reply),
    queue: async (...args) => (calls.push({ fn: "queue", args }), reply),
  };
  const deps = { stream, roster: () => [], channelName: () => "General" } as unknown as TeamSpeakToolDeps;
  const registration = createTeamSpeakToolRegistration(deps);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await registration.handle(
      { itemId: "i", callId: `c-${name}`, name, args },
      { clientId: 4, nickname: "Brandon" },
    )) as Record<string, unknown> & { ok: boolean };
  return { calls, call };
}

describe("stream queue tools", () => {
  it("are offered with the stream lane", () => {
    const names = buildTeamSpeakTools({ music: false, stream: true }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([STREAM_URL_TOOL, SKIP_STREAM_TOOL, EDIT_STREAM_QUEUE_TOOL, STREAM_PLAYLIST_TOOL]));
  });

  it("takes links from any site and passes mode and playlist through", async () => {
    const h = harness({ ok: true, detail: JSON.stringify({ queued: 2, title: "Clip" }) });
    const r = await h.call(STREAM_URL_TOOL, { url: "https://rumble.com/v4abc-x.html", mode: "NEXT", playlist: true });
    expect(r).toMatchObject({ ok: true, queued: 2, title: "Clip" });
    expect(String(r.note)).toContain("Queued");
    expect(h.calls).toEqual([{ fn: "start", args: ["https://rumble.com/v4abc-x.html", undefined, { mode: "next", playlist: true }] }]);
  });

  it("refuses something that is not a link", async () => {
    const h = harness();
    expect((await h.call(STREAM_URL_TOOL, { url: "ftp://x" })).ok).toBe(false);
    expect((await h.call(STREAM_URL_TOOL, { url: "pgl stream" })).ok).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("skips and edits the queue", async () => {
    const h = harness();
    await h.call(SKIP_STREAM_TOOL);
    await h.call(EDIT_STREAM_QUEUE_TOOL, { action: "move", position: 3, to: 1 });
    await h.call(EDIT_STREAM_QUEUE_TOOL, { action: "shuffle" });
    expect(h.calls).toEqual([
      { fn: "queue", args: ["skip"] },
      { fn: "queue", args: ["move", { index: 3, to: 1 }] },
      { fn: "queue", args: ["shuffle", {}] },
    ]);
    expect((await h.call(EDIT_STREAM_QUEUE_TOOL, { action: "remove" })).ok).toBe(false);
  });

  it("saves, loads and lists playlists", async () => {
    const h = harness();
    await h.call(STREAM_PLAYLIST_TOOL, { action: "save", name: "CS night" });
    await h.call(STREAM_PLAYLIST_TOOL, { action: "load", name: "CS night", mode: "now" });
    await h.call(STREAM_PLAYLIST_TOOL, { action: "list" });
    expect(h.calls).toEqual([
      { fn: "queue", args: ["save", { name: "CS night" }] },
      { fn: "queue", args: ["load", { name: "CS night", mode: "now" }] },
      { fn: "queue", args: ["playlists"] },
    ]);
    expect((await h.call(STREAM_PLAYLIST_TOOL, { action: "load" })).ok).toBe(false);
  });

  it("turns an actor refusal into an error", async () => {
    const h = harness({ ok: false, detail: "nothing is playing" });
    expect(await h.call(SKIP_STREAM_TOOL)).toEqual({ ok: false, error: "nothing is playing" });
  });
});
