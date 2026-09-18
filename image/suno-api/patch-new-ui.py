#!/usr/bin/env python3
"""PHA-3554: make gcui-art/suno-api (a2e6a82, 2026-03-06) drive the Suno UI
that shipped after it.

suno-api never calls hCaptcha itself. To get a captcha token it opens
suno.com/create in headless chromium, types into the prompt box, clicks
Create, lets 2Captcha solve the challenge that pops up, and then intercepts
the browser's own /api/generate/v2/ request to steal the token (and aborts
that request so the browser never spends credits). Every step of that is a
DOM selector, and Suno redesigned the page in 2026:

  * `.custom-textarea` is gone. The create panel opens in "simple" mode with
    one description <textarea maxlength> overlaying the lyrics editor.
  * the button is `aria-label="Create song"`, not `"Create"`, and it has no
    `div.flex` child worth clicking.
  * the song-list call the code waited on can be `/api/project/me` with no
    query string.
  * hCaptcha is served from Suno's own hosts (hcaptcha-assets-prod.suno.com,
    hcaptcha-endpoint-prod.suno.com), so the "wait until the challenge
    images stop loading" helper, which only watched img*.hcaptcha.com,
    resolved instantly and 2Captcha was sent a blank screenshot.

Run against the checkout before `docker build`:
    python3 patch-new-ui.py /mnt/user/appdata/suno-api/src
Idempotent: a second run is a no-op. Upstream PR #277 documents the same
breakage ("the v5.5 redesign removed the .custom-textarea selector") but only
adds a manual mode; PR #271 rewrites the flow and is unmerged. Revisit if
either lands.
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
api = root / "src/lib/SunoApi.ts"
utils = root / "src/lib/utils.ts"

EDITS = {
    api: [
        (
            "await page.waitForResponse('**/api/project/**\\\\?**', { timeout: 60000 }); // wait for song list API call",
            "await page.waitForResponse((r: any) => r.url().includes('/api/project/'), { timeout: 60000 })"
            ".catch(() => logger.info('song list call not seen in 60s; continuing')); // PHA-3554: new UI may load /api/project/me with no query",
        ),
        (
            "const textarea = page.locator('.custom-textarea');",
            "const textarea = page.locator('.custom-textarea, textarea[maxlength], textarea:visible').first(); // PHA-3554: new UI",
        ),
        (
            "const button = page.locator('button[aria-label=\"Create\"]').locator('div.flex');",
            "const button = page.locator('button[aria-label=\"Create song\"], button[aria-label=\"Create\"]').first(); // PHA-3554: new UI",
        ),
        (
            "          const request = route.request();\n          this.currentToken",
            "          const request = route.request();\n"
            "          try { const b = request.postDataJSON() || {}; logger.info('generate/v2 body keys: ' + Object.keys(b).join(',') + ' project_id=' + String(b.project_id)); } catch (e) {}\n"
            "          this.currentToken",
        ),
    ],
    utils: [
        (
            "const urlPattern = /^https:\\/\\/img[a-zA-Z0-9]*\\.hcaptcha\\.com\\/.*$/;",
            "const urlPattern = /^https:\\/\\/[^/]*hcaptcha[^/]*\\/.*$/; // PHA-3554: Suno fronts hCaptcha with its own hosts",
        ),
    ],
}

TURNSTILE = '''  public async getCaptcha(): Promise<string|null> {
    // PHA-3554: Suno gates /api/generate/v2/ with Cloudflare Turnstile now
    // (sitekey below, "interaction-only"), not hCaptcha. Headless chromium
    // never passes it, but 2Captcha solves Turnstile from the sitekey + page
    // URL alone and the resulting token is accepted by generate/v2 as
    // `token`. So: no browser, no DOM selectors. ~$0.0015 and ~5-15 s per song.
    const sitekey = process.env.SUNO_TURNSTILE_SITEKEY || '0x4AAAAAADI7xDNyj-3LcIbi';
    const pageurl = 'https://suno.com/create';
    const key = process.env.TWOCAPTCHA_KEY + '';
    const base = 'https://2captcha.com';
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        logger.info('Requesting a Turnstile token from 2Captcha');
        const inRes: any = await fetch(`${base}/in.php?` + new URLSearchParams({ key, method: 'turnstile', sitekey, pageurl, json: '1' })).then((r) => r.json());
        if (inRes.status !== 1) throw new Error('2Captcha in.php: ' + JSON.stringify(inRes));
        const id = String(inRes.request);
        const started = Date.now();
        while (Date.now() - started < 180000) {
          await sleep(5, 5);
          const res: any = await fetch(`${base}/res.php?` + new URLSearchParams({ key, action: 'get', id, json: '1' })).then((r) => r.json());
          if (res.status === 1) {
            logger.info(`Turnstile token received after ${Math.round((Date.now() - started) / 1000)}s`);
            return String(res.request);
          }
          if (res.request !== 'CAPCHA_NOT_READY') throw new Error('2Captcha res.php: ' + JSON.stringify(res));
        }
        throw new Error('2Captcha: no Turnstile token within 180s');
      } catch (err: any) {
        lastErr = err;
        logger.info('Turnstile attempt ' + (attempt + 1) + ' failed: ' + err.message);
      }
    }
    throw lastErr;
  }

  /** PHA-3554: the browser-driven hCaptcha flow this replaced. Unused; kept for diffing against upstream. */
  public async getCaptchaLegacy(): Promise<string|null> {
'''

changed = 0
# Swap the browser/hCaptcha captcha routine for a browserless Turnstile one.
text = api.read_text()
if "getCaptchaLegacy" not in text:
    anchor = "  public async getCaptcha(): Promise<string|null> {\n"
    if anchor not in text:
        sys.exit(f"{api}: getCaptcha anchor not found")
    text = text.replace(anchor, TURNSTILE, 1)
    api.write_text(text)
    changed += 1

# File every generation into one Suno workspace (Brandon's "Brexton") when
# SUNO_PROJECT_ID is set; Suno's own client sends project_id in this body.
EDITS[api].append(
    (
        "      token: await this.getCaptcha()\n    };\n",
        "      token: await this.getCaptcha()\n    };\n"
        "    if (process.env.SUNO_PROJECT_ID) payload.project_id = process.env.SUNO_PROJECT_ID; // PHA-3554\n",
    )
)

# Since 2026-08 (upstream issue #289) a clip's `audio_url` is the placeholder
# https://studio-api.prod.suno.com/api/forbidden. The playable file is in
# `media_urls` (an unencrypted "progressive" m4a-opus on CloudFront, no auth).
# Prefer that whenever audio_url is missing or the placeholder.
EDITS[api].extend(
    [
        (
            "export const DEFAULT_MODEL = 'chirp-v3-5';\n",
            "export const DEFAULT_MODEL = 'chirp-v3-5';\n"
            "\n"
            "/** PHA-3554: Suno's audio_url is an /api/forbidden placeholder since 2026-08; the file is in media_urls. */\n"
            "export const pickAudioUrl = (clip: any): string | undefined => {\n"
            "  const direct = typeof clip?.audio_url === 'string' ? clip.audio_url : '';\n"
            "  const media: any[] = Array.isArray(clip?.media_urls) ? clip.media_urls : [];\n"
            "  const pick = media.find((m) => m?.url && !m.encrypted && m.delivery === 'progressive')\n"
            "    ?? media.find((m) => m?.url && !m.encrypted);\n"
            "  if (pick?.url) return pick.url; // the whole file, no auth, no expiry seen\n"
            "  if (direct && !direct.endsWith('/api/forbidden')) return direct; // audiopipe stream while still rendering\n"
            "  return undefined;\n"
            "};\n",
        ),
        # wait_audio used to return at "streaming" (audiopipe URL, partial file,
        # 403s without a token). The band wants the finished file, so wait for
        # "complete", which is when media_urls carries it.
        (
            "          (audio) => audio.status === 'streaming' || audio.status === 'complete'\n",
            "          (audio) => audio.status === 'complete' // PHA-3554: was streaming||complete\n",
        ),
        (
            "        lyric: audio.metadata.prompt,\n        audio_url: audio.audio_url,",
            "        lyric: audio.metadata.prompt,\n        audio_url: pickAudioUrl(audio), // PHA-3554",
        ),
        (
            "        : '',\n      audio_url: audio.audio_url,",
            "        : '',\n      audio_url: pickAudioUrl(audio), // PHA-3554",
        ),
        # Suno v6 takes 1-3 minutes per pair of clips; upstream gave up after 100 s.
        (
            "      while (Date.now() - startTime < 100000) {",
            "      while (Date.now() - startTime < 300000) { // PHA-3554: was 100 s, v6 songs take longer",
        ),
    ]
)

for file, edits in EDITS.items():
    text = file.read_text()
    for old, new in edits:
        if new in text:
            continue
        if old not in text:
            sys.exit(f"{file}: anchor not found, upstream moved: {old[:70]!r}")
        text = text.replace(old, new, 1)
        changed += 1
    file.write_text(text)
print(f"patch-new-ui: {changed} edit(s) applied")
