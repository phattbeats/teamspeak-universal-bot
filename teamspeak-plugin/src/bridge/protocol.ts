/**
 * Binary framing for the plnt-ts-bridge WebSocket.
 *
 * Wire contract (ts-bridge/PROTOCOL.md): every frame is
 *   byte 0        message type (u8)
 *   bytes 1..5    header length, u32 little-endian (N)
 *   bytes 5..5+N  header, UTF-8 JSON (N bytes, may be `{}`)
 *   bytes 5+N..   payload (raw bytes, may be empty)
 *
 * PCM payloads are mono 48 kHz signed 16-bit little-endian. 960 samples
 * (1920 bytes, 20 ms) is the native unit on both lanes, but the bridge
 * buffers short chunks, so this codec never enforces a frame length.
 *
 * This file is the TeamSpeak side of a contract owned by ts-bridge. Changing a
 * type byte or header key here without changing ts-bridge/src/protocol.rs
 * silently desynchronizes the two processes.
 */

/** Frames the bridge sends to us. */
export const TYPE_SPEAKER_AUDIO = 0x01;
export const TYPE_SPEAKER_START = 0x02;
export const TYPE_SPEAKER_STOP = 0x03;
export const TYPE_ROSTER = 0x04;
export const TYPE_TEXT_MESSAGE = 0x05;
export const TYPE_STATE = 0x06;
/** Answer to any moderation command below (PHA-3786). */
export const TYPE_MODERATION_RESULT = 0x07;

/** Frames we send to the bridge. */
export const TYPE_VOICE_AUDIO = 0x81;
export const TYPE_MUSIC_AUDIO = 0x82;
export const TYPE_MUSIC_GAIN = 0x83;
export const TYPE_CLEAR_VOICE = 0x84;
export const TYPE_SAY_TEXT = 0x85;
export const TYPE_JOIN = 0x86;
export const TYPE_MUTE = 0x87;
export const TYPE_POKE = 0x88;
export const TYPE_SEND_TEXT = 0x89;

/** Moderation commands (PHA-3786). See TOOL-CATALOG.md §4.3. */
export const TYPE_CLIENT_KICK = 0x8a;
export const TYPE_BAN_CLIENT = 0x8b;
export const TYPE_BAN_DEL = 0x8c;
export const TYPE_BAN_LIST = 0x8d;
export const TYPE_CLIENT_MOVE = 0x8e;
export const TYPE_CLIENT_EDIT_MUTE = 0x8f;
export const TYPE_CHANNEL_EDIT = 0x90;
export const TYPE_CHANNEL_CREATE = 0x91;
export const TYPE_CHANNEL_DELETE = 0x92;
export const TYPE_SERVER_EDIT = 0x93;
export const TYPE_SERVER_GROUP_ADD_CLIENT = 0x94;

const FRAME_PREFIX_BYTES = 5;

export type TeamSpeakClientId = number;

export type BridgeRawFrame = {
  msgType: number;
  header: unknown;
  payload: Buffer;
};

export type BridgeTextTarget = "channel" | "server" | "client" | "poke";

export type SpeakerAudioHeader = {
  clientId: TeamSpeakClientId;
  nickname: string;
  seq: number;
};

export type ClientIdHeader = {
  clientId: TeamSpeakClientId;
};

export type RosterEntry = {
  clientId: TeamSpeakClientId;
  nickname: string;
  muted: boolean;
  away: boolean;
  /** Server group names this client belongs to (PHA-3786). Optional so
   * existing literal `RosterEntry` construction (tests, mocks) keeps
   * compiling without every callsite needing an update. */
  serverGroups?: string[];
};

/** Answer to a moderation command (PHA-3786). */
export type ModerationResult = {
  action: string;
  ok: boolean;
  detail: string;
};

export type TextMessageHeader = {
  clientId: TeamSpeakClientId;
  nickname: string;
  text: string;
  target: BridgeTextTarget;
};

export type BridgeStateHeader = {
  connected: boolean;
  channelId: number;
  channelName: string;
  /**
   * The bridge's own clientId in the channel, absent while disconnected.
   *
   * The `roster` frame is the channel's roster, bot included, so without this
   * the Sexton counts itself as a participant: the wake gate would engage with
   * one human present, and a speaker session would open on our own audio.
   * TeamSpeak issues a fresh clientId per session, so it arrives with the state
   * rather than being configured.
   */
  ownClientId?: TeamSpeakClientId;
};

