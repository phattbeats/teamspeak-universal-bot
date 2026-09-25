import { spawn } from "node:child_process";
const DEFAULT_SPAWN = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
const STDERR_KEEP_BYTES = 2e3;
class RuntimeSpeechSynthesizer {
  constructor(params) {
    this.params = params;
    this.spawnProcess = params.spawnProcess ?? DEFAULT_SPAWN;
  }
  params;
  spawnProcess;
  get id() {
    return this.params.config.provider;
  }
  async synthesize(text) {
    const config = this.params.config;
    const prepared = await this.params.tts.prepareTtsRequest({
      cfg: this.params.cfg,
      override: buildTtsOverride(config),
      text
    });
    const directives = prepared.directives;
    const speakText = (directives.overrides.ttsText ?? directives.cleanedText).trim();
    if (!speakText) {
      return { status: "empty" };
    }
    const result = await this.params.tts.textToSpeech({
      text: speakText,
      cfg: prepared.cfg,
      channel: "teamspeak",
      overrides: directives.overrides,
      timeoutMs: config.timeoutMs,
      // A fallback would silently move the lane onto a metered provider, which
      // is the one thing this lane may not do. Fail loudly instead.
      disableFallback: true
    });
    if (!result.success || !result.audioPath) {
      return { status: "failed", error: result.error ?? "TTS conversion failed" };
    }
    try {
      const pcm48kMono = await this.decode(result.audioPath);
      if (pcm48kMono.length === 0) {
        return { status: "failed", error: `ffmpeg produced no audio from ${result.audioPath}` };
      }
      return { status: "ok", pcm48kMono, provider: result.provider, speakText };
    } finally {
      await this.params.removeFile?.(result.audioPath);
    }
  }
  decode(audioPath) {
    return decodeAudioFileToBridgePcm({
      audioPath,
      ffmpegPath: this.params.ffmpegPath ?? "ffmpeg",
      spawnProcess: this.spawnProcess,
      timeoutMs: this.params.config.timeoutMs,
      ...this.params.log ? { log: this.params.log } : {}
    });
  }
}
function decodeAudioFileToBridgePcm(params) {
  return new Promise((resolve, reject) => {
    const child = params.spawnProcess(params.ffmpegPath, [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      params.audioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "s16le",
      "pipe:1"
    ]);
    const chunks = [];
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`ffmpeg timed out after ${params.timeoutMs}ms decoding ${params.audioPath}`));
      try {
        child.kill("SIGKILL");
      } catch (error) {
        params.log?.(`teamspeak voice: killing ffmpeg failed: ${describe(error)}`);
      }
    }, params.timeoutMs);
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    };
    child.stdout?.on("data", ((chunk) => {
      chunks.push(chunk);
    }));
    child.stderr?.on("data", ((chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_KEEP_BYTES);
    }));
    child.on("error", ((error) => {
      finish(new Error(`ffmpeg failed: ${describe(error)}`));
    }));
    child.on("exit", ((code) => {
      if (code === 0 || code === null) {
        finish();
        return;
      }
      finish(new Error(`ffmpeg exited code=${code}: ${lastLine(stderrTail)}`));
    }));
  });
}
function buildTtsOverride(config) {
  return {
    provider: config.provider,
    providers: {
      [config.provider]: {
        model: config.model,
        ...config.voiceId ? { voiceId: config.voiceId } : {}
      }
    },
    timeoutMs: config.timeoutMs
  };
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function lastLine(text) {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.slice(0, 200) ?? "";
}
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=\S)/;
function splitIntoSpeechChunks(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const sentences = trimmed.split(SENTENCE_SPLIT_RE).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
  if (sentences.length <= 1) {
    return [trimmed];
  }
  const [first, ...rest] = sentences;
  const chunks = [first];
  for (const sentence of rest) {
    const last = chunks[chunks.length - 1];
    if (chunks.length > 1 && last.length < MIN_TRAILING_CHUNK_CHARS) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}
const MIN_TRAILING_CHUNK_CHARS = 40;
export {
  RuntimeSpeechSynthesizer,
  buildTtsOverride,
  decodeAudioFileToBridgePcm,
  splitIntoSpeechChunks
};
