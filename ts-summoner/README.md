# ts-summoner (PHA-3821)

Shift schedule and chat summoning for the TeamSpeak bots, so none of them has to live in the server 24/7.

- An invisible **SSH ServerQuery** login (`serveradmin`, port 10022 on the `phattvip` network only) reads channel and server chat and polls `clientlist -voice`.
- Each bot's TeamSpeak core (`[program:sexton]` in its container) is **stopped** when the bot is off duty. That's a real disconnect. The gateway stays up. Off duty leaves `/config/.off-duty`, which `image/healthcheck.sh` reports as healthy.
- The schedule is in `config.json` (America/New_York). A shift's `days` are the days it *starts* on, and `start > end` crosses midnight.

Chat rules (the typist must not be a bot):
- A bot's name at the start of a message, or with a summon word ("hey", "summon", "get in here", ...), brings in an off-duty bot for `summonStayMin`. Later mentions extend the stay.
- A name plus a dismiss word ("go home", "bye", ...) and no negation ("don't leave") sends the bot off. On shift, he's gone for the rest of that shift. Summoned off shift, he just drops back to the schedule.
- `trashTalk` bots (Lexton): a name plus an insult word, while off duty, makes him crash in for `stayMin`, then a `cooldownMin` cooldown.
- A bot whose shift ends while a human is talking (`client_flag_talking`) stays until the room has been quiet for `idleGraceMin`.
- Summoned bots leave once there have been no humans on the server for `idleGraceMin`.

Entrance and exit lines (PHA-3824): on every start or stop, the summoner writes `{reason, at}` to `/config/.announce` in the bot's container. The reason is `shift_start`, `summon`, `shift_end` or `dismiss`. The bot's gateway says a random line from that slot in its workspace `lines.json`, which defaults to `personas/<bot>/lines.json`, and then deletes the file. Lines can be edited live without a rebuild. On exits the core is stopped only after the file is gone, or after `announce.exitWaitSec`. No line is requested when the server has no humans, or for a core that came back by itself while off shift.

HTTP (not published to the host): `GET /status`, `POST /summon/<bot>?by=<who>`, `POST /dismiss/<bot>?by=<who>` on `ts-summoner:8099`. This is for the bots' own voice tools, because ServerQuery gets no audio.

Server side: `/mnt/user/appdata/teamspeak6-server/tsserver.yaml` sets `server.query.ssh.enable: 1` and the admin password. The password also lives in `query-pass.txt` next to `deploy.sh` (not in git). `query_ip_allowlist.txt` has `172.19.0.0/16` added, which exempts the network from query flood protection.

Deploy: copy this dir to `/mnt/user/appdata/ts-summoner/` on PHATT-RAID and run `./deploy.sh`.

Scenes, special nights and rare events (PHA-3841): a scheduled shift change with another bot in the room plays a short two-bot scene (`live/scenes.json`) instead of solo lines. A live-editable calendar (`live/calendar.json`) bends shifts and picks themed pools: Friday lounge, Halloween, Thanksgiving, Christmas, NYE, birthdays. Two rare events persist in `state/`: Lexton's hostile takeover, which sends the Sexton to Bot Jail for an hour, and Bexton's two-day bender. `POST /event/<takeover|bender>` and `POST /event/end?kind=` fire and end them by hand. **Full reference: [docs/universal-bot/SCHEDULE-AND-EVENTS.md](../docs/universal-bot/SCHEDULE-AND-EVENTS.md).** Tests: `node --test ts-summoner/test/*.test.mjs`.
