import {
  BridgeFrameError,
  decodeFrame,
  encodeFrame,
  readChannelTree,
  readClientIdHeader,
  readModerationResult,
  readRoster,
  readSpeakerAudioHeader,
  readStateHeader,
  readTextMessageHeader,
  TYPE_BAN_CLIENT,
  TYPE_BAN_DEL,
  TYPE_BAN_LIST,
  TYPE_CHANNEL_CREATE,
  TYPE_CHANNEL_DELETE,
  TYPE_CHANNEL_EDIT,
  TYPE_CHANNEL_TREE,
  TYPE_CLEAR_VOICE,
  TYPE_CLIENT_EDIT_MUTE,
  TYPE_CLIENT_KICK,
  TYPE_CLIENT_MOVE,
  TYPE_JOIN,
  TYPE_MODERATION_RESULT,
  TYPE_LIST_CHANNELS,
  TYPE_SET_DESCRIPTION,
  TYPE_MUSIC_AUDIO,
  TYPE_MUSIC_GAIN,
  TYPE_MUTE,
  TYPE_POKE,
  TYPE_ROSTER,
  TYPE_SAY_TEXT,
  TYPE_SEND_TEXT,
  TYPE_SERVER_EDIT,
  TYPE_SERVER_GROUP_ADD_CLIENT,
  TYPE_SPEAKER_AUDIO,
  TYPE_SPEAKER_START,
  TYPE_SPEAKER_STOP,
  TYPE_STATE,
  TYPE_TEXT_MESSAGE,
  TYPE_VOICE_AUDIO
} from "./protocol.js";
const DEFAULT_INITIAL_BACKOFF_MS = 1e3;
const DEFAULT_MAX_BACKOFF_MS = 3e4;
class TeamSpeakBridgeClient {
  constructor(params) {
    this.params = params;
    this.backoffMs = params.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.setTimeoutFn = params.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = params.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }
  params;
  socket;
  closed = false;
  connected = false;
  backoffMs;
  reconnectHandle;
  setTimeoutFn;
  clearTimeoutFn;
  get isConnected() {
    return this.connected;
  }
  connect() {
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
      onError: (error) => this.params.events.onError?.(error)
    });
  }
  close() {
    this.closed = true;
    if (this.reconnectHandle !== void 0) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = void 0;
    }
    const socket = this.socket;
    this.socket = void 0;
    this.connected = false;
    socket?.close();
  }
  // --- outbound -----------------------------------------------------------
  /** The mixed realtime provider output, resampled to the bridge's 48 kHz lane. */
  sendVoiceAudio(pcm48kMono) {
    this.send(encodeFrame(TYPE_VOICE_AUDIO, {}, pcm48kMono));
  }
  sendMusicAudio(pcm48kMono) {
    this.send(encodeFrame(TYPE_MUSIC_AUDIO, {}, pcm48kMono));
  }
  setMusicGain(gain) {
    this.send(encodeFrame(TYPE_MUSIC_GAIN, { gain }));
  }
  /** Barge-in: drop voice samples the bridge has already queued for playback. */
  clearVoice() {
    this.send(encodeFrame(TYPE_CLEAR_VOICE, {}));
  }
  sayText(text) {
    this.send(encodeFrame(TYPE_SAY_TEXT, { text }));
  }
  join(channel) {
    this.send(encodeFrame(TYPE_JOIN, { channel }));
  }
  setMuted(muted) {
    this.send(encodeFrame(TYPE_MUTE, { muted }));
  }
  poke(clientId, text) {
    this.send(encodeFrame(TYPE_POKE, { clientId, text }));
  }
  sendText(target, text) {
    this.send(encodeFrame(TYPE_SEND_TEXT, { target, text }));
  }
  // --- moderation (PHA-3786) -----------------------------------------------
  kickClient(clientId, fromServer, reason) {
    this.send(encodeFrame(TYPE_CLIENT_KICK, { clientId, fromServer, reason }));
  }
  banClient(clientId, durationSecs, reason) {
    this.send(encodeFrame(TYPE_BAN_CLIENT, { clientId, durationSecs, reason }));
  }
  banDel(banId) {
    this.send(encodeFrame(TYPE_BAN_DEL, { banId }));
  }
  banList() {
    this.send(encodeFrame(TYPE_BAN_LIST, {}));
  }
  /** Move another client into a channel — distinct from `join`, which moves the bot itself. */
  moveClient(clientId, channelId) {
    this.send(encodeFrame(TYPE_CLIENT_MOVE, { clientId, channelId }));
  }
  /** Mute/unmute another client via talk-power revocation (there is no literal server-side mute). */
  muteClient(clientId, muted) {
    this.send(encodeFrame(TYPE_CLIENT_EDIT_MUTE, { clientId, muted }));
  }
  editChannel(channelId, name, topic) {
    this.send(encodeFrame(TYPE_CHANNEL_EDIT, { channelId, name, topic }));
  }
  createChannel(name, parentId) {
    this.send(encodeFrame(TYPE_CHANNEL_CREATE, { name, parentId }));
  }
  deleteChannel(channelId, force) {
    this.send(encodeFrame(TYPE_CHANNEL_DELETE, { channelId, force }));
  }
  editServer(name, welcomeMessage) {
    this.send(encodeFrame(TYPE_SERVER_EDIT, { name, welcomeMessage }));
  }
  addToServerGroup(serverGroupId, clientId) {
    this.send(encodeFrame(TYPE_SERVER_GROUP_ADD_CLIENT, { serverGroupId, clientId }));
  }
  /**
   * Ask the bridge for the full channel tree. Fire-and-forget: the answer
   * arrives asynchronously on `events.onChannelTree` (PHA-3784) — there is no
   * per-request id, matching every other command on this connection.
   */
  listChannels() {
    this.send(encodeFrame(TYPE_LIST_CHANNELS, {}));
  }
  /**
   * Set the bot's own client description (PHA-3857). The PLNT overlay shows
   * a description starting with `♪` as the bot's now-playing line. No reply.
   */
  setDescription(description) {
    this.send(encodeFrame(TYPE_SET_DESCRIPTION, { description }));
  }
  send(frame) {
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
  handleFrame(data) {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.params.events.onError?.(
        error instanceof BridgeFrameError ? error : new Error(String(error))
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
      case TYPE_MODERATION_RESULT: {
        const result = readModerationResult(frame.header);
        if (result) {
          events.onModerationResult?.(result);
        }
        return;
      }
      case TYPE_CHANNEL_TREE: {
        const channels = readChannelTree(frame.header);
        if (channels) {
          events.onChannelTree?.(channels);
        }
        return;
      }
      default:
        this.params.log?.(`teamspeak bridge: ignoring unknown frame type 0x${frame.msgType.toString(16)}`);
    }
  }
  handleClose(reason) {
    this.socket = void 0;
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
      this.reconnectHandle = void 0;
      this.connect();
    }, delay);
  }
}
export {
  TeamSpeakBridgeClient
};
