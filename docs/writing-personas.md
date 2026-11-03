# Writing a persona

A bot is a **persona pack**: a directory named by the bot's id
(lowercase letters, digits, `-`, `_`). Put it in `personas/<id>/` to bake it
into the image, or in `config/personas/<id>/` on a running box to add or
override it without a rebuild. The stack discovers a pack by its
`voice.json`.

## Files

| file | required | purpose |
| --- | --- | --- |
| `voice.json` | yes | TTS `voiceId`, `wakeNames`, `wakeAliases` (how STT mishears the name), `excludeWakeNames` (names that belong to other bots), `followUpSilenceMs` |
| `tools.json` | no | which tools this bot gets: `music`, `moderation` (with `allowGroups`), `band`, `agent.alsoAllow`, and so on. See the [tool catalog](tool-catalog.md) |
| `AGENTS.md` | no | operating instructions: who the bot is, what room it is in, how it behaves |
| `SOUL.md` | no | character: voice, values, taste |
| `IDENTITY.md` | no | name, look, origin, emoji |
| `USER.md` | no | stable facts about the regulars; update in place |
| `lines.json` | no | canned line pools by event (`shift_start`, `summon`, scene and exit lines) |
| `moods.json` | no | weighted moods rolled on entry, each with an optional prompt |
| `avatar.png` | no | the bot's TeamSpeak avatar |

The workspace markdown is seeded into the bot's OpenClaw workspace once.
After that it belongs to the operator, so later edits happen on the box (or
through the persona tools), not by re-seeding. `personas/HUMAN.md` is loaded
under every pack as a shared tone floor.

## Steps

1. Copy the closest example from [`personas/`](../personas/README.md) to
   `config/personas/<id>/`.
2. Edit `voice.json`: pick a `voiceId`, set `wakeNames`, and add
   `wakeAliases` for the ways your STT mangles the name. List other bots'
   names in `excludeWakeNames` so two bots do not answer one call.
3. Rewrite `IDENTITY.md`, `SOUL.md` and `AGENTS.md`. Be concrete: what room
   this is, who the bot is not, what it does when asked for something it
   cannot do.
4. Set `tools.json`. Leave moderation off unless the bot's TeamSpeak
   identity is in a server group that has the permissions (see
   [tool catalog](tool-catalog.md), moderation).
5. Optionally add `lines.json`, `moods.json` and an avatar.
6. Restart the container, or add the bot from the dashboard's Bots tab. The
   stack allocates a bridge port, writes the gateway account, agent and
   binding, and adds the bot to the summoner. Give it shifts in
   `config/summoner/config.json` or it stays on duty around the clock. See
   [Schedules and events](schedules-and-events.md).

## Tips

- Write rules as instructions to the bot, one per line, and keep them
  short. Long prose gets ignored.
- Ban phrases you do not want ("help desk" filler) explicitly; models drift
  toward them.
- Keep lore in `AGENTS.md`/`IDENTITY.md`, behavior in `SOUL.md`, and facts
  about people in `USER.md`.
- Test in text first. Voice adds STT noise.
