# image/suno-api — the house band's generator (#3554)

> **#3791: built into the one image.** The Dockerfile's `suno-builder` stage
> checks out upstream at a2e6a82 and applies `phattbeats.patch`, which is the
> exact diff the hand-built `suno-api` container ran (the 2026 UI selectors
> `patch-new-ui.py` used to apply, Turnstile via 2Captcha, the v2-web path,
> the proxy, the decrypted-audio route). It runs as program `suno-api` on
> `127.0.0.1:3000`, secrets from `/config/suno-api.env`. `deploy.sh` and
> `patch-new-ui.py` are gone.

Brandon, 2026-09-18, after MiniMax closed its Music API to the account
(HTTP 410 / status 2153 on every model id, "existing paying customers only"):

> Self-host suno-api on phattvip with my Suno cookie

So the band's songs come from [gcui-art/suno-api](https://github.com/gcui-art/suno-api),
a self-hosted service that drives a Suno **web account** the way a browser
does. It is not an official API and it is not free of moving parts:

| needs | why |
| --- | --- |
| `SUNO_COOKIE` | the logged-in suno.com session. Copy it from the browser (README step 1). It goes stale when Suno logs the browser out; the symptom is `get_limit` returning an auth error and every song failing. |
| `TWOCAPTCHA_KEY` | Suno fronts every generation with an hCaptcha. suno-api solves it through 2captcha.com, a paid service, roughly $1–3 per 1000 solves, one solve per song. **This is spend.** The key already exists in Paperclip secrets as `2CAPTCHA_API_KEY`. |
| a Suno plan | credits. A free account is 50 credits/day (10 songs); paid plans more. `GET /api/get_limit` shows what is left. |
| chromium | baked into the image by Playwright, headless, GPU off. The image is ~2 GB. |

`deploy.sh` runs it as the `suno-api` container on `phattvip`, no published
ports, secrets from `/mnt/user/appdata/suno-api/.env` (0600). Bexton is its only
client, at `http://suno-api:3000`, through the plugin's `suno-api` generator
(`openclaw-teamspeak-plugin/src/tools/band-generators.ts`): `POST /api/custom_generate`
with the title, the band-leader tag line and the lyrics, then `GET /api/get?ids=`
until the clip is `complete`, then the mp3 is downloaded into Bexton's
`/config/band-songs/` and played.

## What `patch-new-ui.py` changes, and why (2026-09-18)

Upstream's last commit was 2026-03-06 and it no longer works against suno.com
on its own. Run `python3 patch-new-ui.py src` on the checkout before
`docker build` (idempotent; it exits non-zero if upstream moved an anchor):

| Suno today | upstream | patched |
| --- | --- | --- |
| generate/v2 is gated by **Cloudflare Turnstile** (sitekey `0x4AAAAAADI7xDNyj-3LcIbi`, interaction-only). Headless chromium never passes it. | drives the page in a browser, solves **hCaptcha** with 2Captcha, waits for stale selectors (`.custom-textarea`) | asks 2Captcha for a Turnstile token (`method=turnstile`, sitekey + page URL) and puts it in the generate body as `token`. No browser. ~11 s, ~$0.0015 per song. |
| a clip's `audio_url` is the placeholder `/api/forbidden`; the file is in `media_urls` and is **encrypted** ("Mango": AES-CTR, key + IV wrapped with AES-GCM under SHA-256 of the caller's own session JWT, from `POST /api/mango/rights`). The official `GET /api/download/clip/{id}?format=mp3` answers `not_authorized` for the account's own clips. | returns `audio_url` as-is | `GET /api/audio/<clip id>` on this server fetches the media, unwraps the key exactly as suno.com's player does, and serves the plain m4a-opus. `audio_url` in every response points there for encrypted clips. |
| `wait_audio` returned at `streaming` (a partial audiopipe stream) | | waits for `complete`, up to 300 s (v6 renders a pair in 1-3 min) |
| clips land in "My Workspace" | | `SUNO_PROJECT_ID` in `.env` files them into one workspace (Brexton) via `project_id` in the generate body |

Verified live 2026-09-18: Bexton composed "Kyle's Fault", suno-api solved
Turnstile in 11 s, Suno rendered 153 s of audio in 50 s, the decrypted file
probes as mp4/opus and plays through the music lane's ffmpeg.

Suno changes its site often; when the band starts failing with the cookie
still valid, check upstream's issues first (#289 is the encrypted-media one).
