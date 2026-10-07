// #3607: the coalescing proxy, tested in isolation with two fake whisper
// backends. Run with `node --test whisper/coalescing-proxy.test.mjs` -- no
// deps beyond Node itself, matching the rest of this directory (plain sh +
// binaries, no package.json).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";

/** A fake whisper-server worker: counts calls and answers after a tick. */
function startFakeBackend(text, delayMs = 30) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    // Simulate decode latency so overlapping requests actually overlap.
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text }));
  });
  return { server, getCalls: () => calls };
}

async function listen(server) {
  server.listen(0);
  await once(server, "listening");
  return server.address().port;
}

async function startProxy() {
  const mod = await import(`./coalescing-proxy.mjs?t=${Date.now()}-${Math.random()}`);
  const port = await listen(mod.server);
  return { server: mod.server, port };
}

let boundarySeq = 0;
/** A multipart body shaped like whisper-local.ts sends, with its own boundary per call. */
function multipart(audio, { boundary = `b${(boundarySeq += 1)}x${Math.random()}`, format = "json" } = {}) {
  const field = (name, value, extra = "") =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`;
  const body =
    field("file", audio, '; filename="segment.wav"\r\nContent-Type: audio/wav') +
    field("response_format", format) +
    field("temperature", "0") +
    `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function post(port, { clientId, audio = "fake-wav-bytes", format } = {}) {
  const { body, contentType } = multipart(audio, { format });
  return new Promise((resolve, reject) => {
    const headers = { "content-type": contentType };
    if (clientId !== undefined) {
      headers["x-speaker-client-id"] = String(clientId);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: "/inference", method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const totalCalls = (backends) => backends.reduce((sum, b) => sum + b.getCalls(), 0);

async function withProxy(t, { windowMs = 800, backendCount = 2, delayMs = 30 } = {}, run) {
  const backends = await Promise.all(
    Array.from({ length: backendCount }, (_, i) => startFakeBackend(`backend-${i}`, delayMs)),
  );
  const ports = await Promise.all(backends.map((b) => listen(b.server)));

  process.env.WHISPER_BACKEND_PORTS = ports.join(",");
  process.env.WHISPER_COALESCE_WINDOW_MS = String(windowMs);

  const proxy = await startProxy();

  t.after(() => {
    for (const backend of backends) backend.server.close();
    proxy.server.close();
  });

  await run({ proxyPort: proxy.port, backends });
}

test("coalesces two requests for the same clientId into one backend call", async (t) => {
  await withProxy(t, {}, async ({ proxyPort, backends }) => {
    const [first, second] = await Promise.all([
      post(proxyPort, { clientId: 7 }),
      post(proxyPort, { clientId: 7 }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // Both callers get the identical decoded text -- the whole point of
    // fanning one decode out to both bots.
    assert.equal(first.body, second.body);
    const totalCalls = backends.reduce((sum, b) => sum + b.getCalls(), 0);
    assert.equal(totalCalls, 1);
  });
});

test("does not coalesce requests for different clientIds", async (t) => {
  await withProxy(t, {}, async ({ proxyPort, backends }) => {
    await Promise.all([post(proxyPort, { clientId: 7 }), post(proxyPort, { clientId: 9 })]);

    const totalCalls = backends.reduce((sum, b) => sum + b.getCalls(), 0);
    assert.equal(totalCalls, 2);
  });
});

test("does not coalesce requests with no clientId header", async (t) => {
  await withProxy(t, {}, async ({ proxyPort, backends }) => {
    await Promise.all([post(proxyPort, {}), post(proxyPort, {})]);

    const totalCalls = backends.reduce((sum, b) => sum + b.getCalls(), 0);
    assert.equal(totalCalls, 2);
  });
});

test("opens a fresh decode once the coalescing window has passed", async (t) => {
  await withProxy(t, { windowMs: 30 }, async ({ proxyPort, backends }) => {
    await post(proxyPort, { clientId: 7 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await post(proxyPort, { clientId: 7 });

    const totalCalls = backends.reduce((sum, b) => sum + b.getCalls(), 0);
    assert.equal(totalCalls, 2);
  });
});

test("does not coalesce the same speaker saying something different", async (t) => {
  await withProxy(t, {}, async ({ proxyPort, backends }) => {
    await Promise.all([
      post(proxyPort, { clientId: 7, audio: "first-clip" }),
      post(proxyPort, { clientId: 7, audio: "second-clip" }),
    ]);
    assert.equal(totalCalls(backends), 2);
  });
});

test("does not coalesce the same clip asked for with different decode options", async (t) => {
  await withProxy(t, {}, async ({ proxyPort, backends }) => {
    await Promise.all([
      post(proxyPort, { clientId: 7, format: "json" }),
      post(proxyPort, { clientId: 7, format: "verbose_json" }),
    ]);
    assert.equal(totalCalls(backends), 2);
  });
});

test("a decode slower than the window is still shared while in flight (#3921)", async (t) => {
  await withProxy(t, { windowMs: 20, delayMs: 120 }, async ({ proxyPort, backends }) => {
    const first = post(proxyPort, { clientId: 7 });
    await sleep(60);
    const second = post(proxyPort, { clientId: 7 });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.body, b.body);
    assert.equal(totalCalls(backends), 1);
  });
});

test("a finished decode answers a late duplicate inside the window", async (t) => {
  await withProxy(t, { windowMs: 500 }, async ({ proxyPort, backends }) => {
    await post(proxyPort, { clientId: 7 });
    await sleep(50);
    await post(proxyPort, { clientId: 7 });
    assert.equal(totalCalls(backends), 1);
  });
});

test("fresh decodes go to the least busy worker", async (t) => {
  await withProxy(t, { delayMs: 80 }, async ({ proxyPort, backends }) => {
    await Promise.all([
      post(proxyPort, { clientId: 1, audio: "a" }),
      post(proxyPort, { clientId: 2, audio: "b" }),
    ]);
    assert.deepEqual(
      backends.map((b) => b.getCalls()),
      [1, 1],
    );
  });
});

test("formHash ignores the boundary and returns undefined for non-multipart", async () => {
  const { formHash } = await import("./coalescing-proxy.mjs");
  const one = multipart("same-audio", { boundary: "aaa" });
  const two = multipart("same-audio", { boundary: "zzz-other" });
  const hashOne = formHash(one.contentType, Buffer.from(one.body));
  assert.ok(hashOne);
  assert.equal(hashOne, formHash(two.contentType, Buffer.from(two.body)));
  assert.equal(formHash("application/octet-stream", Buffer.from("raw")), undefined);
});