export class BridgeFrameError extends Error {}

/** Encode one frame. `header` is JSON-serialized; `payload` is appended raw. */
export function encodeFrame(msgType: number, header: unknown, payload?: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header ?? {}), "utf8");
  const body = payload ?? Buffer.alloc(0);
  const out = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + headerBytes.length + body.length);
  out.writeUInt8(msgType, 0);
  out.writeUInt32LE(headerBytes.length, 1);
  headerBytes.copy(out, FRAME_PREFIX_BYTES);
  body.copy(out, FRAME_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * Decode one frame. Rejects truncated and overrunning frames rather than
 * reading out of bounds; a malformed frame must not be able to kill the
 * gateway, since the bridge is a separate process that can restart mid-stream.
 */
export function decodeFrame(bytes: Buffer): BridgeRawFrame {
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
  let header: unknown = {};
  if (headerBytes.length > 0) {
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch (error) {
      throw new BridgeFrameError(
        `header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { msgType, header, payload: Buffer.from(bytes.subarray(headerEnd)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClientId(value: unknown): TeamSpeakClientId | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Header readers return `undefined` instead of throwing on shape mismatch.
 * A bridge running a newer protocol should degrade to ignoring frames it did
 * not expect, not disconnect the voice runtime.
 */
export function readSpeakerAudioHeader(header: unknown): SpeakerAudioHeader | undefined {
  if (!isRecord(header)) {
    return undefined;
  }
  const clientId = readClientId(header.clientId);
  if (clientId === undefined) {
    return undefined;
  }
  return {
    clientId,
    nickname: typeof header.nickname === "string" ? header.nickname : String(clientId),
    seq: typeof header.seq === "number" ? header.seq : 0,
  };
}

export function readClientIdHeader(header: unknown): ClientIdHeader | undefined {
  if (!isRecord(header)) {
    return undefined;
  }
  const clientId = readClientId(header.clientId);
  return clientId === undefined ? undefined : { clientId };
}

export function readRoster(header: unknown): RosterEntry[] | undefined {
  if (!Array.isArray(header)) {
    return undefined;
  }
  const roster: RosterEntry[] = [];
  for (const raw of header) {
    if (!isRecord(raw)) {
      continue;
    }
    const clientId = readClientId(raw.clientId);
    if (clientId === undefined) {
      continue;
    }
    roster.push({
      clientId,
      nickname: typeof raw.nickname === "string" ? raw.nickname : String(clientId),
      muted: raw.muted === true,
      away: raw.away === true,
      serverGroups: Array.isArray(raw.serverGroups)
        ? raw.serverGroups.filter((g): g is string => typeof g === "string")
        : [],
    });
  }
  return roster;
}

/** Decode a `TYPE_MODERATION_RESULT` frame header (PHA-3786). */
export function readModerationResult(header: unknown): ModerationResult | undefined {
  if (!isRecord(header) || typeof header.action !== "string" || typeof header.ok !== "boolean") {
    return undefined;
  }
  return {
    action: header.action,
    ok: header.ok,
    detail: typeof header.detail === "string" ? header.detail : "",
  };
}

const TEXT_TARGETS: ReadonlySet<string> = new Set(["channel", "server", "client", "poke"]);

export function readTextMessageHeader(header: unknown): TextMessageHeader | undefined {
  if (!isRecord(header)) {
    return undefined;
  }
  const clientId = readClientId(header.clientId);
  if (clientId === undefined || typeof header.text !== "string") {
    return undefined;
  }
  const target = typeof header.target === "string" && TEXT_TARGETS.has(header.target)
    ? (header.target as BridgeTextTarget)
    : "channel";
  return {
    clientId,
    nickname: typeof header.nickname === "string" ? header.nickname : String(clientId),
    text: header.text,
    target,
  };
}

export function readStateHeader(header: unknown): BridgeStateHeader | undefined {
  if (!isRecord(header) || typeof header.connected !== "boolean") {
    return undefined;
  }
  const ownClientId = readClientId(header.ownClientId);
  return {
    connected: header.connected,
    channelId: typeof header.channelId === "number" ? header.channelId : 0,
    channelName: typeof header.channelName === "string" ? header.channelName : "",
    ...(ownClientId === undefined ? {} : { ownClientId }),
  };
}
