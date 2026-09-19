#!/usr/bin/env node
// PHA-3607: fan out one whisper decode to both bots instead of two.
//
// Sexton and bexton each run their own bridge connection into the same
// TeamSpeak channel, so their independent speaker segmenters both close on
// the same human utterance within a few hundred ms of each other. Before
// this, each bot's whisper-local transcriber posted straight to its own pool
// worker (:8080 / :8081) -- the exact same speech, decoded twice, for zero
// benefit (see PHA-3597/PHA-3598).
//
// This is a small transparent HTTP proxy in front of the two pool workers.
// Both bots point their transcriber URL at it instead of at a worker
// directly. It keys on the `x-speaker-client-id` header the plugin sends
// (src/voice/whisper-local.ts, PHA-3607) -- the TS6 roster clientId, which is
// assigned by the TeamSpeak server itself and so is identical for both bots
// watching the same human. A second request for the same clientId arriving
// while the first is still in flight (or briefly after it finishes) is
// answered from the first request's result instead of opening a second
// decode.
//
// Deliberately best-effort, never a hard dependency: no clientId header, no
// coalescing window hit (segments drifted apart, only one bot ever asked, the
// window already expired) -- any of those just falls through to an ordinary
// independent proxied request against one of the two workers, exactly what
// talking to a worker directly would have done.
import http from "node:http";

const LISTEN_PORT = Number(process.env.WHISPER_COALESCE_PORT ?? 8082);
const BACKEND_PORTS = (process.env.WHISPER_BACKEND_PORTS ?? "8080,8081")
  .split(",")
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isFinite(port) && port > 0);
const COALESCE_WINDOW_MS = Number(process.env.WHISPER_COALESCE_WINDOW_MS ?? 800);
const CLIENT_ID_HEADER = "x-speaker-client-id";

if (BACKEND_PORTS.length === 0) {
  console.error("coalescing-proxy: no backend ports configured, refusing to start");
  process.exit(1);
}

let nextBackend = 0;
function pickBackend() {
  const port = BACKEND_PORTS[nextBackend % BACKEND_PORTS.length];
  nextBackend += 1;
  return port;
}

/** clientId (string) -> { promise: Promise<{status,body}>, expiresAt: number } */
const inFlight = new Map();

function forward(port, req, body) {
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
      },
    );
    upstream.on("error", reject);
    upstream.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function coalesceKey(req) {
  const value = req.headers[CLIENT_ID_HEADER];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

const server = http.createServer(async (req, res) => {
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

  const key = coalesceKey(req);
  const now = Date.now();

  if (key) {
    const cached = inFlight.get(key);
    if (cached && cached.expiresAt > now) {
      try {
        const result = await cached.promise;
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.body);
        return;
      } catch {
        // The coalesced request itself failed; fall through and try fresh.
      }
    }
  }

  const backend = pickBackend();
  const promise = forward(backend, req, body);
  if (key) {
    inFlight.set(key, { promise, expiresAt: now + COALESCE_WINDOW_MS });
  }

  try {
    const result = await promise;
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body);
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain" }).end(`upstream failed: ${error?.message ?? error}`);
  } finally {
    if (key) {
      const timer = setTimeout(() => {
        if (inFlight.get(key)?.promise === promise) {
          inFlight.delete(key);
        }
      }, COALESCE_WINDOW_MS);
      timer.unref?.();
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
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
