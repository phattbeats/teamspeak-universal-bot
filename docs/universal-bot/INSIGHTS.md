# Insights dashboard (PHA-3963)

A web dashboard for the TeamSpeak server, built into the one container. It shows
when the server is busy, who posts and talks the most, who spends the most time
in voice, and what gets people talking to the bots. It also keeps a searchable
log of chat, speech, bot turns, voice sessions and connects.

`http://<PHATT-RAID>:8097`. Log in with `user:password` from
`/mnt/user/appdata/teamspeak-universal-bot/config/insights/auth.txt`. The file
is generated on first start; edit it to change the login, and it applies on the
next request.

## Where the data comes from

| What | Recorded by | How |
|---|---|---|
| Chat (channel + server) | summoner | the ServerQuery `notifytextmessage` it already listens to |
| Voice presence, talk time, away time | summoner | its 10 s `clientlist -uid -away -voice` poll, kept as sessions per person per channel |
| Connects / disconnects | summoner | `notifycliententerview` / `notifyclientleftview` |
| Speech, as words | summoner | the STT transcripts the bots already forward to `POST /heard` |
| Bot events (entrances, scenes, banter, summons, takeovers...) | summoner | at the point it triggers them |
| Bot turns (who asked, which lane, which tools, answered or not, model cost) | insights-web | reads each bot's `openclaw-agent.sqlite` transcripts every 60 s, read-only |
| Chat from before this shipped | insights-web | one-time import of the cores' room logs (`logs/<bot>/<channel>/*.md`) |

Everything goes into one SQLite file, `config/insights/insights.db` (`node:sqlite`,
WAL mode, no npm deps). Rows older than `insights.retentionDays` (default 365)
in `config/summoner/config.json` are pruned.

## Limits

- **Talk time is an estimate.** It comes from the talking light, sampled once
  per poll (10 s). Use it to compare people, not as a stopwatch.
- **Speech only has words while a bot is in the channel.** The query login gets
  no audio, so the words come from a bot's STT.
- **Chat is only seen in the summoner's channel** (General Shit) and in server
  chat. ServerQuery doesn't get other channels' chat or private messages.
- **Voice history starts at deploy.** Nothing recorded presence before this. Chat
  and bot turns go back further, through the room logs and transcripts.

## Moving parts

- `ts-summoner/insights.mjs`: schema, the `Recorder` the summoner calls, and
  the transcript parser.
- `ts-summoner/insights-stats.mjs`: the dashboard's numbers, as pure functions.
- `ts-summoner/insights-web.mjs`: supervisor program `insights` on :8097. It
  serves the page and API, ingests transcripts, backfills, and prunes.
- `ts-summoner/insights/index.html`: the page itself. It has no build step and
  loads nothing from a CDN.

The recorder runs inside the summoner, but every write is wrapped. If the db
breaks, it logs `insights: ...` and the shifts keep running. The dashboard is a
separate program, so a slow page can't hold up the summoner.

Switches:
- `INSIGHTS_ENABLED=0` idles the dashboard.
- `"insights": {"enabled": false}` in the summoner config stops the recording.
- `INSIGHTS_PUBLISH=` (empty) on `image/deploy.sh` keeps the port unpublished.
