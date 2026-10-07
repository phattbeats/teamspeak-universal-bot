#!/usr/bin/env node
// #3607: fan out one whisper decode to every bot in the room instead of
// one decode per bot.
//
// Each bot runs its own bridge connection into the same TeamSpeak channel and
// receives the same opus packets, so their speaker segmenters close on the
// same utterance and post byte-identical WAVs within a few hundred ms of each
// other (#3921 measured matching sample counts in pairs, 0-170 ms apart).
// Before this, that was the exact same speech decoded once per bot.
//
// This is a small transparent HTTP proxy in front of the pool workers. Every
// bot points its transcriber URL at it instead of at a worker directly.
//
// #3921: the coalescing key is the `x-speaker-client-id` header the plugin
// sends (the TS6 roster clientId, identical for every bot watching the same
// human) PLUS a hash of the multipart form content (every field, the WAV
// included, the boundary ignored). A hit therefore means the same speaker,
// the same audio and the same decode options, so answering it from another
// bot's decode is exact, not a guess, and the window can be generous. The
// first version keyed on clientId alone with an 800 ms window counted from
// the START of the first request; a decode slower than that let a second
// bot's request for the same clip miss and decode it again.
//
// Deliberately best-effort, never a hard dependency: no clientId header, a
// different clip, a body that does not parse as multipart, or a failed first
// decode all fall through to an ordinary proxied request, exactly what talking
// to a worker directly would have done.
import { createHash } from "node:crypto";
import http from "node:http";

const LISTEN_PORT = Number(process.env.WHISPER_COALESCE_PORT ?? 8082);
const BACKEND_PORTS = (process.env.WHISPER_BACKEND_PORTS ?? "8080,8081")
  .split(",")
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isFinite(port) && port > 0);
// How long a finished decode stays answerable after it completes. In-flight
// decodes are always shared, however long they take.
const COALESCE_WINDOW_MS = Number(process.env.WHISPER_COALESCE_WINDOW_MS ?? 5000);
const CLIENT_ID_HEADER = "x-speaker-client-id";

if (BACKEND_PORTS.length === 0) {
  console.error("coalescing-proxy: no backend ports configured, refusing to start");
  process.exit(1);
}

// whisper-server serialises behind one mutex, so send each fresh decode to
// the worker with the fewest requests already queued on it (round-robin on a
// tie) rather than blind round-robin.
const busy = new Map(BACKEND_PORTS.map((port) => [port, 0]));
let nextBackend = 0;
function pickBackend() {
  let best;
  for (let i = 0; i < BACKEND_PORTS.length; i += 1) {
    const port = BACKEND_PORTS[(nextBackend + i) % BACKEND_PORTS.length];
    if (best === undefined || busy.get(port) < busy.get(best)) {
      best = port;
    }
  }
  nextBackend += 1;
  return best;
}

/** key -> { promise: Promise<{status,body}>, expiresAt: number } (expiresAt = Infinity while in flight) */
const inFlight = new Map();
const stats = { requests: 0, decodes: 0, coalesced: 0 };

function forward(port, req, body) {
  busy.set(port, busy.get(port) + 1);
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    delete headers.host;
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port,
        path: req.url,
        method: req.method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    upstream.on("error", reject);
    upstream.end(body);
  }).finally(() => busy.set(port, busy.get(port) - 1));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Hash of a multipart/form-data body that ignores the boundary (each bot's
 * fetch picks its own random one): every part's name and content, sorted by
 * name. Undefined when the body is not parseable multipart, which disables
 * coalescing for that request rather than risking a wrong match.
 */
export function formHash(contentType, body) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  if (!match) {
    return undefined;
  }
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  if (start < 0) {
    return undefined;
  }
  for (;;) {
    start += delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") {
      break;
    }
    const end = body.indexOf(delimiter, start);
    if (end < 0) {
      return undefined;
    }
    // Part = CRLF headers CRLF CRLF content CRLF
    const part = body.subarray(start + 2, end - 2);
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) {
      return undefined;
    }
    const head = part.subarray(0, split).toString("latin1");
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (name === undefined) {
      return undefined;
    }
    parts.push({ name, content: part.subarray(split + 4) });
    start = end;
  }
  if (parts.length === 0) {
    return undefined;
  }
  parts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash("sha256");
  for (const { name, content } of parts) {
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

function coalesceKey(req, body) {
  const clientId = req.headers[CLIENT_ID_HEADER];
  if (typeof clientId !== "string" || clientId.length === 0) {
    return undefined;
  }
  const hash = formHash(req.headers["content-type"], body);
  return hash === undefined ? undefined : `${clientId}:${hash}`;
}

function reply(res, result) {
  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(result.body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/coalesce-stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...stats, inFlight: inFlight.size, busy: Object.fromEntries(busy) }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`bad request: ${error?.message ?? error}`);
    return;
  }

  stats.requests += 1;
  const key = coalesceKey(req, body);

  if (key) {
    const cached = inFlight.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      try {
        const result = await cached.promise;
        if (result.status >= 200 && result.status < 300) {
          stats.coalesced += 1;
          reply(res, result);
          return;
        }
      } catch {
        // The shared decode failed; fall through and try fresh.
      }
    }
  }

  stats.decodes += 1;
  const promise = forward(pickBackend(), req, body);
  const entry = { promise, expiresAt: Number.POSITIVE_INFINITY };
  if (key) {
    inFlight.set(key, entry);
  }

  let ok = false;
  try {
    const result = await promise;
    ok = result.status >= 200 && result.status < 300;
    reply(res, result);
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain" }).end(`upstream failed: ${error?.message ?? error}`);
  } finally {
    if (key && inFlight.get(key) === entry) {
      if (ok && COALESCE_WINDOW_MS > 0) {
        entry.expiresAt = Date.now() + COALESCE_WINDOW_MS;
        const timer = setTimeout(() => {
          if (inFlight.get(key) === entry) {
            inFlight.delete(key);
          }
        }, COALESCE_WINDOW_MS);
        timer.unref?.();
      } else {
        inFlight.delete(key);
      }
    }
  }
});

// Exported so tests can close it; deploy just runs this file directly (below).
export { server };

function main() {
  server.listen(LISTEN_PORT, () => {
    console.log(
      `coalescing-proxy: listening :${LISTEN_PORT} backends=${BACKEND_PORTS.join(",")} windowMs=${COALESCE_WINDOW_MS}`,
    );
  });
  // One line a minute so the dedup rate is visible in `docker logs whisper`.
  setInterval(() => {
    console.log(
      `coalescing-proxy: requests=${stats.requests} decodes=${stats.decodes} coalesced=${stats.coalesced}`,
    );
  }, 60_000).unref();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
