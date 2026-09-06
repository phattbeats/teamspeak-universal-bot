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
  DEFAULT_COMMAND_PREFIX,
  resolveTeamSpeakVoiceMode,
  type TeamSpeakAccountConfig,
} from "../config.js";
import {
  formatStatusReply,
  parseTeamSpeakCommand,
  type StatusSnapshot,
  type TeamSpeakCommand,
} from "./commands.js";
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

export type TeamSpeakVoiceRuntimeParams = {
  accountId: string;
  config: TeamSpeakAccountConfig;
  createSocket: BridgeSocketFactory;
  createSpeakerSession: (client: RosterEntry, playback: RoomPlaybackQueue) => VoiceSpeakerSession;
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
      createSession: (client) => this.params.createSpeakerSession(client, this.playback),
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
  }

  start(): void {
    this.bridge.connect();
  }

  stop(): void {
    this.sessions.close("runtime-stop");
    this.playback.close();
    this.bridge.close();
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
        this.reply(message, "Leaving voice.");
        return;
      }
      case "vc-mute": {
        this.muted = command.muted;
        this.bridge.setMuted(command.muted);
        if (command.muted) {
          this.playback.handleBargeIn("vc-mute", { force: true });
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
