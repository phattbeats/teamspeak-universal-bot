/**
 * A mock plnt-ts-bridge: replays recorded frames into the plugin and records
 * everything the plugin sends back.
 *
 * The real bridge needs a TeamSpeak server, an identity in the Sexton server
 * group, and a second client in the channel. This stands in for all of it by
 * speaking the same binary protocol (ts-bridge/PROTOCOL.md) over an in-memory
 * socket, so speaker-session lifecycle, wake gating, and barge-in are testable
 * without a server.
 */
import {
  decodeFrame,
  encodeFrame,
  TYPE_ROSTER,
  TYPE_SPEAKER_AUDIO,
  TYPE_SPEAKER_START,
  TYPE_SPEAKER_STOP,
  TYPE_STATE,
  TYPE_TEXT_MESSAGE,
  type BridgeStateHeader,
  type BridgeTextTarget,
  type RosterEntry,
  type TeamSpeakClientId,
} from "../src/bridge/protocol.js";
import type { BridgeSocket, BridgeSocketFactory, BridgeSocketHandlers } from "../src/bridge/client.js";

/** One recorded frame from the bridge, in the order it was observed. */
export type RecordedFrame =
  | { type: "state"; state: BridgeStateHeader }
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "speaker_start"; clientId: TeamSpeakClientId }
  | { type: "speaker_stop"; clientId: TeamSpeakClientId }
  | {
      type: "speaker_audio";
      clientId: TeamSpeakClientId;
      nickname: string;
      seq: number;
      pcm48kMono: Buffer;
    }
  | {
      type: "text_message";
      clientId: TeamSpeakClientId;
      nickname: string;
      text: string;
      target?: BridgeTextTarget;
    };

/** A frame the plugin sent to the bridge, decoded for assertions. */
export type SentFrame = {
  msgType: number;
  header: unknown;
  payload: Buffer;
};

export class MockBridge {
  readonly sent: SentFrame[] = [];
  private handlers: BridgeSocketHandlers | undefined;
  private open = false;
  connectCount = 0;

  /** Socket factory to hand to TeamSpeakVoiceRuntime / TeamSpeakBridgeClient. */
  readonly createSocket: BridgeSocketFactory = (_url, handlers): BridgeSocket => {
    this.handlers = handlers;
    this.connectCount += 1;
    return {
      send: (data: Buffer) => {
        if (this.open) {
          this.sent.push(decodeFrame(data));
        }
      },
      close: () => {
        if (this.open) {
          this.open = false;
          handlers.onClose("closed-by-client");
        }
      },
    };
  };

  /** Complete the WebSocket upgrade. */
  accept(): void {
    this.open = true;
    this.handlers?.onOpen();
  }

  /** Drop the connection the way a bridge restart would. */
  drop(reason = "bridge-restart"): void {
    this.open = false;
    this.handlers?.onClose(reason);
  }

  /** Deliver raw bytes, including deliberately malformed frames. */
  deliverRaw(bytes: Buffer): void {
    this.handlers?.onFrame(bytes);
  }

  /** Replay a recorded frame script in order. */
  replay(frames: RecordedFrame[]): void {
    for (const frame of frames) {
      this.deliver(frame);
    }
  }

  deliver(frame: RecordedFrame): void {
    this.handlers?.onFrame(encodeRecordedFrame(frame));
  }

  sentOfType(msgType: number): SentFrame[] {
    return this.sent.filter((frame) => frame.msgType === msgType);
  }

  clearSent(): void {
    this.sent.length = 0;
  }
}

export function encodeRecordedFrame(frame: RecordedFrame): Buffer {
  switch (frame.type) {
    case "state":
      return encodeFrame(TYPE_STATE, frame.state);
    case "roster":
      return encodeFrame(TYPE_ROSTER, frame.roster);
    case "speaker_start":
      return encodeFrame(TYPE_SPEAKER_START, { clientId: frame.clientId });
    case "speaker_stop":
      return encodeFrame(TYPE_SPEAKER_STOP, { clientId: frame.clientId });
    case "speaker_audio":
      return encodeFrame(
        TYPE_SPEAKER_AUDIO,
        { clientId: frame.clientId, nickname: frame.nickname, seq: frame.seq },
        frame.pcm48kMono,
      );
    case "text_message":
      return encodeFrame(TYPE_TEXT_MESSAGE, {
        clientId: frame.clientId,
        nickname: frame.nickname,
        text: frame.text,
        target: frame.target ?? "channel",
      });
  }
}

/** A 20 ms 48 kHz mono PCM16 tone frame, the bridge's native speaker unit. */
export function toneFrame48k(frequencyHz = 440, samples = 960, amplitude = 8_000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / 48_000));
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

export function rosterEntry(
  clientId: TeamSpeakClientId,
  nickname: string,
  overrides: Partial<RosterEntry> = {},
): RosterEntry {
  return { clientId, nickname, muted: false, away: false, ...overrides };
}

export { decodeFrame };
