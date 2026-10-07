/**
 * Reply text -> 48 kHz mono PCM16 for the bridge's `voice_audio` lane (#3228).
 *
 * Nothing here talks to MiniMax. `extensions/minimax` already registers a real
 * `speechProviders` entry with its own auth, base-url, and directive handling,
 * so this goes through the host TTS runtime (`runtime.tts`, the same seam
 * Discord's stt-tts lane uses in extensions/discord/src/voice/tts.ts) and picks
 * the provider by config. Re-implementing the T2A call here would fork the auth
 * resolution and the model-id pinning that keeps a Coding Plan key working.
 *
 * The one piece the host cannot do is the format: MiniMax's provider returns
 * mp3, and the bridge takes raw PCM at 48 kHz. So the synthesized file is
 * decoded with ffmpeg — the same binary and the same flags the music lane
 * already runs (`src/tools/music.ts`), from the same image.
 */
import { spawn } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isTtsProviderConfigured, resolveTtsConfig } from "openclaw/plugin-sdk/tts-runtime";
import type { ResolvedTeamSpeakSpeechConfig } from "../config.js";

export type SpeechSynthesisOutcome =
  | { status: "ok"; pcm48kMono: Buffer; provider: string | undefined; speakText: string }
  | { status: "empty" }
  | { status: "failed"; error: string };

export type SpeechSynthesizer = {
  /** Provider id, surfaced in `!sexton status`. */
  readonly id: string;
  synthesize(text: string): Promise<SpeechSynthesisOutcome>;
};

/**
 * The slice of `PluginRuntime["tts"]` this lane uses, restated structurally so
 * the module does not depend on the host runtime type (and so tests can pass a
 * plain object). Shapes track `openclaw/plugin-sdk/tts-runtime`.
 *
 * Declared with method syntax, not function properties, deliberately: method
 * parameters are checked bivariantly, so the host's narrowly-typed
 * `runCommandFromIngress`-style signatures assign to this seam inside a real
 * OpenClaw checkout without the plugin importing the host's config types.
 */
/** The host's own "can this speech provider synthesize" check, against the gateway config. */
export function isHostSpeechProviderConfigured(provider: string, cfg: OpenClawConfig): boolean {
  return isTtsProviderConfigured(resolveTtsConfig(cfg), provider, cfg);
}

export type TeamSpeakTtsRuntime = {
  prepareTtsRequest(params: {
    cfg: unknown;
    override?: unknown;
    text: string;
  }): PreparedTtsLike | Promise<PreparedTtsLike>;
  textToSpeech(params: {
    text: string;
    cfg: unknown;
    channel?: string;
    overrides?: unknown;
    disableFallback?: boolean;
    timeoutMs?: number;
  }): Promise<{
    success: boolean;
    audioPath?: string | undefined;
    provider?: string | undefined;
    error?: string | undefined;
  }>;
};

type TtsDirectivesLike = {
  cleanedText: string;
  overrides: { ttsText?: string | undefined };
};

type PreparedTtsLike = { cfg: unknown; directives: TtsDirectivesLike };

export type AudioDecodeChildStream = {
  on(event: string, listener: (...args: never[]) => void): unknown;
};

export type AudioDecodeChildProcess = {
  stdout: AudioDecodeChildStream | null;
  stderr: AudioDecodeChildStream | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): void;
};

export type AudioDecodeSpawn = (command: string, args: string[]) => AudioDecodeChildProcess;

export type RuntimeSpeechSynthesizerParams = {
  config: ResolvedTeamSpeakSpeechConfig;
  /** Host config, forwarded to the TTS runtime unchanged. */
  cfg: unknown;
  tts: TeamSpeakTtsRuntime;
  /** Deletes the synthesized file once decoded; a no-op is acceptable in tests. */
  removeFile?: ((path: string) => Promise<void> | void) | undefined;
  ffmpegPath?: string | undefined;
  spawnProcess?: AudioDecodeSpawn | undefined;
  log?: ((message: string) => void) | undefined;
};

const DEFAULT_SPAWN: AudioDecodeSpawn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

const STDERR_KEEP_BYTES = 2_000;

export class RuntimeSpeechSynthesizer implements SpeechSynthesizer {
  private readonly spawnProcess: AudioDecodeSpawn;

  constructor(private readonly params: RuntimeSpeechSynthesizerParams) {
    this.spawnProcess = params.spawnProcess ?? DEFAULT_SPAWN;
  }

  get id(): string {
    return this.params.config.provider;
  }

