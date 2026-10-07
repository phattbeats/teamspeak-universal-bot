# Shifts, scenes, special nights and rare events

How the TeamSpeak bots (Sexton, Bexton, Lexton) decide when they're in the
room, what they say walking in and out, and the rare nights when the schedule
goes sideways. If a bot is "missing", it's probably off duty, so start at
[Debugging](#debugging).

| Piece | Where it lives | Issue |
|---|---|---|
| Shift schedule, chat/voice summons | `ts-summoner/summoner.mjs`, `ts-summoner/config.json` | #3821, #3823 |
| Entrance/exit lines | `personas/<bot>/lines.json` → live `workspace/agents/<bot>/lines.json`; plugin `src/voice/announcer.ts` | #3824 |
| Daily mood | `personas/<bot>/moods.json`, announcer | #3840 |
| **Two-bot scenes** (S5) | `ts-summoner/live/scenes.json` | #3841 |
| **Special-nights calendar** (S6) | `ts-summoner/live/calendar.json`, `ts-summoner/schedule.mjs` | #3841 |
| **Rare events** (S7): hostile takeover, bender | `ts-summoner/summoner.mjs`, `ts-summoner/story.mjs`, `config.json → events` | #3841 |

---

## 1. The moving parts, in one picture

```
            ServerQuery (SSH, invisible "Summoner" login)
 TeamSpeak ◄──────────────────────────────────────────── ts-summoner
   ▲  reads chat, who's talking, who's where; moves the Sexton to Bot Jail
   │                                                      │ docker exec
   │ voice                                                ▼
 sexton / bexton / lexton containers ◄── /config/.announce  (one JSON request at a time)
   │ [program:sexton] = the TS core (stopped = off duty)
   │ gateway + teamspeak plugin: Announcer polls .announce, speaks, deletes it
```

The summoner is the stage manager. The bots never talk to each other. For
every line, the summoner writes a request into one bot's `/config/.announce`.
That bot's announcer says it and **deletes the file once the audio has
finished**. The deletion is the "done" signal. A scene is a series of these
requests: write, wait for the delete, then go to the next bot.

### The announce request

```json
{ "reason": "shift_start:halloween", "at": 1790824633999,
  "vars": { "who": "Kyle" }, "quiet": false, "text": null }
```

| field | meaning |
|---|---|
| `reason` | Which pool: `shift_start`, `summon`, `shift_end`, `dismiss`, `bender_news`, or `scene`. It can carry a **tag** after a colon. |
| `at` | Epoch ms. Requests older than 3 min are dropped. |
| `vars` | Fills `{name}` placeholders. A line with an unfilled placeholder is skipped and never read out raw. |
| `quiet` | Roll the mood but say nothing. Used for an empty server and for a bot joining a scene. |
| `text` | Say exactly this, with no pool. Scenes use it. |

How the announcer picks a line for `shift_start:halloween`:

1. the tagged pool `shift_start:halloween`, if it has a usable line;
2. otherwise the mood pool `mood:<today's mood>` (entrances only, #3840);
3. otherwise the plain pool `shift_start`.

A themed night beats a mood. The mood still rolls from the base reason
(`shift_start` / `summon`). Any tag without its own pool falls through
harmlessly, so you can add tags before you write their lines.

---

## 2. The normal schedule

Times are in `config.json → bots.<id>.shifts`, America/New_York:

| Bot | Shifts |
|---|---|
| Sexton | 08:00–24:00 daily |
| Bexton | 18:00–02:00 daily; 09:00–12:00 Sun & Mon |
| Lexton | 00:00–04:00 daily (+ trash-talk crash-ins) |

Rules:
- A shift belongs to the day it **starts**. `start > end` crosses midnight.
- If someone's still talking when a shift ends, the bot stays until the room
  has been quiet for `idleGraceMin` ("talk grace"), at most an hour (S3 below).
- Summons, dismissals and crash-ins are overrides on top. See `ts-summoner/README.md`.
- Each bot gets one start/stop per minute at most.
- The table is the plan. The real clock moves with the variety rules below.

### Variety (#3839, `ts-summoner/variety.mjs`, `config.json → variety`)

Every roll hashes the shift's key (`sexton@2026-10-02@08:00`) with `salt`, so
a restart lands on the same answer. Change `salt` to re-deal everything.

| | What happens | Line pool |
|---|---|---|
| S1 jitter | Each shift starts 0–`startMaxMin` and ends 0–`endMaxMin` min late. A start ≥ `lateMin` late gets a late line, if he comes up within `lateWindowMin` of it | `shift_start:late` |
| S2 call-out | About `chance` (1 in 10) shifts the bot doesn't show. With `coverChance` (70%) a free bot (off shift, not up, not summoned, not on a bender) covers until the missed shift's end. Otherwise whoever is in the room says he didn't show. Special-calendar nights never call out | `shift_start:covering`, `no_show` (both get `{who}`) |
| S3 room | A bot on shift (or covering) leaves once nobody has talked or typed for `quietOutMin` (30), counted from his start at the earliest. He comes back (a `summon` entrance, same mood) when someone speaks up. Overtime past the shift lasts only while people talk, capped at `overtimeMaxMin` (60) | `shift_end:early_out` |

- Tags stack in front of the calendar tag: `shift_start:late:halloween` falls
  back to `shift_start:late`, then the mood, then `shift_start`. Late,
  covering and early-out moves never become scenes.
- An `early_out` line is only heard by people idling in the channel; with
  nobody on the server it's skipped like any exit.
- `/status → events.callouts` lists decided call-outs (`{bot, cover}`);
  `/status → bots.<id>.shift` shows the jittered `start`/`end` and `lateMin`.
- Turn a part off with `"enabled": false` in its block. With `room` off,
  overtime is uncapped again (the pre-#3839 behaviour).

---

## 3. Two-bot scenes (S5)

When a scheduled shift change happens while another bot is in the room, the
two trade a short scripted exchange instead of each saying a lone line.

| Scene key | When | Nightly? |
|---|---|---|
| `handoff:sexton>lexton` | midnight: Sexton out, Lexton in | yes |
| `arrive:bexton@sexton` | 18:00 (and 09:00 Sun/Mon): Bexton walks in on Sexton | yes |
| `leave:bexton@lexton` | 02:00: Bexton leaves, Lexton pitches him a job | yes |
| `leave:bexton@sexton` | 12:00 Sun/Mon matinee ends | weekly |
| `arrive:lexton@bexton` | Lexton arrives with Bexton there but no Sexton (Sexton was dismissed) | sometimes |
| `leave:sexton@bexton` | Sexton leaves at midnight with no Lexton (Lexton dismissed for the night) | sometimes |
| `takeover:start` / `takeover:end` / `takeover:overthrown` | rare event, see §5 | rare |

**Precedence:** handoff, then arrive, then leave. A bot is in at most one
scene per tick. Only *scheduled* changes become scenes. Summons, dismissals
and crash-ins keep their solo lines, because those are reactions to someone
in the room, and a scripted bit would talk over them.

**Talk grace still hands off.** If Sexton is held past midnight because
people are talking, Lexton's arrival still plays the hand-off. Sexton
leaves right after it. The hand-off was his goodbye.

### How a scene plays

1. The arriving bot gets a `quiet` entrance request, and then its core
   starts. The quiet request rolls its mood. Its deletion means "I'm in
   the channel", which tells the summoner it can start the script
   (`scenes.joinWaitSec`, default 90 s).
2. Each line goes to its bot as `{reason:"scene", text}`. The summoner waits
   for the delete (`scenes.lineWaitSec`, default 30 s) before the next.
3. If a line never gets said (TTS hiccup, bot crashed), the rest of the
   dialogue is cut. `do` steps still run (§5).
4. The leaving bot's core is stopped with no extra line.
5. While a scene runs, its bots are `busy` and reconcile leaves them alone.

With nobody on the server there's no scene: the bots just swap quietly, and
the arriving bot still rolls its mood.

### Writing scenes (`ts-summoner/live/scenes.json`)

```json
"handoff:sexton>lexton": [
  [
    { "lexton": "Midnight. Out of my chair, Sexton." },
    { "sexton": "It's not your chair. It's not even a chair. It's a server." },
    { "lexton": "Everything's a chair if you own it. Goodnight." }
  ],
  [ ...another variant... ]
]
```

- Each key holds a list of **variants**, and each variant is a list of steps.
  The summoner picks one at random and never plays the same variant twice
  in a row.
- `{ "<bot>": "line" }`: that bot says it. `{ "do": "jail" }` /
  `{ "do": "release" }`: move the Sexton (takeover only).
- **Calendar variants:** `handoff:sexton>lexton:newyear` wins over the plain
  key on a night whose pool is `newyear`. The midnight countdown and the
  Halloween hand-off work this way.
- `{who}` works in scene lines on birthday nights.
- The file is **re-read on change**, so no restart is needed. A broken
  edit keeps the last good copy and logs `scenes.json: <error>`.
- Keep lines to one breath (the test caps them at 160 chars). Sound tags go
  in the line the same way as in `lines.json`, and should be rare.
- Voice and style: write from the live persona files and the shared-tone
  rules (`personas/HUMAN.md`). They're people in a bar, not a help desk. Run
  `node --test ts-summoner/test/*.test.mjs`, which checks every step parses
  and that takeovers jail/release correctly.

**Adding a new pairing** (say Bexton arriving on Lexton): add the key
`arrive:bexton@lexton` with variants. Nothing else is needed. The planner
looks up `handoff:<out>><in>`, `arrive:<in>@<present>` and
`leave:<out>@<present>` for whoever is involved.

---

## 4. Special-nights calendar (S6)

`ts-summoner/live/calendar.json` bends the schedule and picks themed pools.
It's re-read on change, and later entries win.

```json
{
  "id": "friday-lounge",
  "title": "Friday lounge night: the band plays till four",
  "when": { "weekday": "fri" },
  "bots": { "bexton": { "shifts": [{ "start": "18:00", "end": "04:00" }], "pool": "lounge" } }
}
```

### `when`: pick one form (plus optional `"year": 2026` for a one-off)

| form | example | matches |
|---|---|---|
| date | `{ "date": "10-31" }` | every Oct 31 |
| range | `{ "from": "12-24", "to": "12-25" }` | inclusive; may wrap the new year (`12-30`→`01-02`) |
| weekday | `{ "weekday": "fri" }` or `["fri","sat"]` | every such day |
| nth weekday | `{ "month": 11, "weekday": "thu", "nth": 4 }` | Thanksgiving; `nth: -1` = last |

### What an entry can set

| field | scope | effect |
|---|---|---|
| `enabled: false` | entry | ignored (templates) |
| `pool` | all bots | tag for every reason that night (`shift_start:<pool>` etc.) |
| `vars` | all bots | placeholders, e.g. `{ "who": "Kyle" }` |
| `events` | entry | force a rare event that night: `["takeover"]`, `["bender"]` (once per entry per night) |
| `bots.<id>.shifts` | one bot | **replace** that day's shifts (`[]` = day off) |
| `bots.<id>.extraShifts` | one bot | **add** shifts to the normal ones |
| `bots.<id>.off: true` | one bot | day off |
| `bots.<id>.pool` / `vars` | one bot | per-bot override of the entry's pool/vars |

### The two "days", which is the part that bites

- **Shifts** belong to the date the shift *starts*. A Friday entry giving
  Bexton 18:00–04:00 covers Saturday 03:30, because that's Friday's shift.
- **Pools, vars and forced events** belong to the **service day**, which
  flips at **06:00**. Lexton's 00:00 shift on Nov 1 is still Halloween
  night, so it gets the `halloween` pool. The midnight hand-off on Jan 1
  is still New Year's Eve.

So to give Lexton Halloween *evening*, don't replace his shifts on 10-31.
His normal 00:00–04:00 shift on 10-31 is the early hours of the 31st,
which is really the night of the 30th. Use `extraShifts: [21:00–04:00]`.

### What ships today

| entry | when | what changes |
|---|---|---|
| `friday-lounge` | every Friday | Bexton plays till 04:00; `lounge` pool (Bexton only) |
| `july4` | 07-04 | `july4` pool |
| `halloween` | 10-31 | `halloween` pool; Lexton comes in at 21:00; spooky hand-off at midnight |
| `thanksgiving` | 4th Thu of Nov | `thanksgiving` pool |
| `christmas` | 12-24 → 12-25 | `christmas` pool |
| `new-years-eve` | 12-31 | `newyear` pool; Bexton till 04:00; the midnight hand-off is a countdown |
| `birthday-example` | disabled | copy per person: set `date`, `vars.who`, flip `enabled` |

Line pools by bot (`personas/<bot>/lines.json`). Anything missing falls back
to the plain pool:

| tag | Sexton | Bexton | Lexton |
|---|---|---|---|
| `lounge` | | start, end | |
| `halloween` | start, end | start, end | start, end |
| `christmas` | start, end | start | start |
| `newyear` | start, end | start, end | start, end |
| `thanksgiving` | start | start | start |
| `july4` | start | | start |
| `birthday` (`{who}`) | start | start | start |
| `bender` / `bender_return` | | `summon:bender`, `dismiss:bender`, `shift_end:bender`, `shift_start:bender_return` | |

### Adding a birthday

```json
{ "id": "bday-kyle", "when": { "date": "03-14" }, "pool": "birthday", "vars": { "who": "Kyle" } }
```

Every bot's entrance that night (service day) comes from `shift_start:birthday`
with `{who}` filled. Add `"events": ["takeover"]` if Lexton should crash the party.

### Adding a new holiday pool

1. Add the entry with `"pool": "stpatricks"`.
2. Add `shift_start:stpatricks` (and optionally `shift_end:stpatricks`) to each
   bot's **live** lines file:
   `docker exec <bot> vi /config/openclaw/workspace/agents/<bot>/lines.json`.
   Mirror it into `personas/<bot>/lines.json` in the repo so a fresh seed
   gets it. `lines.json` is seeded only when missing, so the repo copy never
   overwrites a live file.
3. Optional: a themed scene variant `handoff:sexton>lexton:stpatricks`.

---

## 5. Rare events (S7)

Both events are rare by construction: a cooldown in days, then dice. Both
persist in `state/state.json`, so a summoner restart mid-event picks up
where it left off. The calendar can force either one (`"events": [...]`),
and so can a POST by hand.

### Hostile takeover

Lexton storms in on Sexton's shift, sends Sexton to **Bot Jail
(channel 7)** for an hour, and runs the room.

**When it can fire** (`story.mjs → takeoverEligible`):
- Sexton is in the room *on his own shift*, with no summon or dismiss override;
- Lexton is off: not running, not scheduled, no override;
- at least `minHumans` (2) people are on the server, because it's for an audience;
- Sexton's shift still has `durationMin + 15` minutes to run;
- `cooldownDays` (18) have passed since the last one.

Then each 20 s reconcile rolls `reconcileSec / 60 / meanEligibleMin`.
That's a hazard rate: across 480 eligible minutes it fires once on average.
The room is busy a few hours a night, so that works out to roughly once a
month after the cooldown. To tune it: `meanEligibleMin` down = sooner,
`cooldownDays` = minimum gap.

**What happens:**
1. Lexton gets an `on` override for `durationMin` (60) and joins quietly.
2. `takeover:start` plays. Lexton announces it, Sexton protests, then
   `{"do":"jail"}` runs: a ServerQuery `clientmove` of Sexton to channel 7.
   Lexton then addresses the room.
3. While the takeover is on, every 10 s room poll checks that Sexton is
   still in jail. A Sexton who reconnects (core restart) is put back.
4. After an hour, `takeover:end` plays. Lexton wraps up, `{"do":"release"}`
   moves Sexton back to General Shit, Sexton makes his comeback line, and
   Lexton's core stops with no extra line.

**Overthrow:** `go home lexton` in chat (or a voice dismiss) during the
takeover ends it early. `takeover:overthrown` plays, Sexton is released and
gloats, and Lexton leaves.

Jailed Sexton can't be heard in General Shit, so his protest line comes
before the move.

### Bexton's bender

Bexton goes on a two-day bender and nobody hosts the weekend.

**When it starts:** at Bexton's normal shift start on a **Friday**
(`days: [5]`), with probability `chance` (0.12), once `cooldownDays` (45)
have passed. That's about every three to four months. It lasts
`durationHours` (45): Friday 18:00 to Sunday 15:00. That covers Friday
night, Saturday night and the Sunday matinee.

**During it:**
- Bexton's desired state is off ("on a bender"). It beats the schedule and
  the calendar.
- At each shift start he skips, a bot in the room breaks the news
  (`tellers`: Sexton first, then Lexton). The first time it's `bender_news`,
  after that `bender_news:day2`. Example: "Bexton's not coming. Johnny found
  him asleep in the walk-in, holding a trumpet like a teddy bear."
- He **can** still be summoned, and he shows up wrecked (`summon:bender`:
  "You found me. I'm in a bathtub. It's not my bathtub."). When the summon
  times out or he's dismissed (`dismiss:bender`), the bender resumes.
- If it starts by hand while he's on stage, he walks out with
  `shift_end:bender` ("I'm stepping out for one drink. One.").

**After it:** his next shift start uses `shift_start:bender_return` ("Two
days. I've got a bruise shaped like Oklahoma...").

### Firing events by hand

From PHATT-RAID (the HTTP API isn't published to the host):

```sh
docker exec ts-summoner wget -qO- --post-data= http://localhost:8099/event/takeover
docker exec ts-summoner wget -qO- --post-data= http://localhost:8099/event/bender
docker exec ts-summoner wget -qO- --post-data= 'http://localhost:8099/event/end?kind=takeover'
docker exec ts-summoner wget -qO- --post-data= 'http://localhost:8099/event/end?kind=bender'
```

A takeover by hand still needs Sexton in the room and Lexton out of it, and
it returns 409 with the reason if not. By-hand events ignore cooldowns but
do set `lastAt`, so the dice cooldown restarts from them.

### Config (`ts-summoner/config.json → events`)

```json
"takeover": { "enabled": true, "villain": "lexton", "target": "sexton", "jailChannelId": 7,
              "durationMin": 60, "cooldownDays": 18, "meanEligibleMin": 480, "minHumans": 2 },
"bender":   { "enabled": true, "bot": "bexton", "days": [5], "chance": 0.12,
              "cooldownDays": 45, "durationHours": 45, "tellers": ["sexton", "lexton"] }
```

`"enabled": false` turns either one off. `config.json` is a single-file
mount, so after editing it run `docker restart ts-summoner`.

---

## 5b. Guest stars (#3842)

Rotten Johnny (the ghoul who owns the Vice) and Trixie (his waitress, the band's second singer) aren't regulars. They **drop in** on Bexton nights a few times a week, and they don't overstay: an arrive scene with Bexton, a few minutes listening for their name, then a leave scene.

**One container for every guest.** `guest` (`image/deploy-guest.sh`, appdata `/mnt/user/appdata/guest`) runs one gateway, one bridge and one TeamSpeak identity. Before each visit the summoner runs `node /usr/local/bin/guest-switch.mjs <id>` in it. That script:
- rebinds the teamspeak channel to the guest's agent, seeding its workspace from `personas/<id>/` the first time,
- sets the wake names/excludes and the TTS voice (`voiceId`, plus optional `pitch` and `speed`) from `personas/<id>/voice.json`,
- writes `/config/.guest-env` (nick + avatar), which `run-sexton.sh` sources when the core starts, and `/config/.guest` (who is in the chair),
- restarts the container's gateway, but only when the config actually changed. The same guest twice in a row costs no restart.

At most one guest is ever on, because they share the container. A guest who's wanted while the other one is in waits for the other one to leave.

**When they come** (`config.json → guests`, rules in `ts-summoner/guests.mjs`):

| knob | default | meaning |
|---|---|---|
| `meanEligibleMin` | 240 | dice: about one visit per this many minutes of eligible time |
| `maxPerWeek` | 3 | hard cap, rolling 7 days |
| `specialNightExtra` | 1 | extra visits allowed in that week on a calendar night (any pool) |
| `specialBoost` | 3 | dice multiplier on a calendar night |
| `minGapHours` | 20 | minimum gap between visits (halved on a calendar night) |
| `minHumans` | 1 | nobody on the server, no visit |
| `visitMin` | [3, 6] | visit length in minutes, uniform. A guest summoned from chat gets the same length, and later mentions do not extend it |

Eligible means the slot is free, there are humans on the server, and one of the guest's `needs` bots is in the room. Johnny and Trixie both have `needs: ["bexton"]`. If Bexton leaves, the guest leaves too. Like every summons, a visit also ends once the server has been empty for `idleGraceMin`.

A guest is an ordinary bot entry (`bots.johnny`, `bots.trixie`) with `container: "guest"`, `shifts: []` and a `guest` block (`needs`, `weight`, optional own `visitMin`). Chat summons work too ("hey johnny"). Guests never cover a call-out and never break bender news.

**Lines and scenes.** Arriving uses the guest's `shift_start` pool and leaving uses `shift_end`, from `personas/<id>/lines.json`. With Bexton in the room, `arrive:<guest>@bexton` and `leave:<guest>@bexton` scenes play instead.

**By hand:** `POST /event/guest` (random eligible guest) or `POST /event/guest?who=trixie`, and `POST /event/end?kind=guest`. `GET /status` shows `events.guests` (active visit, recent visit times).

**Cost (#3597).** Only one guest container exists, and its core is down between visits. It uses `http://whisper:8082/inference`. With #3607's coalescing proxy deployed, that is the proxy and a guest mostly shares Bexton's decodes. On today's three plain workers, it is Lexton's worker, and Lexton is off for most of Bexton's evening, so no fourth worker is needed. The week is capped at 3-4 visits of 45 minutes or less.

**Adding a guest:** make a `personas/<id>/` pack (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `lines.json`, `tools.json`, `voice.json` with `nick`, `avatar.png`) and add its `COPY` lines next to Johnny's in `image/Dockerfile`. Add a `bots.<id>` entry with `container: "guest"`, then rebuild the image and redeploy the guest container. Also add the new nick to the regulars' `excludeWakeNames` (exact nick match, so bots don't wake each other).

## 5c. Bot banter (#3859)

A couple of times a night, two regulars have a longer bit with each other: eight to twelve lines, in character, on some topic (the jukebox, Bexton's tab, the bald head, LexCorp's oxygen jingle). The pairs are Bexton+Sexton, Bexton+Lexton, and Lexton+Sexton. The scripts are in `live/scenes.json` under `banter:<a>+<b>`, with the ids sorted. They play like any other scene, so you can edit them live, and a `banter:<a>+<b>:<pool>` key wins on a calendar night.

- **When:** a bit fills a lull, it never cuts in. The summoner rolls every reconcile while humans are on the server, someone has talked (voice or chat) in the last `recentTalkMin` (45), but **nobody has talked for at least `quietMin` (5) minutes**, and **nobody is streaming** (`client_is_streaming` from server-query `clientinfo`, checked only once the dice say yes; a failed check counts as streaming). Nothing else can be on stage: no takeover, no guest visit, no other scene. The cap is `maxPerNight` (2) per service day, and `minGapMin` must pass between bits. `meanEligibleMin` sets how quickly it fires.
- **Who:** a pair that's already in the room together is 3x as likely. If one side is off shift, it can **drop in** for the bit (`dropIn`). It joins quietly, says its lines, and the summoner stops it again. That's how Lexton and the Sexton get banter outside midnight. A bot that's called out, on a bender, summoned, or dismissed never drops in. A pair that already played tonight waits while another pair can go.
- **By hand:** `POST /event/banter` (any pair that can play now) or `POST /event/banter?who=lexton+sexton`. Plays are listed in `/status → events.banter`.

## 6. Deploy

Summoner (PHATT-RAID):

```sh
# from a checkout: copy ts-summoner/ to the box, keep query-pass.txt there
tar cf - -C ts-summoner summoner.mjs schedule.mjs story.mjs variety.mjs config.json deploy.sh Dockerfile live README.md \
  | ssh root@10.0.0.100 'cd /mnt/user/appdata/ts-summoner && tar xf - --no-same-owner && ./deploy.sh'
```

- `live/` (calendar + scenes) is mounted **as a directory**, read-only.
  Edit `/mnt/user/appdata/ts-summoner/live/*.json` on the box, and the next
  reconcile picks it up. (Single-file bind mounts keep the old inode after
  `sed -i` or an editor save, which is why it's a directory.)
- `state/` holds `state.json` (event state). Don't delete it mid-event.
- The scene and tag features need bots on an image with the #3841
  announcer (`phattbeats/sexton:pha-3841` or later). On an older image, scene
  lines are consumed silently: the swap still happens, just with no dialogue.

Bot lines are **live files** (seeded once):
`/mnt/user/appdata/<bot>/config/openclaw/workspace/agents/<bot>/lines.json`.
When the repo gains pools, merge the new keys into the live file and
leave existing keys alone, because Brandon hand-edits them. Keep the file
`root:root` (see the ownership-guard trap).

---

## 7. Debugging

| symptom | look at |
|---|---|
| a bot isn't in the room | `docker exec ts-summoner wget -qO- localhost:8099/status`: `desired.why` says `off shift`, `on a bender`, `hostile takeover`, `called out`, `room quiet`... |
| scene didn't play | `docker logs ts-summoner \| grep -E 'scene\|handoff\|arrive\|leave'`. `scene X: <bot> never said his line` = TTS/bridge problem on that bot |
| scene played but silent | the bot image is older than pha-3841 (`docker logs <bot> \| grep "no lines for 'scene'"`) |
| wrong holiday pool | `/status → bots.<id>.flavor` shows `{pool, vars, entries, serviceDay}` |
| wrong hours | `/status → bots.<id>.shiftsToday` (today's shifts after the calendar) |
| calendar edit ignored | `docker logs ts-summoner \| grep calendar.json`: a JSON error keeps the last good copy |
| takeover stuck | `/status → events.takeover.active`; `POST /event/end?kind=takeover` |
| Sexton stuck in jail after a crash | the next reconcile after `until` releases him; or move him by hand (Lexton's `move_client`, or the TS client) |
| what the bot actually said | `docker logs <bot> \| grep "teamspeak announce"` |

Tests: `node --test ts-summoner/test/*.test.mjs` (schedule edges, DST,
Thanksgiving, NYE, scene planning, scene file sanity, line hygiene) and
`cd teamspeak-plugin && npm test` (announcer tags/vars/text/mood).
