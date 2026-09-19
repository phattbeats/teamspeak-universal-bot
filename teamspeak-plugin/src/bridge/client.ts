/**
 * Bridge transport: one WebSocket to plnt-ts-bridge, decoded into typed events.
 *
 * The bridge is a sibling container that owns the TeamSpeak connection. It can
 * restart independently of the gateway, so this client reconnects with backoff
 * and treats every inbound frame as untrusted input.
 */
import {
  BridgeFrameError,
  decodeFrame,
  encodeFrame,
  readClientIdHeader,
  readRoster,
  readSpeakerAudioHeader,
  readStateHeader,
  readTextMessageHeader,
  TYPE_CLEAR_VOICE,
  TYPE_JOIN,
  TYPE_MUSIC_AUDIO,
  TYPE_MUSIC_GAIN,
  TYPE_MUTE,
  TYPE_POKE,
  TYPE_ROSTER,
  TYPE_SAY_TEXT,
  TYPE_SEND_TEXT,
  TYPE_SPEAKER_AUDIO,
  TYPE_SPEAKER_START,
  TYPE_SPEAKER_STOP,
  TYPE_STATE,
  TYPE_TEXT_MESSAGE,
  TYPE_VOICE_AUDIO,
  type BridgeStateHeader,
  type RosterEntry,
  type SpeakerAudioHeader,
  type TeamSpeakClientId,
  type TextMessageHeader,
} from "./protocol.js";

/** Minimal socket seam so tests can drive a mock bridge without a network. */
export type BridgeSocket = {
  send(data: Buffer): void;
  close(): void;
};

export type BridgeSocketHandlers = {
  onOpen: () => void;
  onFrame: (data: Buffer) => void;
  onClose: (reason: string) => void;
  onError: (error: Error) => void;
};

export type BridgeSocketFactory = (url: string, handlers: BridgeSocketHandlers) => BridgeSocket;

export type BridgeClientEvents = {
  onSpeakerAudio?: (header: SpeakerAudioHeader, pcm48kMono: Buffer) => void;
  onSpeakerStart?: (clientId: TeamSpeakClientId) => void;
  onSpeakerStop?: (clientId: TeamSpeakClientId) => void;
  onRoster?: (roster: RosterEntry[]) => void;
  onTextMessage?: (message: TextMessageHeader) => void;
  onState?: (state: BridgeStateHeader) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onError?: (error: Error) => void;
};

export type BridgeClientParams = {
  url: string;
  events: BridgeClientEvents;
  createSocket: BridgeSocketFactory;
  /** Reconnect backoff bounds. Set `reconnect: false` to make a close terminal. */
  reconnect?: boolean | undefined;
  initialBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  setTimeoutFn?: ((handler: () => void, ms: number) => unknown) | undefined;
  clearTimeoutFn?: ((handle: unknown) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class TeamSpeakBridgeClient {
  private socket: BridgeSocket | undefined;
  private closed = false;
  private connected = false;
  private backoffMs: number;
  private reconnectHandle: unknown;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly params: BridgeClientParams) {
    this.backoffMs = params.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.setTimeoutFn = params.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = params.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.closed || this.socket) {
      return;
    }
    this.socket = this.params.createSocket(this.params.url, {
      onOpen: () => {
        this.connected = true;
        this.backoffMs = this.params.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
        this.params.events.onConnected?.();
      },
      onFrame: (data) => this.handleFrame(data),
      onClose: (reason) => this.handleClose(reason),
      onError: (error) => this.params.events.onError?.(error),
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectHandle !== undefined) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    socket?.close();
  }

  // --- outbound -----------------------------------------------------------

  /** The mixed realtime provider output, resampled to the bridge's 48 kHz lane. */
  sendVoiceAudio(pcm48kMono: Buffer): void {
    this.send(encodeFrame(TYPE_VOICE_AUDIO, {}, pcm48kMono));
  }

  sendMusicAudio(pcm48kMono: Buffer): void {
    this.send(encodeFrame(TYPE_MUSIC_AUDIO, {}, pcm48kMono));
  }

  setMusicGain(gain: number): void {
    this.send(encodeFrame(TYPE_MUSIC_GAIN, { gain }));
  }

  /** Barge-in: drop voice samples the bridge has already queued for playback. */
  clearVoice(): void {
    this.send(encodeFrame(TYPE_CLEAR_VOICE, {}));
  }

  sayText(text: string): void {
    this.send(encodeFrame(TYPE_SAY_TEXT, { text }));
  }

  join(channel: string): void {
    this.send(encodeFrame(TYPE_JOIN, { channel }));
  }

  setMuted(muted: boolean): void {
    this.send(encodeFrame(TYPE_MUTE, { muted }));
  }

  poke(clientId: TeamSpeakClientId, text: string): void {
    this.send(encodeFrame(TYPE_POKE, { clientId, text }));
  }

  sendText(target: "channel" | "server" | TeamSpeakClientId, text: string): void {
    this.send(encodeFrame(TYPE_SEND_TEXT, { target, text }));
  }

  private send(frame: Buffer): void {
    if (!this.socket || !this.connected) {
      return;
    }
    try {
      this.socket.send(frame);
    } catch (error) {
      this.params.events.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- inbound ------------------------------------------------------------

  private handleFrame(data: Buffer): void {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      // A malformed frame is the bridge's problem, not a reason to tear down
      // the session. Report it and keep the socket.
      this.params.events.onError?.(
        error instanceof BridgeFrameError ? error : new Error(String(error)),
      );
      return;
    }
    const events = this.params.events;
    switch (frame.msgType) {
      case TYPE_SPEAKER_AUDIO: {
        const header = readSpeakerAudioHeader(frame.header);
        if (header) {
          events.onSpeakerAudio?.(header, frame.payload);
        }
        return;
      }
      case TYPE_SPEAKER_START: {
        const header = readClientIdHeader(frame.header);
        if (header) {
          events.onSpeakerStart?.(header.clientId);
        }
        return;
      }
      case TYPE_SPEAKER_STOP: {
        const header = readClientIdHeader(frame.header);
        if (header) {
          events.onSpeakerStop?.(header.clientId);
        }
        return;
      }
      case TYPE_ROSTER: {
        const roster = readRoster(frame.header);
        if (roster) {
          events.onRoster?.(roster);
        }
        return;
      }
      case TYPE_TEXT_MESSAGE: {
        const message = readTextMessageHeader(frame.header);
        if (message) {
          events.onTextMessage?.(message);
        }
        return;
      }
      case TYPE_STATE: {
        const state = readStateHeader(frame.header);
        if (state) {
          events.onState?.(state);
        }
        return;
      }
      default:
        // Unknown inbound types are logged and ignored, per PROTOCOL.md.
        this.params.log?.(`teamspeak bridge: ignoring unknown frame type 0x${frame.msgType.toString(16)}`);
    }
  }

  private handleClose(reason: string): void {
    this.socket = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) {
      this.params.events.onDisconnected?.(reason);
    }
    if (this.closed || this.params.reconnect === false) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.params.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.params.log?.(`teamspeak bridge: disconnected (${reason}); reconnecting in ${delay}ms`);
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = undefined;
      this.connect();
    }, delay);
  }
}
