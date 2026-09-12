# whisper — the local STT lane (PHA-3228)

> **SUPERSEDED as a container by PHA-3428.** whisper.cpp and `ggml-base.en.bin`
> are now baked into the single `phattbeats/sexton` image and run under
> supervisord beside the bot — there is no `whisper` container any more, and
> `deploy.sh` / `whisper-compose.yml` below are kept only as the record of how
> the sidecar was configured. The flags they pass are the flags
> `image/run-whisper.sh` still passes; keep the two in step. The rest of this
> file — why the lane is local at all, what the plugin requires, how to probe
> it — is unchanged and still correct, except that the hostname is now
> `sexton` rather than `whisper`:
> `http://sexton:8080/inference`.
>
> See `image/README.md`.

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

The plugin enforces this: `voice.streaming.transcription.provider` must be a
local id, and the account refuses to start otherwise
(`src/config.ts`, `LOCAL_TRANSCRIPTION_PROVIDERS`, in
[phattbeats/openclaw-teamspeak-plugin](https://github.com/phattbeats/openclaw-teamspeak-plugin)).

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
  -F response_format=json http://whisper:8080/inference
```
