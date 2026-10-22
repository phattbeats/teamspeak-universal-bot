# Admin dashboard: the Bots tab (#4374)

The insights dashboard (`http://<PHATT-RAID>:8098`, login in
`config/insights/auth.txt`; see [INSIGHTS.md](INSIGHTS.md)) has a **Bots**
tab that edits the bot list itself. Brandon, 2026-10-21: "i want an easy way
to enable / disable / edit bots on the admin homepage thing." Before this,
that meant hand-editing `config/bots.json` and restarting the container.

Everything the tab does is a write to `config/bots.json` (the file
`stack.mjs` already derives the stack from) followed by the same derivation
the container runs at boot, so a change is live now **and** identical after a
container restart. Nothing else is a second copy of the truth.

## What the tab shows

One row per bot in `bots.json`:

| column | from |
|---|---|
| On | `enabled` (absent = on). A disabled bot stays in the list, greyed out. |
| Bot | nick (from the file, else the pack's `voice.json`, else the id) and the id; a warning if its persona pack is gone from disk |
| Channel, Port, Identity | the file (`channel`, `port`, `identity`; empty identity = its own) |
| State | `supervisorctl status` for `core-<id>` (and `menace-<id>` when `menace` is on) plus the summoner's "in the room" |
| Voice | the gateway account's `voice.mode`: `off` = text-only for that one bot |

Above the table: the stack-wide voice switch (#4372's `POST /voice/on|off`
on the summoner, same as the `set_voice_mode` tool). Off stops whisper and
every bot goes text-only within seconds; on reloads whisper in about 20 s.

## What each action does

| action | bots.json | then |
|---|---|---|
| Disable | `enabled: false` | `supervisorctl stop core-<id>` (+ `menace-<id>`), rewire, summoner restart |
| Enable | drops `enabled` | rewire (the program comes back), `supervisorctl start core-<id>` unless `autostart` is off (guests: Summon or the shift brings them in), summoner restart |
| Edit | nick, channel, identity, port, autostart, noCatchup, noWelcome, menace, env | rewire; `supervisorctl update` restarts **only** the core whose program changed. A nick change is also written to `config/summoner/config.json` (the summoner finds a bot in the room by nick) and restarts the summoner |
| Add | a new entry for a persona pack that is on disk but not in the list; port = the next free one unless given | rewire seeds the home, workspace, agent, account and binding exactly as a boot would; summoner restart |
| Remove | the entry is dropped and the id goes on `removed` | cores stopped, rewire switches the gateway account off (`enabled: false`, tuning kept), summoner restart. **Nothing on disk is deleted**: `config/bots/<id>/` (identity included) and the workspace stay, and Add brings it back with everything intact |
| Summon / Dismiss | nothing | the summoner's `POST /summon|dismiss/<id>`, so shifts and overrides stay consistent |
| Voice (per bot) | nothing; `openclaw.json` `channels.teamspeak.accounts.<id>.voice.mode` = `off`, or back to the seed's lane (`stt-tts`) | the gateway applies it when it reloads its config |

"Rewire" is `node /opt/universal/stack.mjs rewire` (= the boot's
`supervisor` + `gateway` passes, in one process) followed by
`supervisorctl reread && supervisorctl update`. supervisord only touches
programs whose config changed: an edit to Trixie restarts `core-trixie` and
nobody else. Ports never move (`stack.mjs` writes them back once).

The summoner is restarted whenever its bot list or a nick changed, because it
reads `/run/universal/summoner.json` once at start. It reconciles from its
state file, so a restart mid-shift is a few seconds of nobody watching the
room, not a lost shift. The dashboard itself re-reads the merged config per
request, so a bot added here shows up on the Tools, Personas and Schedule
tabs without a restart.

## Rules the tab enforces

- Two **enabled** bots cannot share an `identity` (the guests: Johnny and
  Trixie both use `guest`). Enabling the second one is refused with the name
  of the first; disable that one first. The row of a disabled bot whose
  identity is taken says so and its switch is greyed.
- A port must be 1024-65535 and not another bot's.
- `identity` is a short lowercase name (the folder under `config/bots/`), and
  cannot be another bot's own id.
- `env` names are `UPPER_CASE`; at most 32, values up to 512 characters.
- Every write needs `X-Requested-With` (the page sends it) on top of the
  basic-auth login, like the other control routes, and is logged by the
  insights program (`docker logs teamspeak-universal-bot | grep "control: bots"`).
- Each write keeps the previous file as `bots.json.ctl-bak`
  (and `openclaw.json.ctl-bak` for the per-bot voice switch).

## bots.json additions

```json
{
  "bots": { "lexton": { "port": 9103, "menace": true, "enabled": false } },
  "removed": ["bexton"]
}
```

- `enabled: false`: listed but not run (no supervisor program, no gateway
  binding, account switched off). `stack.mjs` honoured this before; the tab
  is just a switch for it. `autostart: false` is different: the program
  exists but only the summoner starts it (the guests).
- `removed`: packs the tab removed. Without it, `stack.mjs` would add every
  pack it finds on disk straight back at the next boot. Add takes the id off
  the list again.

## API

All under `/api/control/`, JSON, basic auth; writes need `X-Requested-With`.

| route | |
|---|---|
| `GET bots` | `{ bots: [row…], available: [packs not in the list], removed, nextPort, summoner, voice, seedVoiceMode }` |
| `PUT bots/<id>/enabled` `{on}` | enable / disable |
| `PUT bots/<id>` `{nick?, channel?, identity?, port?, autostart?, noCatchup?, noWelcome?, menace?, env?}` | edit; only the keys sent change |
| `POST bots/<id>` (same body) | add `<id>` from its persona pack |
| `DELETE bots/<id>` | remove |
| `PUT bots/<id>/voice` `{mode: "on"\|"off"}` | per-bot voice.mode |
| `POST bots/<id>/summon` / `dismiss` | via the summoner |
| `POST voice/on` / `voice/off` | the stack-wide switch |

Every write returns `steps`: the output of each command it ran (rewire,
reread, update, stop/start, summoner restart), which the page shows in one
line so a failed `supervisorctl` is visible rather than silent.

## Testing it

- `node --test ts-summoner/test/control.test.mjs`: validation, the identity
  rule, add/remove bookkeeping, the row builder.
- `node --test image/universal/stack.test.mjs`: `rewire` against the repo's
  packs: a removed bot stays removed, add brings it back on its old port,
  the account comes back on.
- Dry run without a container: start `insights-web.mjs` with
  `UNIVERSAL_CONFIG_DIR`, `SUMMONER_CONFIG`, `UNIVERSAL_STACK` pointing at a
  scratch tree and `SUPERVISORCTL` at a stub script; every route then runs
  for real against that tree (done for #4374 before the PR).
