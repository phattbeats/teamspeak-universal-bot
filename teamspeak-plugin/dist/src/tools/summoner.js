const DEFAULT_URL = "http://ts-summoner:8099";
const TIMEOUT_MS = 5e3;
function summonerUrl(config) {
  if (config?.enabled === false) {
    return void 0;
  }
  return (config?.url?.trim() || DEFAULT_URL).replace(/\/+$/u, "");
}
function selfBotId(config, env = process.env) {
  return config?.self?.trim() || env.SEXTON_AGENT_ID?.trim() || "sexton";
}
async function post(base, path, body, fetchFn = fetch) {
  const response = await fetchFn(`${base}${path}`, {
    method: "POST",
    ...body !== void 0 ? { body, headers: { "Content-Type": "text/plain" } } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
  }
  return { status: response.status, json };
}
async function summonerAction(config, action, name, by, fetchFn = fetch) {
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
      void 0,
      fetchFn
    );
    if (status === 404) {
      return { ok: false, error: `There is nobody called ${name} you can call in or send home.` };
    }
    if (status >= 300) {
      return { ok: false, error: "Couldn't get hold of them just now." };
    }
    const who = typeof json.bot === "string" ? json.bot : bot;
    const wasHere = json.running === true;
    return action === "summon" ? {
      ok: true,
      bot: who,
      note: wasHere ? `${who} is already here.` : `${who} is on the way; they show up in the channel within a minute or so.`
    } : {
      ok: true,
      bot: who,
      note: wasHere ? `${who} is heading out and drops off within a minute or so.` : `${who} wasn't here anyway.`
    };
  } catch {
    return { ok: false, error: "Couldn't get hold of them just now." };
  }
}
function forwardHeard(config, text, by, log, fetchFn = fetch) {
  const base = summonerUrl(config);
  if (!base || config?.forwardHeard === false || !text.trim()) {
    return;
  }
  void post(base, `/heard?by=${encodeURIComponent(by)}`, text, fetchFn).then(({ json }) => {
    if (Array.isArray(json.summoned) && json.summoned.length) {
      log?.(`teamspeak summoner: ${by}'s words summoned ${json.summoned.join(",")}`);
    }
  }).catch(() => void 0);
}
export {
  forwardHeard,
  selfBotId,
  summonerAction,
  summonerUrl
};
