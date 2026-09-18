# image/suno-api — the house band's generator (PHA-3554)

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

Upstream's last commit was 2026-03-07. Suno changes its site often; when the
band starts failing with the cookie still valid, check upstream's issues first.
