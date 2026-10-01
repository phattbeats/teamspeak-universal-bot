/**
 * Wires the bridge socket to the speaker sessions, the room queue, and chat
 * commands. This is the TeamSpeak analogue of Discord's voice-runtime.ts: it
 * owns no provider logic, only routing.
 */
import { TeamSpeakBridgeClient, type BridgeSocketFactory } from "../bridge/client.js";
import type {
  BridgeStateHeader,
  ChannelInfo,
  RosterEntry,
  TeamSpeakClientId,
  TextMessageHeader,
} from "../bridge/protocol.js";
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
  resolveTeamSpeakWakeConfig,
  type TeamSpeakAccountConfig,
} from "../config.js";
import { BandLeader, type BandController, type BandSpeak, type BandStatus } from "../tools/band.js";
import { createSongGenerator } from "../tools/band-generators.js";
import { Announcer } from "./announcer.js";
import { bridgePcmDurationMs, chunkBridgePcm } from "./audio.js";
import type { SpeechSynthesisOutcome } from "./speech.js";
import type { ReadChannelLog } from "../tools/catch-up.js";
import { MusicPlayer, type MusicController, type MusicSink } from "../tools/music.js";
import { VillainController } from "../tools/villain.js";
import { selfBotId, summonerAction } from "../tools/summoner.js";
import {
  createTeamSpeakToolRegistration,
  runTeamSpeakTool,
  transcriptHistoryReader,
  type TeamSpeakToolDeps,
} from "../tools/registry.js";
import {
  registerTeamSpeakToolAccess,
  unregisterTeamSpeakToolAccess,
  type TeamSpeakToolAccess,
} from "../tools/turn-context.js";
import {
  formatStatusReply,
  parseTeamSpeakCommand,
  type StatusSnapshot,
  type TeamSpeakCommand,
} from "./commands.js";
import type { TeamSpeakRealtimeToolRegistration } from "./realtime-speaker-session.js";
import { RoomPlaybackQueue } from "./room-playback.js";
import {
  SpeakerSessionManager,
  type RosterEvent,
  type SpeakerSession,
} from "./speaker-sessions.js";

/** The speaker-session surface the runtime drives beyond the manager's needs. */
export type VoiceSpeakerSession = SpeakerSession & {
  sendInputAudio(pcm48kMono: Buffer): void;
  handleSpeakerStart(reason?: string): boolean;
  /**
   * TeamSpeak's end-of-talk-burst edge. The realtime lane has no use for it —
   * the provider does its own endpointing — but the stt-tts lane (PHA-3228)
   * closes its segment on it, so the runtime forwards it when a session cares.
   */
  handleSpeakerStop?(): void;
  /** Close the no-name follow-up window: another bot has the room now (PHA-3829). */
  endFollowUp?(reason: string): void;
  readonly wakeNameRequired: boolean;
  readonly bargeInEnabled: boolean;
};

/**
 * Test/deployment seams for the realtime tools. `createMusic` receives the
 * runtime's own music sink, so a substitute player still writes to the bridge's
 * `music_audio` lane; returning undefined from it disables the music tools.
 */
export type TeamSpeakToolOverrides = {
  createMusic?: ((sink: MusicSink) => MusicController | undefined) | undefined;
  /**
   * The house band (PHA-3554). Receives the runtime's music controller and a
   * `speak` that goes through the room playback queue, so a substitute band
   * still announces and plays where the real one would.
   */
  createBand?:
    | ((deps: { music: MusicController; speak: BandSpeak | undefined }) => BandController | undefined)
    | undefined;
  readLog?: ReadChannelLog | undefined;
  now?: (() => Date) | undefined;
  logDir?: string | undefined;
};

