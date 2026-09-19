/**
 * Rate conversion between the bridge lane (48 kHz) and the provider (24 kHz).
 *
 * `resamplePcm` here is the real SDK implementation (vendored verbatim for the
 * standalone harness), so these are assertions about the actual conversion.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGE_FRAME_BYTES,
  bridgePcmDurationMs,
  convertBridgePcm48kMonoToRealtimePcm24k,
  convertRealtimePcm24kToBridgePcm48kMono,
} from "../src/voice/audio.js";
import { toneFrame48k } from "./mock-bridge.js";

describe("bridge <-> realtime audio conversion", () => {
  it("halves the sample count going 48k -> 24k", () => {
    const pcm48k = toneFrame48k();
    expect(pcm48k.length).toBe(BRIDGE_FRAME_BYTES);

    const pcm24k = convertBridgePcm48kMonoToRealtimePcm24k(pcm48k);
    expect(pcm24k.length).toBe(BRIDGE_FRAME_BYTES / 2);
  });

  it("doubles the sample count going 24k -> 48k", () => {
    const pcm24k = Buffer.alloc(480 * 2);
    const pcm48k = convertRealtimePcm24kToBridgePcm48kMono(pcm24k);
    expect(pcm48k.length).toBe(960 * 2);
  });

  it("preserves playback duration across a round trip", () => {
    const pcm48k = toneFrame48k();
    expect(bridgePcmDurationMs(pcm48k)).toBe(20);

    const roundTripped = convertRealtimePcm24kToBridgePcm48kMono(
      convertBridgePcm48kMonoToRealtimePcm24k(pcm48k),
    );
    expect(bridgePcmDurationMs(roundTripped)).toBe(20);
  });

  it("keeps a 440 Hz tone recognizable through the downsample", () => {
    // 440 Hz is well under the 12 kHz Nyquist limit at 24 kHz, so the tone must
    // survive; a broken conversion shows up as silence or clipping.
    const pcm24k = convertBridgePcm48kMonoToRealtimePcm24k(toneFrame48k(440, 960, 8_000));
    let peak = 0;
    for (let offset = 0; offset + 1 < pcm24k.length; offset += 2) {
      peak = Math.max(peak, Math.abs(pcm24k.readInt16LE(offset)));
    }
    expect(peak).toBeGreaterThan(4_000);
    expect(peak).toBeLessThanOrEqual(32_767);
  });

  it("returns empty for empty or sub-sample input instead of throwing", () => {
    expect(convertBridgePcm48kMonoToRealtimePcm24k(Buffer.alloc(0)).length).toBe(0);
    expect(convertBridgePcm48kMonoToRealtimePcm24k(Buffer.alloc(1)).length).toBe(0);
    expect(convertRealtimePcm24kToBridgePcm48kMono(Buffer.alloc(0)).length).toBe(0);
  });
});
