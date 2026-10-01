/**
 * The ts-summoner sidecar (PHA-3821/PHA-3823): it owns the bots' shifts and
 * is the only thing that can bring a fully disconnected bot back, because a
 * bot that is off duty has no core running to hear anything. A bot that IS in
 * the channel reaches it over HTTP on the phattvip network:
 *
 *   POST /summon/<bot>?by=  POST /dismiss/<bot>?by=  POST /heard?by= (body: transcript)
 *
 * `<bot>` may be any name in the summoner's config (`lex`, `luthor`, `bex`),
 * so the word lists and the trash-talk cooldown live in one place: there.
 */

export type TeamSpeakSummonerConfig = {
  /** Default: true. */
  enabled?: boolean;
  /** Default: http://ts-summoner:8099. */
  url?: string;
  /** Forward every non-empty STT transcript to `/heard` (Lexton's trash-talk crash-in). Default: true. */
  forwardHeard?: boolean;
};

export type SummonerResult = Record<string, unknown> & { ok: boolean };

const DEFAULT_URL = "http://ts-summoner:8099";
const TIMEOUT_MS = 5_000;

export function summonerUrl(config: TeamSpeakSummonerConfig | undefined): string | undefined {
  if (config?.enabled === false) {
    return undefined;
  }
  return (config?.url?.trim() || DEFAULT_URL).replace(/\/+$/u, "");
}

/** This bot's own id at the summoner: the agent id, which is the container name. */
export function selfBotId(env: Record<string, string | undefined> = process.env): string {
  return env.SEXTON_AGENT_ID?.trim() || "sexton";
}

async function post(
  base: string,
  path: string,
  body?: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetchFn(`${base}${path}`, {
    method: "POST",
    ...(body !== undefined ? { body, headers: { "Content-Type": "text/plain" } } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // an empty or non-JSON body is still a status code
  }
  return { status: response.status, json };
}

/**
 * Summon or dismiss a bot. The result is worded for the agent to relay in its
 * own voice: no URLs, no "the API said", just who is coming or going.
 */
export async function summonerAction(
  config: TeamSpeakSummonerConfig | undefined,
  action: "summon" | "dismiss",
  name: string,
  by: string,
  fetchFn: typeof fetch = fetch,
): Promise<SummonerResult> {
  const base = summonerUrl(config);
  if (!base) {
    return { ok: false, error: "You have no way to reach the others right now." };
  }
  const bot = name.trim().toLowerCase().replace(/[^a-z ]+/gu, "").trim();
  if (!bot) {
    return { ok: false, error: "Say who." };
  }
  try {
    const { status, json } = await post(
      base,
      `/${action}/${encodeURIComponent(bot)}?by=${encodeURIComponent(by)}`,
      undefined,
      fetchFn,
    );
    if (status === 404) {
      return { ok: false, error: `There is nobody called ${name} you can call in or send home.` };
    }
    if (status >= 300) {
      return { ok: false, error: "Couldn't get hold of them just now." };
    }
    const who = typeof json.bot === "string" ? json.bot : bot;
    const wasHere = json.running === true;
    return action === "summon"
      ? {
          ok: true,
          bot: who,
          note: wasHere
            ? `${who} is already here.`
            : `${who} is on the way; they show up in the channel within a minute or so.`,
        }
      : {
          ok: true,
          bot: who,
          note: wasHere
            ? `${who} is heading out and drops off within a minute or so.`
            : `${who} wasn't here anyway.`,
        };
  } catch {
    return { ok: false, error: "Couldn't get hold of them just now." };
  }
}

/** Fire-and-forget: hand a transcript to the summoner's voice rules. Never throws. */
export function forwardHeard(
  config: TeamSpeakSummonerConfig | undefined,
  text: string,
  by: string,
  log?: (message: string) => void,
  fetchFn: typeof fetch = fetch,
): void {
  const base = summonerUrl(config);
  if (!base || config?.forwardHeard === false || !text.trim()) {
    return;
  }
  void post(base, `/heard?by=${encodeURIComponent(by)}`, text, fetchFn)
    .then(({ json }) => {
      if (Array.isArray(json.summoned) && json.summoned.length) {
        log?.(`teamspeak summoner: ${by}'s words summoned ${json.summoned.join(",")}`);
      }
    })
    .catch(() => undefined);
}