export type TeamSpeakVoiceRuntimeParams = {
  accountId: string;
  config: TeamSpeakAccountConfig;
  createSocket: BridgeSocketFactory;
  createSpeakerSession: (
    client: RosterEntry,
    playback: RoomPlaybackQueue,
    tools: TeamSpeakRealtimeToolRegistration | undefined,
  ) => VoiceSpeakerSession;
  toolOverrides?: TeamSpeakToolOverrides | undefined;
  /**
   * Turn a line into bridge PCM, for things the runtime says on its own
   * behalf rather than as a reply to a speaker — today, the band leader's
   * announcement (PHA-3554). The stt-tts lane supplies its synthesizer;
   * undefined means the band plays without an introduction.
   */
  synthesize?: ((text: string) => Promise<SpeechSynthesisOutcome>) | undefined;
  minBargeInAudioEndMs?: number | undefined;
  /**
   * Roster changes are delivered into the agent session as silent events: they
   * give the agent room awareness ("who is here") without producing speech.
   */
  deliverSilentEvent?: ((text: string) => void) | undefined;
  providerId?: (() => string | undefined) | undefined;
  /**
   * A chat message that is not a command (PHA-3428). The runtime hands over the
   * addressed ones and writes whatever comes back to the same target the
   * message arrived on; undefined disables the text lane entirely.
   */
  onChatMessage?: ((message: TextMessageHeader) => Promise<string | undefined>) | undefined;
  /** Bridge socket up/down, so the gateway's account status is not a guess. */
  onConnectionChange?: ((connected: boolean) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

const DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
/**
 * `listChannels()`/`onChannelTree` have no request id (PHA-3784, same shape
 * as every other command on this connection) — a FIFO queue of waiters is
 * correct as long as the bridge answers in the order asked, which a single
 * TCP-ish WebSocket guarantees. This bounds how long a tool call waits if
 * the bridge never answers (disconnect mid-flight).
 */
const CHANNEL_TREE_TIMEOUT_MS = 4_000;

/** Marks a tool call that came from an agent turn rather than a realtime session. */
const AGENT_TOOL_ITEM_ID = "teamspeak-agent-turn";

export class TeamSpeakVoiceRuntime {
  private readonly bridge: TeamSpeakBridgeClient;
  private readonly playback: RoomPlaybackQueue;
  private readonly sessions: SpeakerSessionManager;
  private readonly music: MusicController | undefined;
  private readonly band: BandController | undefined;
  private readonly announcer: Announcer | undefined;
  private readonly tools: TeamSpeakRealtimeToolRegistration | undefined;
  private readonly toolDeps: TeamSpeakToolDeps | undefined;
  private access: TeamSpeakToolAccess | undefined;
  private state: BridgeStateHeader = { connected: false, channelId: 0, channelName: "" };
  private muted = false;
  /**
   * Sitting out (PHA-3428). Parked is deaf, not disconnected: THE_PLANT has one
   * channel, so there is nowhere to walk off to and the bridge has no disconnect
   * frame. Inbound speech and conversational text are dropped, music stops, and
   * the only things still answered are `!vc join` / `join_voice`.
   */
  private parked = false;
  private lastRoster: RosterEntry[] = [];
  private channelTreeWaiters: Array<(channels: ChannelInfo[]) => void> = [];
  private selfClientId: TeamSpeakClientId | undefined;
  private readonly chatTurnsInFlight = new Set<TeamSpeakClientId>();
  /** Other bots in the channel that are mid-burst right now (PHA-3829). */
  private readonly otherBotsSpeaking = new Set<TeamSpeakClientId>();

  constructor(private readonly params: TeamSpeakVoiceRuntimeParams) {
    this.playback = new RoomPlaybackQueue({
      sink: {
        writeVoiceAudio: (pcm) => this.bridge.sendVoiceAudio(pcm),
        clearVoice: () => this.bridge.clearVoice(),
      },
      minBargeInAudioEndMs: params.minBargeInAudioEndMs ?? DEFAULT_MIN_BARGE_IN_AUDIO_END_MS,
      log: params.log,
    });
    this.sessions = new SpeakerSessionManager({
      createSession: (client) => this.params.createSpeakerSession(client, this.playback, this.tools),
      selfClientId: () => this.selfClientId,
      shouldOpenSession: (client) => !this.isExcludedNickname(client.nickname),
      onRosterEvent: (event) => this.handleRosterEvent(event),
      onSessionError: (clientId, error) =>
        this.params.log?.(
          `teamspeak voice: speaker session error clientId=${clientId}: ${error.message}`,
        ),
      log: params.log,
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
          // The bridge hands out a fresh clientId per TeamSpeak session, so the
          // one we were filtering on is stale the moment the socket drops.
          this.selfClientId = undefined;
          this.otherBotsSpeaking.clear();
          this.playback.otherBotSpeaking = false;
          // The bridge owns the TeamSpeak connection. When it drops, every
          // clientId we were keyed on is void; rebuild from the next roster.
          this.sessions.closeAll(`bridge-disconnected:${reason}`);
          this.playback.handleBargeIn("bridge-disconnected", { force: true });
          // Music is paced against a socket that no longer exists; a reconnect
          // would resume mid-track with the wrong clock, so end the track.
          this.music?.stop(`bridge-disconnected:${reason}`);
          this.state = { ...this.state, connected: false };
        },
        onState: (state) => {
          this.state = state;
          this.applySelfClientId(state.ownClientId);
        },
        onRoster: (roster) => {
          // Kept because `closeAll` empties the manager's roster: coming back
          // from parked has to rebuild the sessions from somewhere, and the
          // bridge only re-sends a roster when it changes.
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
          const session = this.sessions.get(clientId) as VoiceSpeakerSession | undefined;
          session?.handleSpeakerStop?.();
        },
        onSpeakerAudio: (header, pcm) => {
          if (this.parked) {
            return;
          }
          const session = this.sessions.get(header.clientId) as VoiceSpeakerSession | undefined;
          session?.sendInputAudio(pcm);
        },
        onTextMessage: (message) => this.handleTextMessage(message),
        onChannelTree: (channels) => {
          const waiter = this.channelTreeWaiters.shift();
          waiter?.(channels);
        },
        onError: (error) => this.params.log?.(`teamspeak bridge: ${error.message}`),
      },
    });
    this.music = this.createMusicController();
    this.band = this.createBandController();
    this.announcer = this.createAnnouncer();
    // Held as deps, not just as the realtime registration, because the agent
    // tools reach the same implementations through `runTeamSpeakTool` with a
    // precise result type (PHA-3428 item 4).
    this.toolDeps = areTeamSpeakToolsEnabled(params.config)
      ? {
          config: params.config.tools,
          music: this.music,
          roster: () => this.sessions.rosterEntries(),
          channelName: () => this.state.channelName,
          poke: (clientId, text) => this.bridge.poke(clientId, text),
          sendText: (target, text) => this.bridge.sendText(target, text),
          setParked: (parked, reason) => this.setParked(parked, reason),
          isParked: () => this.parked,
          kickClient: (clientId, fromServer, reason) => this.bridge.kickClient(clientId, fromServer, reason),
          banClient: (clientId, durationSecs, reason) =>
            this.bridge.banClient(clientId, durationSecs, reason),
          banDel: (banId) => this.bridge.banDel(banId),
          banList: () => this.bridge.banList(),
          moveClient: (clientId, channelId) => this.bridge.moveClient(clientId, channelId),
          muteClient: (clientId, muted) => this.bridge.muteClient(clientId, muted),
          editChannel: (channelId, name, topic) => this.bridge.editChannel(channelId, name, topic),
          createChannel: (name, parentId) => this.bridge.createChannel(name, parentId),
          deleteChannel: (channelId, force) => this.bridge.deleteChannel(channelId, force),
          editServer: (name, welcomeMessage) => this.bridge.editServer(name, welcomeMessage),
          addToServerGroup: (serverGroupId, clientId) =>
            this.bridge.addToServerGroup(serverGroupId, clientId),
          listChannels: () => this.requestChannelTree(),
          moveToChannel: (channel) => this.bridge.join(channel),
          band: this.band,
          ...this.createVillain(),
          logDir: params.toolOverrides?.logDir ?? resolveSextonLogDir(params.config),
          ...(params.toolOverrides?.readLog ? { readLog: params.toolOverrides.readLog } : {}),
          ...(params.toolOverrides?.now ? { now: params.toolOverrides.now } : {}),
          ...(params.log ? { log: params.log } : {}),
        }
      : undefined;
    this.tools = this.toolDeps ? createTeamSpeakToolRegistration(this.toolDeps) : undefined;
  }

  /**
   * Lexton's villain tools (PHA-3820), off unless `tools.villain.enabled`.
   * `start()` re-arms reverts a previous gateway left pending; they wait out a
   * grace period and retry until the bridge answers with a channel tree.
   */
  private createVillain(): Pick<TeamSpeakToolDeps, "villain" | "readHistory"> {
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
      ...(this.params.log ? { log: this.params.log } : {}),
    });
    villain.start();
    return { villain, readHistory: transcriptHistoryReader(paths.transcriptDb) };
  }

  /** The tools the speaker sessions register on their provider session. */
  get toolRegistration(): TeamSpeakRealtimeToolRegistration | undefined {
    return this.tools;
  }

  get musicController(): MusicController | undefined {
    return this.music;
  }

  /**
   * The same six tools as `toolRegistration`, in the shape the agent-tool face
   * calls (PHA-3428 item 4). Undefined when tools are disabled for this
   * account, so the account simply never publishes any.
   */
  get toolAccess(): TeamSpeakToolAccess | undefined {
    const deps = this.toolDeps;
    if (!deps) {
      return undefined;
    }
    this.access ??= {
      run: (name, args, context) =>
        // The realtime event fields exist for `submitToolResult` correlation,
        // which this lane has no use for; they are stamped so a tool call from
        // the stt-tts or text lane is identifiable in the tool log.
        runTeamSpeakTool(
          deps,
          { name, args, itemId: AGENT_TOOL_ITEM_ID, callId: `${AGENT_TOOL_ITEM_ID}:${name}` },
          { clientId: context.clientId as TeamSpeakClientId, nickname: context.nickname },
        ),
    };
    return this.access;
  }

  start(): void {
    const access = this.toolAccess;
    if (access) {
      registerTeamSpeakToolAccess(this.params.accountId, access);
    }
    this.bridge.connect();
    this.announcer?.start();
  }

  stop(): void {
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
  get bandController(): BandController | undefined {
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
  private applySelfClientId(ownClientId: TeamSpeakClientId | undefined): void {
    if (ownClientId === undefined || ownClientId === this.selfClientId) {
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
  private requestChannelTree(): Promise<ChannelInfo[]> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (channels: ChannelInfo[]) => {
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

  private createMusicController(): MusicController | undefined {
    const sink: MusicSink = {
      sendMusicAudio: (pcm) => this.bridge.sendMusicAudio(pcm),
      setMusicGain: (gain) => this.bridge.setMusicGain(gain),
    };
    const createMusic = this.params.toolOverrides?.createMusic;
    if (createMusic) {
      return createMusic(sink);
    }
    if (!isTeamSpeakMusicEnabled(this.params.config)) {
      return undefined;
    }
    return new MusicPlayer({
      config: this.params.config.tools?.music,
      sink,
      ...(this.params.log ? { log: this.params.log } : {}),
    });
  }

  /**
   * The house band (PHA-3554). Needs the music lane to exist and the account
   * to have opted in; a band that cannot start logs why once and the account
   * simply has no `compose_song`.
   */
  private createBandController(): BandController | undefined {
    const music = this.music;
    if (!music) {
      return undefined;
    }
    const speak = this.params.synthesize ? this.createRoomSpeaker(this.params.synthesize, "band-leader") : undefined;
    const createBand = this.params.toolOverrides?.createBand;
    if (createBand) {
      return createBand({ music, speak });
    }
    if (!isTeamSpeakBandEnabled(this.params.config)) {
      return undefined;
    }
    const resolved = resolveTeamSpeakBandConfig(this.params.config);
    if (!resolved.ok) {
      this.params.log?.(`teamspeak band: not starting - ${resolved.reason}`);
      return undefined;
    }
    return new BandLeader({
      config: resolved.config,
      generator: createSongGenerator(resolved.config, {
        ...(this.params.log ? { log: this.params.log } : {}),
      }),
      music,
      speak,
      onSettled: (status) => this.handleBandSettled(status),
      ...(this.params.log ? { log: this.params.log } : {}),
    });
  }

  /**
   * Entrance/exit lines (PHA-3824). Ready once the bridge has put us in the
   * channel; an entrance written before the core started waits for that.
   */
  private createAnnouncer(): Announcer | undefined {
    const config = this.params.config.tools?.announce;
    if (!this.params.synthesize || config?.enabled === false) {
      return undefined;
    }
    return new Announcer({
      ...resolveAnnouncePaths(config),
      speak: this.createRoomSpeaker(this.params.synthesize, "announcer"),
      isReady: () => this.bridge.isConnected && this.state.connected && this.selfClientId !== undefined,
      ...(this.params.log ? { log: this.params.log } : {}),
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
  private handleBandSettled(status: BandStatus): void {
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
  private createRoomSpeaker(
    synthesize: (text: string) => Promise<SpeechSynthesisOutcome>,
    owner: string,
  ): BandSpeak {
    return async (text) => {
      if (this.parked) {
        return undefined;
      }
      const speech = await synthesize(text);
      if (speech.status === "empty") {
        return undefined;
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
  humanParticipantCount(): number {
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
  private isExcludedNickname(nickname: string): boolean {
    const excludeNames = resolveTeamSpeakWakeConfig(this.params.config).excludeWakeNames ?? [];
    const needle = nickname.trim().toLowerCase();
    return needle.length > 0 && excludeNames.some((name) => name.trim().toLowerCase() === needle);
  }

  /** True while the Sexton is sitting out. */
  get isParked(): boolean {
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
  setParked(parked: boolean, reason: string): void {
    if (this.parked === parked) {
      return;
    }
    this.parked = parked;
    if (parked) {
      this.music?.stop(reason);
    } else {
      // Rebuild the speaker sessions `vc-leave` tore down. Without this the
      // Sexton comes back with an empty roster and stays deaf until the next
      // time someone joins or leaves the channel.
      this.sessions.applyRoster(this.lastRoster);
    }
    this.params.log?.(
      `teamspeak voice: ${parked ? "parked" : "unparked"} reason=${reason} channel=${this.state.channelName}`,
    );
  }

  /** Exposed for `!sexton status` and for tests. */
  snapshot(): StatusSnapshot {
    const firstSession = this.sessions.sessionKeys()[0];
    const session = firstSession === undefined
      ? undefined
      : (this.sessions.get(firstSession) as VoiceSpeakerSession | undefined);
    return {
      bridgeConnected: this.bridge.isConnected && this.state.connected,
      channelName: this.state.channelName,
      humanParticipants: this.sessions.humanParticipantCount(),
      speakerSessions: this.sessions.sessionCount,
      voiceMode: resolveTeamSpeakVoiceMode(this.params.config),
      ...(this.params.providerId?.() ? { providerId: this.params.providerId() } : {}),
      wakeNameRequired: session?.wakeNameRequired ?? false,
      wakeNames: resolveTeamSpeakWakeConfig(this.params.config).wakeNames ?? [],
      bargeInEnabled: session?.bargeInEnabled ?? false,
      muted: this.muted,
      parked: this.parked,
      playbackActive: this.playback.isActive(),
      ...(this.music ? { music: describeMusic(this.music) } : {}),
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
  private handleSpeakerStart(clientId: TeamSpeakClientId): void {
    this.noteOtherBotSpeaking(clientId);
    const speaker = this.sessions.get(clientId) as VoiceSpeakerSession | undefined;
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
      const session = this.sessions.get(key) as VoiceSpeakerSession | undefined;
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
  private noteOtherBotSpeaking(clientId: TeamSpeakClientId): void {
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
      const session = this.sessions.get(key) as VoiceSpeakerSession | undefined;
      session?.endFollowUp?.(`other-bot:${entry.nickname}`);
    }
  }

  private handleRosterEvent(event: RosterEvent): void {
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
          `[teamspeak] ${event.previousNickname} is now known as ${event.client.nickname}.`,
        );
    }
  }

  private handleTextMessage(message: TextMessageHeader): void {
    const result = parseTeamSpeakCommand(message, {
      prefix: this.params.config.commandPrefix ?? DEFAULT_COMMAND_PREFIX,
      ...(this.params.config.commandAllowFrom
        ? { allowFrom: this.params.config.commandAllowFrom }
        : {}),
      currentlyMuted: this.muted,
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

  private runCommand(command: TeamSpeakCommand, message: TextMessageHeader): void {
    switch (command.kind) {
      case "vc-join": {
        const channel = command.channel ?? this.params.config.channel;
        if (!channel) {
          this.reply(message, "No channel configured; use !vc join <channel>.");
          return;
        }
        const wasParked = this.parked;
        this.setParked(false, `vc-join:${message.nickname}`);
        // Only re-issue the join when we are actually elsewhere; re-joining the
        // channel we are already in would churn the roster for nothing.
        if (channel !== this.state.channelName) {
          this.bridge.join(channel);
          this.reply(message, `Joining ${channel}.`);
          return;
        }
        this.reply(message, wasParked ? `Back in ${channel}.` : `Already in ${channel}.`);
        return;
      }
      case "vc-leave": {
        // Sessions are left standing rather than closed: parked already drops
        // every frame before it reaches one, and `closeAll` empties the roster
        // the Sexton needs to hear anyone again when he comes back.
        this.playback.handleBargeIn("vc-leave", { force: true });
        this.setParked(true, `vc-leave:${message.nickname}`);
        this.music?.stop("vc-leave");
        this.reply(message, "Sitting out. Say !vc join when you want me back.");
        return;
      }
      case "vc-dismiss": {
        const bot = command.bot ?? selfBotId();
        void summonerAction(this.params.config.tools?.summoner, "dismiss", bot, message.nickname).then(
          (result) =>
            this.reply(
              message,
              result.ok
                ? command.bot
                  ? `Sending ${String(result.bot)} home.`
                  : "Alright, I'm off. Later."
                : String(result.error),
            ),
        );
        return;
      }
      case "vc-mute": {
        this.muted = command.muted;
        this.bridge.setMuted(command.muted);
        if (command.muted) {
          this.playback.handleBargeIn("vc-mute", { force: true });
          // The bridge stops sending our mixed stream while muted; leaving
          // ffmpeg running would burn CPU on audio nobody can hear.
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
  private handleChatMessage(message: TextMessageHeader): void {
    const run = this.params.onChatMessage;
    if (!run) {
      return;
    }
    if (this.selfClientId !== undefined && message.clientId === this.selfClientId) {
      return;
    }
    // Sitting out is sitting out on both lanes. `!vc join` is a command and was
    // already dispatched before this, so there is still a way back in.
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
        `teamspeak text: dropping message, a turn is already running clientId=${message.clientId}`,
      );
      return;
    }
    this.chatTurnsInFlight.add(message.clientId);
    void run(message)
      .then((reply) => {
        if (reply) {
          this.reply(message, reply);
        }
      })
      .catch((error: unknown) => {
        this.params.log?.(
          `teamspeak text: turn failed clientId=${message.clientId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.chatTurnsInFlight.delete(message.clientId);
      });
  }

  /** Does this line name us? Same wake names the voice lane gates on. */
  private isAddressed(text: string): boolean {
    const haystack = text.toLowerCase();
    const names = resolveTeamSpeakWakeConfig(this.params.config).wakeNames ?? [];
    const candidates = names.length > 0 ? names : ["sexton"];
    return candidates.some((name) => {
      const needle = name.trim().toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    });
  }

  private reply(message: TextMessageHeader, text: string): void {
    // Answer where the command was issued: a PM stays a PM, channel text stays
    // in the channel, so a status request never leaks into the room.
    if (message.target === "client" || message.target === "poke") {
      this.bridge.sendText(message.clientId, text);
      return;
    }
    this.bridge.sendText(message.target === "server" ? "server" : "channel", text);
  }
}

/** One-line music state for `!sexton status`. */
function describeMusic(music: MusicController): string {
  const volume = `${Math.round(music.volume * 100)}%`;
  const track = music.nowPlaying;
  return track ? `playing "${track.title}" at ${volume}` : `idle (volume ${volume})`;
}
