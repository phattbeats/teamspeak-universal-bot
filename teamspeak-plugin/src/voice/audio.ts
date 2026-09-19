/**
 * Sample-rate conversion between the bridge lane and the realtime provider.
 *
 * The bridge speaks mono 48 kHz PCM16 in both directions (ts-bridge/PROTOCOL.md);
 * realtime providers here use PCM16 at 24 kHz. Discord needs an extra
 * stereo<->mono fold because @discordjs/voice is stereo; TeamSpeak audio is
 * already mono, so this is a pure rate conversion.
 */
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";

export const BRIDGE_SAMPLE_RATE = 48_000;
export const REALTIME_SAMPLE_RATE = 24_000;
/** whisper.cpp is fixed at 16 kHz; anything else is resampled inside the model. */
export const STT_SAMPLE_RATE = 16_000;

/** 20 ms at 48 kHz mono PCM16 — the bridge's native frame. */
export const BRIDGE_FRAME_SAMPLES = 960;
export const BRIDGE_FRAME_BYTES = BRIDGE_FRAME_SAMPLES * 2;

/** Speaker audio from the bridge -> realtime provider input. */
export function convertBridgePcm48kMonoToRealtimePcm24k(pcm48kMono: Buffer): Buffer {
  if (pcm48kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm48kMono, BRIDGE_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
}

/** Realtime provider output -> the bridge's `voice_audio` lane. */
export function convertRealtimePcm24kToBridgePcm48kMono(pcm24kMono: Buffer): Buffer {
  if (pcm24kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm24kMono, REALTIME_SAMPLE_RATE, BRIDGE_SAMPLE_RATE);
}

/** Speaker audio from the bridge -> local whisper input (PHA-3228). */
export function convertBridgePcm48kMonoToSttPcm16k(pcm48kMono: Buffer): Buffer {
  if (pcm48kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm48kMono, BRIDGE_SAMPLE_RATE, STT_SAMPLE_RATE);
}

/** Playback duration of a 48 kHz mono PCM16 buffer, in milliseconds. */
export function bridgePcmDurationMs(pcm48kMono: Buffer): number {
  return Math.floor(pcm48kMono.length / 2) / (BRIDGE_SAMPLE_RATE / 1_000);
}

/**
 * Split a PCM16 buffer into the bridge's 20 ms frames.
 *
 * The bridge tolerates short writes, but the room queue measures barge-in
 * eligibility in written milliseconds (`RoomPlaybackQueue.activeWrittenMs`), so
 * handing it one multi-second buffer would make the echo guard useless: the
 * whole utterance would count as written the instant it was enqueued. A short
 * tail frame is emitted rather than padded — silence padding would be audible
 * between an answer and the next speaker.
 */
export function chunkBridgePcm(pcm48kMono: Buffer, frameBytes = BRIDGE_FRAME_BYTES): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < pcm48kMono.length; offset += frameBytes) {
    frames.push(pcm48kMono.subarray(offset, Math.min(offset + frameBytes, pcm48kMono.length)));
  }
  return frames;
}

const WAV_HEADER_BYTES = 44;

/**
 * Wrap raw PCM16 mono in a RIFF/WAVE header.
 *
 * whisper.cpp's HTTP server takes a container, not raw samples, and refuses a
 * body it cannot sniff. This is the smallest canonical header rather than a
 * dependency: 44 bytes of prefix is not worth an npm package in a plugin that
 * otherwise ships one.
 */
export function encodeWavPcm16Mono(pcm: Buffer, sampleRate = STT_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
