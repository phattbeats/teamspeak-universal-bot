import { TeamSpeakBridgeClient } from "../bridge/client.js";
import {
  areTeamSpeakToolsEnabled,
  DEFAULT_COMMAND_PREFIX,
  isTeamSpeakBandEnabled,
  isTeamSpeakMusicEnabled,
  resolveAnnouncePaths,
  resolveSextonLogDir,
  resolveVillainPaths,
  resolveTeamSpeakBandConfig,
  resolveTeamSpeakVoiceMode,
  resolveTeamSpeakWakeConfig
} from "../config.js";
import { BandLeader } from "../tools/band.js";
import { createSongGenerator } from "../tools/band-generators.js";
import { Announcer } from "./announcer.js";
import { bridgePcmDurationMs, chunkBridgePcm } from "./audio.js";
import { MusicPlayer } from "../tools/music.js";
import { VillainController } from "../tools/villain.js";
import { selfBotId, summonerAction } from "../tools/summoner.js";
import {
  createTeamSpeakToolRegistration,
  runTeamSpeakTool,
  transcriptHistoryReader
} from "../tools/registry.js";
import {
  registerTeamSpeakToolAccess,
  unregisterTeamSpeakToolAccess
} from "../tools/turn-context.js";
import {
  formatStatusReply,
  parseTeamSpeakCommand
} from "./commands.js";
import { RoomPlaybackQueue } from "./room-playback.js";
import {
  SpeakerSessionManager
} from "./speaker-sessions.js";
const DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const CHANNEL_TREE_TIMEOUT_MS = 4e3;
const AGENT_TOOL_ITEM_ID = "teamspeak-agent-turn";
class TeamSpeakVoiceRuntime {
  constructor(params) {
    this.params = params;
    this.playback = new RoomPlaybackQueue({
      sink: {
        writeVoiceAudio: (pcm) => this.bridge.sendVoiceAudio(pcm),
        clearVoice: () => this.bridge.clearVoice()
      },
      minBargeInAudioEndMs: params.minBargeInAudioEndMs ?? DEFAULT_MIN_BARGE_IN_AUDIO_END_MS,
      log: params.log
    });
    this.sessions = new SpeakerSessionManager({
      createSession: (client) => this.params.createSpeakerSession(client, this.playback, this.tools),
      selfClientId: () => this.selfClientId,
      shouldOpenSession: (client) => !this.isExcludedNickname(client.nickname),
      onRosterEvent: (event) => this.handleRosterEvent(event),
      onSessionError: (clientId, error) => this.params.log?.(
        `teamspeak voice: speaker session error clientId=${clientId}: ${error.message}`
      ),
      log: params.log
    });
    this.bridge = new TeamSpeakBridgeClient({
      url: params.config.bridgeUrl ?? "ws://ts-bridge:9099",
      createSocket: params.createSocket,
      log: params.log,
      events: {
        onConnected: () => {
          this.params.onConnectionChange?.(true);
          const channel = this.params.config.channel;
          if (channel) {
            this.bridge.join(channel);
          }
        },
        onDisconnected: (reason) => {
          this.params.onConnectionChange?.(false);
          this.selfClientId = void 0;
          this.otherBotsSpeaking.clear();
          this.playback.otherBotSpeaking = false;
          this.sessions.closeAll(`bridge-disconnected:${reason}`);
          this.playback.handleBargeIn("bridge-disconnected", { force: true });
          this.music?.stop(`bridge-disconnected:${reason}`);
          this.state = { ...this.state, connected: false };
        },
        onState: (state) => {
          this.state = state;
          this.applySelfClientId(state.ownClientId);
        },
        onRoster: (roster) => {
          this.lastRoster = roster;
          this.sessions.applyRoster(roster);
        },
        onSpeakerStart: (clientId) => {
          if (this.parked) {
            return;
          }
          this.handleSpeakerStart(clientId);
        },
        onSpeakerStop: (clientId) => {
          if (this.otherBotsSpeaking.delete(clientId)) {
            this.playback.otherBotSpeaking = this.otherBotsSpeaking.size > 0;
          }
          if (this.parked) {
            return;
          }
          const session = this.sessions.get(clientId);
          session?.handleSpeakerStop?.();
        },
        onSpeakerAudio: (header, pcm) => {
          if (this.parked) {
            return;
          }
          const session = this.sessions.get(header.clientId);
          session?.sendInputAudio(pcm);
        },
        onTextMessage: (message) => this.handleTextMessage(message),
        onChannelTree: (channels) => {
          const waiter = this.channelTreeWaiters.shift();
          waiter?.(channels);
        },
        onError: (error) => this.params.log?.(`teamspeak bridge: ${error.message}`)
      }
    });
    this.music = this.createMusicController();
    this.band = this.createBandController();
    this.announcer = this.createAnnouncer();
    this.toolDeps = areTeamSpeakToolsEnabled(params.config) ? {
      config: params.config.tools,
      music: this.music,
      roster: () => this.sessions.rosterEntries(),
      channelName: () => this.state.channelName,
      poke: (clientId, text) => this.bridge.poke(clientId, text),
      sendText: (target, text) => this.bridge.sendText(target, text),
      setParked: (parked, reason) => this.setParked(parked, reason),
      isParked: () => this.parked,
      kickClient: (clientId, fromServer, reason) => this.bridge.kickClient(clientId, fromServer, reason),
      banClient: (clientId, durationSecs, reason) => this.bridge.banClient(clientId, durationSecs, reason),
      banDel: (banId) => this.bridge.banDel(banId),
      banList: () => this.bridge.banList(),
      moveClient: (clientId, channelId) => this.bridge.moveClient(clientId, channelId),
      muteClient: (clientId, muted) => this.bridge.muteClient(clientId, muted),
      editChannel: (channelId, name, topic) => this.bridge.editChannel(channelId, name, topic),
      createChannel: (name, parentId) => this.bridge.createChannel(name, parentId),
      deleteChannel: (channelId, force) => this.bridge.deleteChannel(channelId, force),
      editServer: (name, welcomeMessage) => this.bridge.editServer(name, welcomeMessage),
      addToServerGroup: (serverGroupId, clientId) => this.bridge.addToServerGroup(serverGroupId, clientId),
      listChannels: () => this.requestChannelTree(),
      moveToChannel: (channel) => this.bridge.join(channel),
      band: this.band,
      ...this.createVillain(),
      logDir: params.toolOverrides?.logDir ?? resolveSextonLogDir(params.config),
      ...params.toolOverrides?.readLog ? { readLog: params.toolOverrides.readLog } : {},
      ...params.toolOverrides?.now ? { now: params.toolOverrides.now } : {},
      ...params.log ? { log: params.log } : {}
    } : void 0;
    this.tools = this.toolDeps ? createTeamSpeakToolRegistration(this.toolDeps) : void 0;
  }
  params;
  bridge;
  playback;
  sessions;
  music;
  band;
  announcer;
  tools;
  toolDeps;
  access;
  state = { connected: false, channelId: 0, channelName: "" };
  muted = false;
  /**
   * Sitting out (PHA-3428). Parked is deaf, not disconnected: THE_PLANT has one
   * channel, so there is nowhere to walk off to and the bridge has no disconnect
   * frame. Inbound speech and conversational text are dropped, music stops, and
   * the only things still answered are `!vc join` / `join_voice`.
   */
  parked = false;
  lastRoster = [];
  channelTreeWaiters = [];
  selfClientId;
  chatTurnsInFlight = /* @__PURE__ */ new Set();
  /** Other bots in the channel that are mid-burst right now (PHA-3829). */
  otherBotsSpeaking = /* @__PURE__ */ new Set();
  /**
   * Lexton's villain tools (PHA-3820), off unless `tools.villain.enabled`.
   * `start()` re-arms reverts a previous gateway left pending; they wait out a
   * grace period and retry until the bridge answers with a channel tree.
   */
  createVillain() {
    const config = this.params.config.tools?.villain;
    if (config?.enabled !== true) {
      return {};
    }
    const paths = resolveVillainPaths(config);
    const villain = new VillainController(config, paths.stateFile, {
      listChannels: () => this.requestChannelTree(),
      moveClient: (clientId, channelId) => this.bridge.moveClient(clientId, channelId),
      muteClient: (clientId, muted) => this.bridge.muteClient(clientId, muted),
      createChannel: (name, parentId) => this.bridge.createChannel(name, parentId),
      moveToChannel: (channel) => this.bridge.join(channel),
      ...this.params.log ? { log: this.params.log } : {}
    });
    villain.start();
    return { villain, readHistory: transcriptHistoryReader(paths.transcriptDb) };
  }
  /** The tools the speaker sessions register on their provider session. */
  get toolRegistration() {
    return this.tools;
  }
  get musicController() {
    return this.music;
  }
  /**
   * The same six tools as `toolRegistration`, in the shape the agent-tool face
   * calls (PHA-3428 item 4). Undefined when tools are disabled for this
   * account, so the account simply never publishes any.
   */
  get toolAccess() {
    const deps = this.toolDeps;
    if (!deps) {
      return void 0;
    }
    this.access ??= {
      run: (name, args, context) => (
        // The realtime event fields exist for `submitToolResult` correlation,
        // which this lane has no use for; they are stamped so a tool call from
        // the stt-tts or text lane is identifiable in the tool log.
        runTeamSpeakTool(
          deps,
          { name, args, itemId: AGENT_TOOL_ITEM_ID, callId: `${AGENT_TOOL_ITEM_ID}:${name}` },
          { clientId: context.clientId, nickname: context.nickname }
        )
      )
    };
    return this.access;
  }
  start() {
    const access = this.toolAccess;
    if (access) {
      registerTeamSpeakToolAccess(this.params.accountId, access);
    }
    this.bridge.connect();
    this.announcer?.start();
  }
  stop() {
    if (this.access) {
      unregisterTeamSpeakToolAccess(this.params.accountId, this.access);
    }
    this.announcer?.stop();
    this.band?.close();
    this.music?.close();
    this.sessions.close("runtime-stop");
    this.playback.close();
    this.bridge.close();
  }
  /** The house band, for `!sexton status` and tests. */
  get bandController() {
    return this.band;
  }
  /**
   * Learn which roster entry is us.
   *
   * The bridge publishes this with the state that established the connection,
   * because TeamSpeak issues a fresh clientId per session. State normally
   * precedes the roster it describes, but a bridge that reconnects while we are
   * mid-roster can deliver it the other way round, so a late or changed id
   * re-runs the last roster: that closes a session we opened on ourselves and
   * drops us back out of the human count, instead of leaving the wake gate
   * wedged on for the life of the process.
   */
  applySelfClientId(ownClientId) {
    if (ownClientId === void 0 || ownClientId === this.selfClientId) {
      return;
    }
    this.selfClientId = ownClientId;
    this.sessions.applyRoster(this.sessions.rosterEntries());
  }
  /**
   * Ask the bridge for the full channel tree and wait for the answer
   * (PHA-3784). Resolves to `[]` on timeout rather than rejecting — the
   * tools that call this (`list_channels`, `where_is`, `move_to_channel`'s
   * `follow`) already treat an empty tree as "found nothing" and say so,
   * which is a better outcome for a voice turn than an unhandled rejection.
   */
  requestChannelTree() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (channels) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(channels);
      };
      this.channelTreeWaiters.push(finish);
      this.bridge.listChannels();
      setTimeout(() => {
        const idx = this.channelTreeWaiters.indexOf(finish);
        if (idx !== -1) {
          this.channelTreeWaiters.splice(idx, 1);
        }
        finish([]);
      }, CHANNEL_TREE_TIMEOUT_MS);
    });
  }
  createMusicController() {
    const sink = {
      sendMusicAudio: (pcm) => this.bridge.sendMusicAudio(pcm),
      setMusicGain: (gain) => this.bridge.setMusicGain(gain)
    };
    const createMusic = this.params.toolOverrides?.createMusic;
    if (createMusic) {
      return createMusic(sink);
    }
    if (!isTeamSpeakMusicEnabled(this.params.config)) {
      return void 0;
    }
    return new MusicPlayer({
      config: this.params.config.tools?.music,
      sink,
      ...this.params.log ? { log: this.params.log } : {}
    });
  }
  /**
   * The house band (PHA-3554). Needs the music lane to exist and the account
   * to have opted in; a band that cannot start logs why once and the account
   * simply has no `compose_song`.
   */
  createBandController() {
    const music = this.music;
    if (!music) {
      return void 0;
    }
    const speak = this.params.synthesize ? this.createRoomSpeaker(this.params.synthesize, "band-leader") : void 0;
    const createBand = this.params.toolOverrides?.createBand;
    if (createBand) {
      return createBand({ music, speak });
    }
    if (!isTeamSpeakBandEnabled(this.params.config)) {
      return void 0;
    }
    const resolved = resolveTeamSpeakBandConfig(this.params.config);
    if (!resolved.ok) {
      this.params.log?.(`teamspeak band: not starting - ${resolved.reason}`);
      return void 0;
    }
    return new BandLeader({
      config: resolved.config,
      generator: createSongGenerator(resolved.config, {
        ...this.params.log ? { log: this.params.log } : {}
      }),
      music,
      speak,
      onSettled: (status) => this.handleBandSettled(status),
      ...this.params.log ? { log: this.params.log } : {}
    });
  }
  /**
   * Entrance/exit lines (PHA-3824). Ready once the bridge has put us in the
   * channel; an entrance written before the core started waits for that.
   */
  createAnnouncer() {
    const config = this.params.config.tools?.announce;
    if (!this.params.synthesize || config?.enabled === false) {
      return void 0;
    }
    return new Announcer({
      ...resolveAnnouncePaths(config),
      speak: this.createRoomSpeaker(this.params.synthesize, "announcer"),
      isReady: () => this.bridge.isConnected && this.state.connected && this.selfClientId !== void 0,
      ...this.params.log ? { log: this.params.log } : {}
    });
  }
  /**
   * PHA-3601: the room hears the announcement, or the in-character line when a
   * song fails, but the agent itself was never told either happened — only the
   * room did. So the next time someone asked for the words or to hear it
   * again, the agent had nothing to check and improvised in character instead
   * (e.g. claiming a song that had actually failed to record was "still
   * coming"). A silent event costs no speech, but puts the real outcome in the
   * agent's own context for the next turn.
   */
  handleBandSettled(status) {
    const deliver = this.params.deliverSilentEvent;
    if (!deliver) {
      return;
    }
    const title = status.title ?? "the song";
    if (status.status === "failed") {
      deliver(`[band] "${title}" failed to record: ${status.error ?? "unknown error"}. Nothing played.`);
      return;
    }
    if (status.status === "playing") {
      deliver(`[band] "${title}" is playing now.`);
    }
  }
  /**
   * Say a line on the runtime's own behalf. It queues behind whatever a
   * speaker session is saying, holds the lane for exactly its own audio, and
   * reports how long that audio runs so the caller can time what follows it.
   */
  createRoomSpeaker(synthesize, owner) {
    return async (text) => {
      if (this.parked) {
        return void 0;
      }
      const speech = await synthesize(text);
      if (speech.status === "empty") {
        return void 0;
      }
      if (speech.status === "failed") {
        throw new Error(`speech synthesis failed: ${speech.error}`);
      }
      for (const frame of chunkBridgePcm(speech.pcm48kMono)) {
        this.playback.enqueue(owner, frame);
      }
      this.playback.release(owner);
      return { durationMs: bridgePcmDurationMs(speech.pcm48kMono) };
    };
  }
  /**
   * Humans in the channel, excluding the bot.
   *
   * Speaker sessions ask the runtime this to resolve the wake gate, and they
   * must ask *here* rather than through `snapshot()`: snapshot reads a session's
   * `wakeNameRequired`, so a session whose gate reached back into snapshot would
   * recurse until the stack ran out. That is what `!sexton status` used to do on
   * the realtime lane.
   */
  humanParticipantCount() {
    return this.sessions.humanParticipantCount();
  }
  /**
   * Is this roster nickname the other bot?
   *
   * `excludeWakeNames` is already hand-populated with the other bot's exact
   * TeamSpeak nickname for the wake gate (PHA-3605); a roster nickname never
   * collides with the non-nickname aliases also listed there ("band leader",
   * "maestro"), so reusing the same list to withhold a speaker session costs
   * nothing extra to configure (PHA-3607).
   */
  isExcludedNickname(nickname) {
    const excludeNames = resolveTeamSpeakWakeConfig(this.params.config).excludeWakeNames ?? [];
    const needle = nickname.trim().toLowerCase();
    return needle.length > 0 && excludeNames.some((name) => name.trim().toLowerCase() === needle);
  }
  /** True while the Sexton is sitting out. */
  get isParked() {
    return this.parked;
  }
  /**
   * Sit out, or come back.
   *
   * Leaving stops the music and drops whatever is mid-playback, but does not
   * mute the bridge: on the stt-tts lane the spoken goodbye is produced after
   * `leave_voice` returns, and a mute here would eat it. Nothing else asks the
   * Sexton to speak while parked, so deaf is the whole of it.
   */
  setParked(parked, reason) {
    if (this.parked === parked) {
      return;
    }
    this.parked = parked;
    if (parked) {
      this.music?.stop(reason);
    } else {
      this.sessions.applyRoster(this.lastRoster);
    }
    this.params.log?.(
      `teamspeak voice: ${parked ? "parked" : "unparked"} reason=${reason} channel=${this.state.channelName}`
    );
  }
  /** Exposed for `!sexton status` and for tests. */
  snapshot() {
    const firstSession = this.sessions.sessionKeys()[0];
    const session = firstSession === void 0 ? void 0 : this.sessions.get(firstSession);
    return {
      bridgeConnected: this.bridge.isConnected && this.state.connected,
      channelName: this.state.channelName,
      humanParticipants: this.sessions.humanParticipantCount(),
      speakerSessions: this.sessions.sessionCount,
      voiceMode: resolveTeamSpeakVoiceMode(this.params.config),
      ...this.params.providerId?.() ? { providerId: this.params.providerId() } : {},
      wakeNameRequired: session?.wakeNameRequired ?? false,
      wakeNames: resolveTeamSpeakWakeConfig(this.params.config).wakeNames ?? [],
      bargeInEnabled: session?.bargeInEnabled ?? false,
      muted: this.muted,
      parked: this.parked,
      playbackActive: this.playback.isActive(),
      ...this.music ? { music: describeMusic(this.music) } : {}
    };
  }
  /**
   * A human started talking.
   *
   * The speaker's own session hears this first and unconditionally: the stt-tts
   * lane uses the edge to reopen its segment, which has to happen whether or not
   * anything is currently playing. Only after that does this look for a session
   * to interrupt, and only the session that owns the room lane can be
   * interrupted, so the rest are asked in turn rather than broadcast to.
   */
  handleSpeakerStart(clientId) {
    this.noteOtherBotSpeaking(clientId);
    const speaker = this.sessions.get(clientId);
    if (speaker?.handleSpeakerStart(`speaker-start:${clientId}`)) {
      return;
    }
    if (!this.playback.activeOwner) {
      return;
    }
    for (const key of this.sessions.sessionKeys()) {
      if (key === clientId) {
        continue;
      }
      const session = this.sessions.get(key);
      if (session && session.handleSpeakerStart(`speaker-start:${clientId}`)) {
        return;
      }
    }
  }
  /**
   * Another bot started talking (PHA-3829). Two bots each holding a follow-up
   * window on the same person answered every line that person said, on top of
   * each other. Whoever speaks takes the room: every follow-up window here
   * closes, and a new answer needs our name again.
   */
  noteOtherBotSpeaking(clientId) {
    if (this.sessions.hasSession(clientId)) {
      return;
    }
    const entry = this.sessions.rosterEntries().find((client) => client.clientId === clientId);
    if (!entry || !this.isExcludedNickname(entry.nickname)) {
      return;
    }
    this.otherBotsSpeaking.add(clientId);
    this.playback.otherBotSpeaking = true;
    for (const key of this.sessions.sessionKeys()) {
      const session = this.sessions.get(key);
      session?.endFollowUp?.(`other-bot:${entry.nickname}`);
    }
  }
  handleRosterEvent(event) {
    const deliver = this.params.deliverSilentEvent;
    if (!deliver) {
      return;
    }
    switch (event.kind) {
      case "joined":
        deliver(`[teamspeak] ${event.client.nickname} joined the channel.`);
        return;
      case "left":
        deliver(`[teamspeak] ${event.client.nickname} left the channel.`);
        return;
      case "renamed":
        deliver(
          `[teamspeak] ${event.previousNickname} is now known as ${event.client.nickname}.`
        );
    }
  }
  handleTextMessage(message) {
    const result = parseTeamSpeakCommand(message, {
      prefix: this.params.config.commandPrefix ?? DEFAULT_COMMAND_PREFIX,
      ...this.params.config.commandAllowFrom ? { allowFrom: this.params.config.commandAllowFrom } : {},
      currentlyMuted: this.muted
    });
    if (!result.ok) {
      if (result.failure.reply) {
        this.reply(message, result.failure.reply);
        return;
      }
      if (result.failure.reason === "not-a-command") {
        this.handleChatMessage(message);
      }
      return;
    }
    this.runCommand(result.parsed.command, message);
  }
  runCommand(command, message) {
    switch (command.kind) {
      case "vc-join": {
        const channel = command.channel ?? this.params.config.channel;
        if (!channel) {
          this.reply(message, "No channel configured; use !vc join <channel>.");
          return;
        }
        const wasParked = this.parked;
        this.setParked(false, `vc-join:${message.nickname}`);
        if (channel !== this.state.channelName) {
          this.bridge.join(channel);
          this.reply(message, `Joining ${channel}.`);
          return;
        }
        this.reply(message, wasParked ? `Back in ${channel}.` : `Already in ${channel}.`);
        return;
      }
      case "vc-leave": {
        this.playback.handleBargeIn("vc-leave", { force: true });
        this.setParked(true, `vc-leave:${message.nickname}`);
        this.music?.stop("vc-leave");
        this.reply(message, "Sitting out. Say !vc join when you want me back.");
        return;
      }
      case "vc-dismiss": {
        const bot = command.bot ?? selfBotId();
        void summonerAction(this.params.config.tools?.summoner, "dismiss", bot, message.nickname).then(
          (result) => this.reply(
            message,
            result.ok ? command.bot ? `Sending ${String(result.bot)} home.` : "Alright, I'm off. Later." : String(result.error)
          )
        );
        return;
      }
      case "vc-mute": {
        this.muted = command.muted;
        this.bridge.setMuted(command.muted);
        if (command.muted) {
          this.playback.handleBargeIn("vc-mute", { force: true });
          this.music?.stop("vc-mute");
        }
        this.reply(message, command.muted ? "Muted." : "Unmuted.");
        return;
      }
      case "status":
        this.reply(message, formatStatusReply(this.snapshot()));
    }
  }
  /**
   * Conversational text (PHA-3428).
   *
   * Only addressed messages get a turn: a PM is always addressed, channel text
   * only when it names the Sexton. Answering every line in a busy room would
   * make the bot unbearable, and the voice lane already gates the same way.
   */
  handleChatMessage(message) {
    const run = this.params.onChatMessage;
    if (!run) {
      return;
    }
    if (this.selfClientId !== void 0 && message.clientId === this.selfClientId) {
      return;
    }
    if (this.parked) {
      return;
    }
    if (!message.text.trim()) {
      return;
    }
    if (message.target !== "client" && !this.isAddressed(message.text)) {
      return;
    }
    if (this.chatTurnsInFlight.has(message.clientId)) {
      this.params.log?.(
        `teamspeak text: dropping message, a turn is already running clientId=${message.clientId}`
      );
      return;
    }
    this.chatTurnsInFlight.add(message.clientId);
    void run(message).then((reply) => {
      if (reply) {
        this.reply(message, reply);
      }
    }).catch((error) => {
      this.params.log?.(
        `teamspeak text: turn failed clientId=${message.clientId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }).finally(() => {
      this.chatTurnsInFlight.delete(message.clientId);
    });
  }
  /** Does this line name us? Same wake names the voice lane gates on. */
  isAddressed(text) {
    const haystack = text.toLowerCase();
    const names = resolveTeamSpeakWakeConfig(this.params.config).wakeNames ?? [];
    const candidates = names.length > 0 ? names : ["sexton"];
    return candidates.some((name) => {
      const needle = name.trim().toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    });
  }
  reply(message, text) {
    if (message.target === "client" || message.target === "poke") {
      this.bridge.sendText(message.clientId, text);
      return;
    }
    this.bridge.sendText(message.target === "server" ? "server" : "channel", text);
  }
}
function describeMusic(music) {
  const volume = `${Math.round(music.volume * 100)}%`;
  const track = music.nowPlaying;
  return track ? `playing "${track.title}" at ${volume}` : `idle (volume ${volume})`;
}
export {
  TeamSpeakVoiceRuntime
};
