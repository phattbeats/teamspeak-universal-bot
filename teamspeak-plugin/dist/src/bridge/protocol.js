const TYPE_SPEAKER_AUDIO = 1;
const TYPE_SPEAKER_START = 2;
const TYPE_SPEAKER_STOP = 3;
const TYPE_ROSTER = 4;
const TYPE_TEXT_MESSAGE = 5;
const TYPE_STATE = 6;
const TYPE_MODERATION_RESULT = 7;
const TYPE_CHANNEL_TREE = 8;
const TYPE_VOICE_AUDIO = 129;
const TYPE_MUSIC_AUDIO = 130;
const TYPE_MUSIC_GAIN = 131;
const TYPE_CLEAR_VOICE = 132;
const TYPE_SAY_TEXT = 133;
const TYPE_JOIN = 134;
const TYPE_MUTE = 135;
const TYPE_POKE = 136;
const TYPE_SEND_TEXT = 137;
const TYPE_CLIENT_KICK = 138;
const TYPE_BAN_CLIENT = 139;
const TYPE_BAN_DEL = 140;
const TYPE_BAN_LIST = 141;
const TYPE_CLIENT_MOVE = 142;
const TYPE_CLIENT_EDIT_MUTE = 143;
const TYPE_CHANNEL_EDIT = 144;
const TYPE_CHANNEL_CREATE = 145;
const TYPE_CHANNEL_DELETE = 146;
const TYPE_SERVER_EDIT = 147;
const TYPE_SERVER_GROUP_ADD_CLIENT = 148;
const TYPE_LIST_CHANNELS = 149;
const TYPE_SET_DESCRIPTION = 150;
const FRAME_PREFIX_BYTES = 5;
class BridgeFrameError extends Error {
}
function encodeFrame(msgType, header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header ?? {}), "utf8");
  const body = payload ?? Buffer.alloc(0);
  const out = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + headerBytes.length + body.length);
  out.writeUInt8(msgType, 0);
  out.writeUInt32LE(headerBytes.length, 1);
  headerBytes.copy(out, FRAME_PREFIX_BYTES);
  body.copy(out, FRAME_PREFIX_BYTES + headerBytes.length);
  return out;
}
function decodeFrame(bytes) {
  if (bytes.length < FRAME_PREFIX_BYTES) {
    throw new BridgeFrameError("frame shorter than the 5-byte prefix");
  }
  const msgType = bytes.readUInt8(0);
  const headerLen = bytes.readUInt32LE(1);
  const headerEnd = FRAME_PREFIX_BYTES + headerLen;
  if (headerEnd > bytes.length) {
    throw new BridgeFrameError(`header length ${headerLen} exceeds remaining frame bytes`);
  }
  const headerBytes = bytes.subarray(FRAME_PREFIX_BYTES, headerEnd);
  let header = {};
  if (headerBytes.length > 0) {
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch (error) {
      throw new BridgeFrameError(
        `header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { msgType, header, payload: Buffer.from(bytes.subarray(headerEnd)) };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readClientId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}
function readSpeakerAudioHeader(header) {
  if (!isRecord(header)) {
    return void 0;
  }
  const clientId = readClientId(header.clientId);
  if (clientId === void 0) {
    return void 0;
  }
  return {
    clientId,
    nickname: typeof header.nickname === "string" ? header.nickname : String(clientId),
    seq: typeof header.seq === "number" ? header.seq : 0
  };
}
function readClientIdHeader(header) {
  if (!isRecord(header)) {
    return void 0;
  }
  const clientId = readClientId(header.clientId);
  return clientId === void 0 ? void 0 : { clientId };
}
function readRoster(header) {
  if (!Array.isArray(header)) {
    return void 0;
  }
  const roster = [];
  for (const raw of header) {
    if (!isRecord(raw)) {
      continue;
    }
    const clientId = readClientId(raw.clientId);
    if (clientId === void 0) {
      continue;
    }
    roster.push({
      clientId,
      nickname: typeof raw.nickname === "string" ? raw.nickname : String(clientId),
      muted: raw.muted === true,
      away: raw.away === true,
      serverGroups: Array.isArray(raw.serverGroups) ? raw.serverGroups.filter((g) => typeof g === "string") : []
    });
  }
  return roster;
}
function readModerationResult(header) {
  if (!isRecord(header) || typeof header.action !== "string" || typeof header.ok !== "boolean") {
    return void 0;
  }
  return {
    action: header.action,
    ok: header.ok,
    detail: typeof header.detail === "string" ? header.detail : ""
  };
}
function readOneChannel(raw) {
  if (!isRecord(raw) || typeof raw.name !== "string") {
    return void 0;
  }
  const channelId = typeof raw.channelId === "number" ? raw.channelId : void 0;
  if (channelId === void 0) {
    return void 0;
  }
  return {
    channelId,
    name: raw.name,
    occupants: readRoster(raw.occupants) ?? []
  };
}
function readChannelTree(header) {
  if (!Array.isArray(header)) {
    return void 0;
  }
  const channels = [];
  for (const raw of header) {
    const channel = readOneChannel(raw);
    if (channel) {
      channels.push(channel);
    }
  }
  return channels;
}
const TEXT_TARGETS = /* @__PURE__ */ new Set(["channel", "server", "client", "poke"]);
function readTextMessageHeader(header) {
  if (!isRecord(header)) {
    return void 0;
  }
  const clientId = readClientId(header.clientId);
  if (clientId === void 0 || typeof header.text !== "string") {
    return void 0;
  }
  const target = typeof header.target === "string" && TEXT_TARGETS.has(header.target) ? header.target : "channel";
  return {
    clientId,
    nickname: typeof header.nickname === "string" ? header.nickname : String(clientId),
    text: header.text,
    target
  };
}
function readStateHeader(header) {
  if (!isRecord(header) || typeof header.connected !== "boolean") {
    return void 0;
  }
  const ownClientId = readClientId(header.ownClientId);
  return {
    connected: header.connected,
    channelId: typeof header.channelId === "number" ? header.channelId : 0,
    channelName: typeof header.channelName === "string" ? header.channelName : "",
    ...ownClientId === void 0 ? {} : { ownClientId }
  };
}
export {
  BridgeFrameError,
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
  TYPE_LIST_CHANNELS,
  TYPE_MODERATION_RESULT,
  TYPE_MUSIC_AUDIO,
  TYPE_MUSIC_GAIN,
  TYPE_MUTE,
  TYPE_POKE,
  TYPE_ROSTER,
  TYPE_SAY_TEXT,
  TYPE_SEND_TEXT,
  TYPE_SERVER_EDIT,
  TYPE_SERVER_GROUP_ADD_CLIENT,
  TYPE_SET_DESCRIPTION,
  TYPE_SPEAKER_AUDIO,
  TYPE_SPEAKER_START,
  TYPE_SPEAKER_STOP,
  TYPE_STATE,
  TYPE_TEXT_MESSAGE,
  TYPE_VOICE_AUDIO,
  decodeFrame,
  encodeFrame,
  readChannelTree,
  readClientIdHeader,
  readModerationResult,
  readRoster,
  readSpeakerAudioHeader,
  readStateHeader,
  readTextMessageHeader
};
