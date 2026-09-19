import { describe, expect, it } from "vitest";
import {
  BridgeFrameError,
  decodeFrame,
  encodeFrame,
  readRoster,
  readSpeakerAudioHeader,
  readStateHeader,
  readTextMessageHeader,
  TYPE_CLEAR_VOICE,
  TYPE_SPEAKER_AUDIO,
  TYPE_VOICE_AUDIO,
} from "../src/bridge/protocol.js";
import { toneFrame48k } from "./mock-bridge.js";

describe("bridge frame codec", () => {
  it("round-trips a speaker_audio frame with its PCM payload", () => {
    const pcm = toneFrame48k();
    const bytes = encodeFrame(
      TYPE_SPEAKER_AUDIO,
      { clientId: 42, nickname: "brandon", seq: 7 },
      pcm,
    );

    const decoded = decodeFrame(bytes);
    expect(decoded.msgType).toBe(TYPE_SPEAKER_AUDIO);
    expect(readSpeakerAudioHeader(decoded.header)).toEqual({
      clientId: 42,
      nickname: "brandon",
      seq: 7,
    });
    expect(decoded.payload.equals(pcm)).toBe(true);
  });

  it("accepts an empty payload and a zero-length header", () => {
    const decoded = decodeFrame(encodeFrame(TYPE_CLEAR_VOICE, {}));
    expect(decoded.msgType).toBe(TYPE_CLEAR_VOICE);
    expect(decoded.payload.length).toBe(0);

    // A header length of 0 means "no header", not "invalid JSON".
    const raw = Buffer.alloc(5);
    raw.writeUInt8(TYPE_CLEAR_VOICE, 0);
    raw.writeUInt32LE(0, 1);
    expect(decodeFrame(raw).header).toEqual({});
  });

  it("rejects truncated and overrunning frames instead of reading out of bounds", () => {
    expect(() => decodeFrame(Buffer.from([0x01, 0x00]))).toThrow(BridgeFrameError);

    const overrun = Buffer.alloc(7);
    overrun.writeUInt8(TYPE_VOICE_AUDIO, 0);
    overrun.writeUInt32LE(9_000, 1);
    overrun.write("{}", 5);
    expect(() => decodeFrame(overrun)).toThrow(/exceeds remaining frame bytes/u);
  });

  it("rejects a header that is not JSON", () => {
    const raw = Buffer.concat([
      Buffer.from([TYPE_SPEAKER_AUDIO, 0x03, 0x00, 0x00, 0x00]),
      Buffer.from("not"),
    ]);
    expect(() => decodeFrame(raw)).toThrow(/not valid JSON/u);
  });

  it("drops roster entries without a usable clientId rather than failing the frame", () => {
    const roster = readRoster([
      { clientId: 1, nickname: "brandon", muted: false, away: false },
      { nickname: "ghost" },
      { clientId: 2, nickname: "sexton", muted: true, away: true },
    ]);
    expect(roster?.map((entry) => entry.clientId)).toEqual([1, 2]);
    expect(roster?.[1]).toEqual({ clientId: 2, nickname: "sexton", muted: true, away: true });
  });

  it("defaults an unrecognized text target to the channel", () => {
    const message = readTextMessageHeader({
      clientId: 5,
      nickname: "brandon",
      text: "!sexton status",
      target: "somewhere-new",
    });
    expect(message?.target).toBe("channel");
  });

  it("returns undefined for headers of the wrong shape", () => {
    expect(readSpeakerAudioHeader({ nickname: "brandon" })).toBeUndefined();
    expect(readStateHeader({ channelId: 1 })).toBeUndefined();
    expect(readRoster({ clientId: 1 })).toBeUndefined();
  });
});
