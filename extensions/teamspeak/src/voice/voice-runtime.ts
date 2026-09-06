/**
 * Wires the bridge socket to the speaker sessions, the room queue, and chat
 * commands. This is the TeamSpeak analogue of Discord's voice-runtime.ts: it
 * owns no provider logic, only routing.
 */
import { TeamSpeakBridgeClient, type BridgeSocketFactory } from "../bridge/client.js";
import type {
  BridgeStateHeader,
  RosterEntry,
  TeamSpeakClientId,
  TextMessageHeader,
} from "../bridge/protocol.js";
import {
  areTeamSpeakToolsEnabled,
  DEFAULT_COMMAND_PREFIX,
  isTeamSpeakMusicEnabled,
  resolveSextonLogDir,
  resolveTeamSpeakVoiceMode,
  type TeamSpeakAccountConfig,
} from "../config.js";
import type { ReadChannelLog } from "../tools/catch-up.js";
import { MusicPlayer, type MusicController, type MusicSink } from "../tools/music.js";
import { createTeamSpeakToolRegistration } from "../tools/registry.js";
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
  minBargeInAudioEndMs?: number | undefined;
  /**
   * Roster changes are delivered into the agent session as silent events: they
   * give the agent room awareness ("who is here") without producing speech.
   */
  deliverSilentEvent?: ((text: string) => void) | undefined;
  providerId?: (() => string | undefined) | undefined;
  log?: ((message: string) => void) | undefined;
};

const DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;

export class TeamSpeakVoiceRuntime {
  private readonly bridge: TeamSpeakBridgeClient;
  private readonly playback: RoomPlaybackQueue;
  private readonly sessions: SpeakerSessionManager;
  private readonly music: MusicController | undefined;
  private readonly tools: TeamSpeakRealtimeToolRegistration | undefined;
  private state: BridgeStateHeader = { connected: false, channelId: 0, channelName: "" };
  private muted = false;
  private selfClientId: TeamSpeakClientId | undefined;

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
          const channel = this.params.config.channel;
          if (channel) {
            this.bridge.join(channel);
          }
        },
        onDisconnected: (reason) => {
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
        },
        onRoster: (roster) => this.sessions.applyRoster(roster),
        onSpeakerStart: (clientId) => this.handleSpeakerStart(clientId),
        onSpeakerAudio: (header, pcm) => {
          const session = this.sessions.get(header.clientId) as VoiceSpeakerSession | undefined;
          session?.sendInputAudio(pcm);
        },
        onTextMessage: (message) => this.handleTextMessage(message),
        onError: (error) => this.params.log?.(`teamspeak bridge: ${error.message}`),
      },
    });
    this.music = this.createMusicController();
    this.tools = areTeamSpeakToolsEnabled(params.config)
      ? createTeamSpeakToolRegistration({
          config: params.config.tools,
          music: this.music,
          roster: () => this.sessions.rosterEntries(),
          channelName: () => this.state.channelName,
          poke: (clientId, text) => this.bridge.poke(clientId, text),
          logDir: params.toolOverrides?.logDir ?? resolveSextonLogDir(params.config),
          ...(params.toolOverrides?.readLog ? { readLog: params.toolOverrides.readLog } : {}),
          ...(params.toolOverrides?.now ? { now: params.toolOverrides.now } : {}),
          ...(params.log ? { log: params.log } : {}),
        })
      : undefined;
  }

  /** The tools the speaker sessions register on their provider session. */
  get toolRegistration(): TeamSpeakRealtimeToolRegistration | undefined {
    return this.tools;
  }

  get musicController(): MusicController | undefined {
    return this.music;
  }

  start(): void {
    this.bridge.connect();
  }

  stop(): void {
    this.music?.close();
    this.sessions.close("runtime-stop");
    this.playback.close();
    this.bridge.close();
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
      wakeNames: this.params.config.voice?.realtime?.wakeNames ?? [],
      bargeInEnabled: session?.bargeInEnabled ?? false,
      muted: this.muted,
      playbackActive: this.playback.isActive(),
      ...(this.music ? { music: describeMusic(this.music) } : {}),
    };
  }

  /**
   * A human started talking. Only the session that currently owns the room lane
   * can be interrupted, so this asks that session rather than broadcasting.
   */
  private handleSpeakerStart(clientId: TeamSpeakClientId): void {
    const owner = this.playback.activeOwner;
    if (!owner) {
      return;
    }
    for (const key of this.sessions.sessionKeys()) {
      const session = this.sessions.get(key) as VoiceSpeakerSession | undefined;
      if (session && session.handleSpeakerStart(`speaker-start:${clientId}`)) {
        return;
      }
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
        this.bridge.join(channel);
        this.reply(message, `Joining ${channel}.`);
        return;
      }
      case "vc-leave": {
        this.sessions.closeAll("vc-leave");
        this.playback.handleBargeIn("vc-leave", { force: true });
        this.music?.stop("vc-leave");
        this.reply(message, "Leaving voice.");
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
