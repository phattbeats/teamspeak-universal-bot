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

/** Playback duration of a 48 kHz mono PCM16 buffer, in milliseconds. */
export function bridgePcmDurationMs(pcm48kMono: Buffer): number {
  return Math.floor(pcm48kMono.length / 2) / (BRIDGE_SAMPLE_RATE / 1_000);
}
