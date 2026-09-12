# image/gateway/ — the Sexton's own OpenClaw gateway (PHA-3428, option (a))

Brandon, 2026-09-12:

> **option (a)** — this container runs its own OpenClaw gateway instance with
> the teamspeak plugin installed via the PHA-3326 managed install. Do not wire
> the bridge socket out to the main gateway.

`openclaw.seed.json` is written to `/config/openclaw/openclaw.json` by
`run-gateway.sh` **on first boot only**, with the channel name and the loopback
ports substituted from env. After that the file belongs to the operator — edit
it in place, or with `docker exec sexton openclaw config …`. Re-seeding never
happens; delete the file if you want the seed back.

## Why every URL in it is 127.0.0.1

Under option (b) the plugin ran in the main gateway, a different container, so
it dialled `ws://sexton:9099` and `http://sexton:8080/inference` by container
name on `phattvip`. Option (a) puts the plugin in the same container as the
bridge, whisper and the POT provider, so all three are loopback. That is the
security win of (a) and the reason the image publishes none of those ports:
under (a) nothing outside this container has any reason to reach them.

If you ever put the container-name URLs back, you are rolling back to (b) and
you also have to re-expose the ports. `SEXTON_GATEWAY_ENABLED=0` is the
supported way to do that rollback without rebuilding.

## What the seed deliberately does NOT contain

Model credentials and an agent definition.

This is exactly the config burden option (b) was written to avoid, and it
cannot be invented in a seed file. A gateway with no model credentials starts
fine, joins the channel, and then never answers — a green healthcheck and a
dead bot. `run-gateway.sh` prints a warning at boot when it detects that state,
and `image/deploy.sh --import-gateway-config` copies the `models`, `auth`,
`agents` and `tts` blocks out of the main gateway's `openclaw.json` once, which
is the intended way to fill them.

## The music lane is enabled here, and was not in the main gateway

The main gateway's teamspeak block had `tools.music.enabled: false`, because
that container has neither `ffmpeg` nor `yt-dlp` installed and the lane could
not have worked. This image has both, pinned and build-verified, so the seed
turns the lane on and points `ytdlpPath`/`ffmpegPath` at them. That is a real
behaviour change at cutover, not a silent one — PHA-3176 is the lane's issue.

## After an OpenClaw core bump

PHA-3326's finding stands and now applies in two places: a core version bump
does not update a managed channel plugin. `run-gateway.sh` re-runs the `--link`
install every boot, which covers this container. The main gateway still needs
its own `openclaw channels status` check after any bump.