  async synthesize(text: string): Promise<SpeechSynthesisOutcome> {
    const config = this.params.config;
    const prepared: PreparedTtsLike = await this.params.tts.prepareTtsRequest({
      cfg: this.params.cfg,
      override: buildTtsOverride(config),
      text,
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
      disableFallback: true,
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

  private decode(audioPath: string): Promise<Buffer> {
    return decodeAudioFileToBridgePcm({
      audioPath,
      ffmpegPath: this.params.ffmpegPath ?? "ffmpeg",
      spawnProcess: this.spawnProcess,
      timeoutMs: this.params.config.timeoutMs,
      ...(this.params.log ? { log: this.params.log } : {}),
    });
  }
}

/**
 * `ffmpeg -i <file> -vn -ac 1 -ar 48000 -f s16le pipe:1`.
 *
 * The same conversion the music lane does, minus the reconnect flags: this
 * input is a local file the host just wrote, not a signed CDN URL.
 */
export function decodeAudioFileToBridgePcm(params: {
  audioPath: string;
  ffmpegPath: string;
  spawnProcess: AudioDecodeSpawn;
  timeoutMs: number;
  log?: ((message: string) => void) | undefined;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
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
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
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

    const finish = (error?: Error) => {
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

    child.stdout?.on("data", ((chunk: Buffer) => {
      chunks.push(chunk);
    }) as (...args: never[]) => void);
    child.stderr?.on("data", ((chunk: Buffer) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_KEEP_BYTES);
    }) as (...args: never[]) => void);
    child.on("error", ((error: Error) => {
      finish(new Error(`ffmpeg failed: ${describe(error)}`));
    }) as (...args: never[]) => void);
    child.on("exit", ((code: number | null) => {
      if (code === 0 || code === null) {
        finish();
        return;
      }
      finish(new Error(`ffmpeg exited code=${code}: ${lastLine(stderrTail)}`));
    }) as (...args: never[]) => void);
  });
}

/**
 * The `TtsConfig` override handed to the host runtime.
 *
 * `provider` picks the registered speech provider; the model and voice go in
 * the provider-keyed block, which is where `extensions/minimax` reads them
 * from. `voiceId` is free-form on purpose: MiniMax's factory runs it through
 * `trimToUndefined` and never checks it against the short advertised
 * `MINIMAX_TTS_VOICES` list, so any MiniMax system voice id works.
 */
export function buildTtsOverride(config: ResolvedTeamSpeakSpeechConfig): {
  provider: string;
  providers: Record<string, Record<string, unknown>>;
  timeoutMs: number;
} {
  return {
    provider: config.provider,
    providers: {
      [config.provider]: {
        model: config.model,
        ...(config.voiceId ? { voiceId: config.voiceId } : {}),
        // #3842: MiniMax reads pitch/speed from this same block and
        // range-checks them itself (an out-of-range value is a logged warning).
        ...(config.pitch !== undefined ? { pitch: config.pitch } : {}),
        ...(config.speed !== undefined ? { speed: config.speed } : {}),
      },
    },
    timeoutMs: config.timeoutMs,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.slice(0, 200) ?? "";
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=\S)/;

/**
 * Split a reply into per-sentence pieces so the stt-tts lane can synthesize
 * and play them as a pipeline instead of one T2A call for the whole reply
 * (#3607: "streaming TTS", the ~7s -> ~4s first-audio path).
 *
 * There is no host SDK support for token-level streaming synthesis — `tts`
 * only ever returns a finished file (see the module doc above) — so this is
 * the honest version of streaming reachable without forking MiniMax's auth
 * plumbing: play sentence one while sentence two is still being synthesized.
 * The tradeoff is real and stated rather than hidden: N T2A round trips
 * instead of one adds a little to the *total* time a long reply takes to
 * finish, in exchange for a much shorter wait before anything is heard.
 *
 * The first sentence is never merged with anything after it — its only job
 * is to be as short as whatever the model actually said first, so synthesis
 * of it starts (and finishes) as fast as possible. Short fragments *after*
 * the first are merged forward so a two-word sentence doesn't cost its own
 * full round trip for no perceptible latency benefit.
 */
export function splitIntoSpeechChunks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const sentences = trimmed
    .split(SENTENCE_SPLIT_RE)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  if (sentences.length <= 1) {
    return [trimmed];
  }
  const [first, ...rest] = sentences;
  const chunks: string[] = [first as string];
  for (const sentence of rest) {
    const last = chunks[chunks.length - 1] as string;
    if (chunks.length > 1 && last.length < MIN_TRAILING_CHUNK_CHARS) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

const MIN_TRAILING_CHUNK_CHARS = 40;
