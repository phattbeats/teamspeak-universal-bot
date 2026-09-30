import { describe, expect, it } from "vitest";
import { parseTeamSpeakCommand } from "../src/voice/commands.js";
import { forwardHeard, summonerAction, summonerUrl } from "../src/tools/summoner.js";

type Call = { url: string; body?: unknown };

function fakeFetch(status: number, json: unknown, calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

describe("ts-summoner client (PHA-3823)", () => {
  it("defaults to the phattvip sidecar and can be switched off", () => {
    expect(summonerUrl(undefined)).toBe("http://ts-summoner:8099");
    expect(summonerUrl({ url: "http://x:1/" })).toBe("http://x:1");
    expect(summonerUrl({ enabled: false })).toBeUndefined();
  });

  it("summons by name and words the result for a person to say", async () => {
    const calls: Call[] = [];
    const result = await summonerAction(undefined, "summon", "Bexton!", "sexton for Brandon", fakeFetch(200, { bot: "bexton", running: false }, calls));
    expect(calls[0]?.url).toBe("http://ts-summoner:8099/summon/bexton?by=sexton%20for%20Brandon");
    expect(result).toMatchObject({ ok: true, bot: "bexton" });
    expect(String(result.note)).toMatch(/on the way/u);
    expect(JSON.stringify(result)).not.toMatch(/api|http|server|tool/iu);
  });

  it("says so when the bot is already here, or unknown", async () => {
    const calls: Call[] = [];
    const here = await summonerAction(undefined, "summon", "lex", "x", fakeFetch(200, { bot: "lexton", running: true }, calls));
    expect(String(here.note)).toMatch(/already here/u);
    const nobody = await summonerAction(undefined, "dismiss", "Gerald", "x", fakeFetch(404, { error: "unknown bot gerald" }, calls));
    expect(nobody).toMatchObject({ ok: false });
  });

  it("forwards transcripts to /heard, never throwing", async () => {
    const calls: Call[] = [];
    forwardHeard(undefined, "lexton is a clown", "Brandon", undefined, fakeFetch(200, { summoned: ["lexton"] }, calls));
    forwardHeard(undefined, "   ", "Brandon", undefined, fakeFetch(200, {}, calls));
    forwardHeard({ forwardHeard: false }, "lex sucks", "Brandon", undefined, fakeFetch(200, {}, calls));
    forwardHeard(undefined, "boom", "Brandon", undefined, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ url: "http://ts-summoner:8099/heard?by=Brandon", body: "lexton is a clown" }]);
  });
});

describe("!vc dismiss", () => {
  const msg = (text: string) => ({ clientId: 4, nickname: "Brandon", text, target: "channel" }) as never;
  it("dismisses this bot with no name, another with one", () => {
    expect(parseTeamSpeakCommand(msg("!vc dismiss"))).toMatchObject({ ok: true, parsed: { command: { kind: "vc-dismiss" } } });
    expect(parseTeamSpeakCommand(msg("!vc dismiss bexton"))).toMatchObject({ ok: true, parsed: { command: { kind: "vc-dismiss", bot: "bexton" } } });
  });
});
