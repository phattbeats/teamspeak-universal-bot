# whisper — the local STT lane (PHA-3228)

> **Back as a container since PHA-3598, as a pool.** PHA-3428 baked whisper.cpp
> and `ggml-base.en.bin` into the `phattbeats/sexton` image and ran one server
> inside each bot. With two bots in one channel that was two decoders doing the
> same work; `deploy.sh` here now runs that same image as a third container
> named `whisper` with `run-whisper-pool.sh` as the entrypoint: N
> `whisper-server` processes on consecutive ports (`:8080`, `:8081`, ...) plus
> silero VAD in front of the decoder. `whisper-compose.yml` is the old
> single-server sidecar and is kept only as a record. `verify.sh` still works
> against `whisper:8080`. See `image/README.md`, "The shared whisper pool".
>
> whisper.cpp's server has no request-level parallelism: it serialises behind
> one mutex. That is why the pool is one process per worker and not one
> server with a flag.
>
> **PHA-3607: a coalescing proxy sits in front of the pool, one port past the
> workers (`:8082` for the default 2-worker pool).** Sexton and bexton each
> hear the exact same channel audio and independently segment it, so their
> speaker sessions close on the same utterance within a few hundred ms of each
> other — before this, that meant two whisper decodes of identical speech.
> `coalescing-proxy.mjs` keys on the `x-speaker-client-id` header the plugin
> sends (the TS6 roster clientId, which TeamSpeak assigns once and both bots
> see identically) and answers a near-simultaneous second request from the
> first request's result instead of opening a second decode. `image/deploy.sh`
> / `image/deploy-bexton.sh` now point **both** bots at `:8082`
> (`SEXTON_WHISPER_URL`) instead of one worker port each; the proxy
> round-robins across the real workers exactly as pinning each bot to its own
> port used to, so a coalescing miss (no header, window expired, only one bot
> ever asked) costs nothing extra. Set `WHISPER_COALESCE_ENABLED=0` on the
> `whisper` container to go back to running bare workers with no proxy in
> front, and point the bots at `:8080`/`:8081` directly again.
> `whisper/coalescing-proxy.test.mjs` (`node --test`) covers the proxy in
> isolation against two fake backends.

The `voice.mode=stt-tts` lane transcribes speaker audio here, on the TS6 host's
own Docker network, and nowhere else.

That is not a performance decision. It is the two constraints Brandon set on
PHA-3177, expressed as a container:

- **$0 marginal cost.** Every transcription provider OpenClaw registers
  (deepgram, openai, elevenlabs, mistral) bills per minute of audio. A hot mic
  in a voice channel is a lot of minutes.
- **The mic stays in the house.** The channel welcome notice says the Sexton
  does not ship your voice to a third party. Anything hosted here breaks a
  stated promise, not just a budget line.

The plugin enforces this: `voice.streaming.transcription.provider` must name a
provider the STT registry declares `kind: "local"`, or the account refuses to
start. Since PHA-3790 that is a slot rule rather than a hardcoded allowlist — a
hosted provider *can* be the primary, but only when the same config block also
says `allowHosted: true`, which is a deliberate act with a name on it. See
`teamspeak-plugin/src/voice/stt-provider.ts` and `stt-registry.ts`, and
[docs/universal-bot/STT-PROVIDERS.md](../docs/universal-bot/STT-PROVIDERS.md).

## What runs

[whisper.cpp]'s bundled HTTP server, from the upstream image
`ghcr.io/ggml-org/whisper.cpp:main`. It answers `POST /inference` with
multipart form-data (`file`, `response_format=json`, `language`, `temperature`)
and returns `{"text": "..."}` — which is exactly what
`src/voice/whisper-local.ts` speaks (same repo as above).

CPU only. There is no GPU on PHATT-RAID, and `base.en` on CPU transcribes a few
seconds of speech in a few hundred milliseconds, which fits the lane's 1.5-3s
first-audio budget with room to spare.

[whisper.cpp]: https://github.com/ggml-org/whisper.cpp

## Model

`ggml-base.en.bin` (148 MB) is the default: English-only, small enough to stay
resident, and accurate enough for channel speech.

| model          | size   | notes                                              |
| -------------- | ------ | -------------------------------------------------- |
| `tiny.en`      | 78 MB  | fastest; drops proper nouns, misses the wake name   |
| `base.en`      | 148 MB | the default                                        |
| `small.en`     | 488 MB | noticeably better on crosstalk; ~3x the CPU time    |

If wake-name matching is flaky in a busy channel, move up to `small.en` before
touching the wake-name list — the SDK's matcher already tolerates fuzzy
hearings, and a bigger model gives it better ones to work with.

## Deploy

On PHATT-RAID (10.0.0.100). Unraid has docker but no compose plugin, so
`deploy.sh` is the `docker run` form of `whisper-compose.yml`; keep the two in
step, the same way `sexton/deploy/` does.

```bash
scp whisper/deploy.sh root@10.0.0.100:/mnt/user/appdata/whisper/deploy.sh
ssh root@10.0.0.100 'bash /mnt/user/appdata/whisper/deploy.sh'
```

It downloads the model once into `/mnt/user/appdata/whisper/models` and starts
the container on the `phattvip` network as `whisper`, which is the hostname the
plugin's default `http://whisper:8080/inference` resolves to.

## Verify

```bash
ssh root@10.0.0.100 'bash /mnt/user/appdata/whisper/verify.sh'
```

Synthesizes a WAV, posts it, and prints the transcript. Run it from the gateway
container instead if you want to prove the *network path* the plugin uses:

```bash
docker exec openclaw-sexton curl -sS -F file=@/tmp/probe.wav \
  -F response_format=json http://whisper:8082/inference
```

To verify the coalescing proxy specifically (`URL=http://127.0.0.1:8082/inference bash verify.sh`
against the same worker twice with the same `-H 'x-speaker-client-id: 1'` should
answer the second call near-instantly instead of paying for a second decode),
or run its own isolated test: `node --test whisper/coalescing-proxy.test.mjs`.
