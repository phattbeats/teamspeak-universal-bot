import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
const BRIDGE_SAMPLE_RATE = 48e3;
const REALTIME_SAMPLE_RATE = 24e3;
const STT_SAMPLE_RATE = 16e3;
const BRIDGE_FRAME_SAMPLES = 960;
const BRIDGE_FRAME_BYTES = BRIDGE_FRAME_SAMPLES * 2;
function convertBridgePcm48kMonoToRealtimePcm24k(pcm48kMono) {
  if (pcm48kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm48kMono, BRIDGE_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
}
function convertRealtimePcm24kToBridgePcm48kMono(pcm24kMono) {
  if (pcm24kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm24kMono, REALTIME_SAMPLE_RATE, BRIDGE_SAMPLE_RATE);
}
function convertBridgePcm48kMonoToSttPcm16k(pcm48kMono) {
  if (pcm48kMono.length < 2) {
    return Buffer.alloc(0);
  }
  return resamplePcm(pcm48kMono, BRIDGE_SAMPLE_RATE, STT_SAMPLE_RATE);
}
function bridgePcmDurationMs(pcm48kMono) {
  return Math.floor(pcm48kMono.length / 2) / (BRIDGE_SAMPLE_RATE / 1e3);
}
function chunkBridgePcm(pcm48kMono, frameBytes = BRIDGE_FRAME_BYTES) {
  const frames = [];
  for (let offset = 0; offset < pcm48kMono.length; offset += frameBytes) {
    frames.push(pcm48kMono.subarray(offset, Math.min(offset + frameBytes, pcm48kMono.length)));
  }
  return frames;
}
const WAV_HEADER_BYTES = 44;
function encodeWavPcm16Mono(pcm, sampleRate = STT_SAMPLE_RATE) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export {
  BRIDGE_FRAME_BYTES,
  BRIDGE_FRAME_SAMPLES,
  BRIDGE_SAMPLE_RATE,
  REALTIME_SAMPLE_RATE,
  STT_SAMPLE_RATE,
  bridgePcmDurationMs,
  chunkBridgePcm,
  convertBridgePcm48kMonoToRealtimePcm24k,
  convertBridgePcm48kMonoToSttPcm16k,
  convertRealtimePcm24kToBridgePcm48kMono,
  encodeWavPcm16Mono
};
