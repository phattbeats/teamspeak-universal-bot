/**
 * Song generators for the house band (PHA-3554).
 *
 * One interface, three shapes, because on 2026-09-17 there is no single
 * obvious backend:
 *
 *  - `minimax`  — MiniMax `/v1/music_generation`. Refuses NEW accounts with
 *                 status 2153 ("no longer available to new users; existing
 *                 paying customers can continue"). Kept because it is the
 *                 shape the issue was written against and an existing account
 *                 still works.
 *  - `suno-api` — the self-hostable gcui-art/suno-api wrapper
 *                 (`POST /api/custom_generate`, `wait_audio: true`). Suno has
 *                 no official API; this is the open-source answer.
 *  - `command`  — any executable. Spec in as JSON on stdin, `{audioPath}` or
 *                 `{audioUrl}` out on stdout. The seam for a self-hosted
 *                 MiniMax-Music3 / ACE-Step on the box.
 *
 * Every generator ends the same way: an audio file on disk under `outDir`
 * that ffmpeg can decode. Nothing here touches the bridge.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedTeamSpeakBandConfig } from "../config.js";

export type SongSpec = {
  title: string;
  /** Short, genre-first (MiniMax-shaped). */
  style: string;
  /** Suno-shaped tag line. */
  styleTags: string;
  vocals: boolean;
  /** Required when `vocals`; ignored otherwise. */
  lyrics: string | undefined;
};

export type GeneratedSong = {
  title: string;
  audioPath: string;
  provider: string;
  /** Provider-reported length, when it says. */
  durationMs: number | undefined;
};

export type GenerateOptions = {
  outDir: string;
  signal: AbortSignal;
  /** Stable, filesystem-safe stem for the output file. */
  fileStem: string;
};

export type SongGenerator = {
  readonly id: string;
  generate(spec: SongSpec, options: GenerateOptions): Promise<GeneratedSong>;
};

export class SongGenerationError extends Error {}

/** The slice of `fetch` the HTTP generators use; a fake stands in for it in tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type GeneratorDeps = {
  fetchFn?: FetchLike | undefined;
  log?: ((message: string) => void) | undefined;
};

export function createSongGenerator(
  config: ResolvedTeamSpeakBandConfig,
  deps: GeneratorDeps = {},
): SongGenerator {
  switch (config.provider) {
    case "minimax":
      return new MiniMaxSongGenerator(config, deps);
    case "suno-api":
      return new SunoApiSongGenerator(config, deps);
    case "command":
      return new CommandSongGenerator(config, deps);
  }
}

// --- MiniMax ------------------------------------------------------------------

export class MiniMaxSongGenerator implements SongGenerator {
  readonly id = "minimax";
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly config: ResolvedTeamSpeakBandConfig,
    private readonly deps: GeneratorDeps,
  ) {
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }

  async generate(spec: SongSpec, options: GenerateOptions): Promise<GeneratedSong> {
    const { apiKey, baseUrl, model } = this.config.minimax;
    if (!apiKey) {
      throw new SongGenerationError("MiniMax music: no API key.");
    }
    const body = {
      model,
      prompt: spec.style,
      // MiniMax wants lyrics on every call; an instrumental is a lyrics field
      // that says so.
      lyrics: spec.vocals && spec.lyrics ? spec.lyrics : "[Instrumental]",
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
    };
    const response = await this.fetchFn(`${baseUrl}/v1/music_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    // MiniMax can return errors as HTTP 200 with a non-zero base_resp; and a
    // real HTTP error still carries a base_resp worth reading. Parse first.
    const parsed = (await response.json().catch(() => undefined)) as
      | {
          base_resp?: { status_code?: number; status_msg?: string };
          data?: { audio?: string; audio_url?: string; status?: number };
          extra_info?: { music_duration?: number };
        }
      | undefined;
    const status = parsed?.base_resp?.status_code ?? (response.ok ? 0 : response.status);
    if (status !== 0) {
      throw new SongGenerationError(
        `MiniMax music refused (status ${status}): ${parsed?.base_resp?.status_msg ?? `HTTP ${response.status}`}`,
      );
    }
    await mkdir(options.outDir, { recursive: true });
    const audioPath = path.join(options.outDir, `${options.fileStem}.mp3`);
    if (parsed?.data?.audio) {
      await writeFile(audioPath, Buffer.from(parsed.data.audio, "hex"));
    } else if (parsed?.data?.audio_url) {
      await download(this.fetchFn, parsed.data.audio_url, audioPath, options.signal);
    } else {
      throw new SongGenerationError("MiniMax music returned no audio.");
    }
    return {
      title: spec.title,
      audioPath,
      provider: this.id,
      durationMs:
        typeof parsed?.extra_info?.music_duration === "number"
          ? parsed.extra_info.music_duration
          : undefined,
    };
  }
}

// --- suno-api (gcui-art) --------------------------------------------------------

export class SunoApiSongGenerator implements SongGenerator {
  readonly id = "suno-api";
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly config: ResolvedTeamSpeakBandConfig,
    private readonly deps: GeneratorDeps,
  ) {
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }

  async generate(spec: SongSpec, options: GenerateOptions): Promise<GeneratedSong> {
    const { baseUrl, apiKey } = this.config.sunoApi;
    if (!baseUrl) {
      throw new SongGenerationError("suno-api: no base URL.");
    }
    const body = {
      prompt: spec.vocals && spec.lyrics ? spec.lyrics : "",
      tags: spec.styleTags,
      title: spec.title,
      make_instrumental: !spec.vocals,
      wait_audio: true,
    };
    const response = await this.fetchFn(`${baseUrl}/api/custom_generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new SongGenerationError(
        `suno-api refused (HTTP ${response.status}): ${lastLine(await response.text().catch(() => ""))}`,
      );
    }
    const parsed = (await response.json()) as unknown;
    const clips = (Array.isArray(parsed) ? parsed : [parsed]) as {
      audio_url?: string;
      title?: string;
      duration?: number | string;
      status?: string;
    }[];
    const clip = clips.find((candidate) => typeof candidate?.audio_url === "string" && candidate.audio_url);
    if (!clip?.audio_url) {
      throw new SongGenerationError("suno-api returned no clip with an audio_url.");
    }
    await mkdir(options.outDir, { recursive: true });
    const audioPath = path.join(options.outDir, `${options.fileStem}.mp3`);
    await download(this.fetchFn, clip.audio_url, audioPath, options.signal);
    const seconds = Number(clip.duration);
    return {
      title: spec.title,
      audioPath,
      provider: this.id,
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined,
    };
  }
}

// --- an executable --------------------------------------------------------------

export type CommandChild = {
  stdin: { write(chunk: string): unknown; end(): void } | null;
  stdout: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
  stderr: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): void;
};

export type CommandSpawn = (command: string, args: string[]) => CommandChild;

const defaultSpawn: CommandSpawn = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

export class CommandSongGenerator implements SongGenerator {
  readonly id = "command";
  private readonly spawnProcess: CommandSpawn;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly config: ResolvedTeamSpeakBandConfig,
    private readonly deps: GeneratorDeps & { spawnProcess?: CommandSpawn | undefined } = {},
  ) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawn;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }

  async generate(spec: SongSpec, options: GenerateOptions): Promise<GeneratedSong> {
    const { path: command, args } = this.config.command;
    if (!command) {
      throw new SongGenerationError("command generator: no path configured.");
    }
    await mkdir(options.outDir, { recursive: true });
    const child = this.spawnProcess(command, args);
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const onAbort = () => {
          child.kill("SIGKILL");
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", ((chunk: Buffer) => {
          stdout += String(chunk);
        }) as (...args: never[]) => void);
        child.stderr?.on("data", ((chunk: Buffer) => {
          stderr = `${stderr}${String(chunk)}`.slice(-4000);
        }) as (...args: never[]) => void);
        child.on("error", ((error: Error) => {
          options.signal.removeEventListener("abort", onAbort);
          reject(new SongGenerationError(`command generator failed to start: ${error.message}`));
        }) as (...args: never[]) => void);
        child.on("close", ((code: number | null) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve({ code, stdout, stderr });
        }) as (...args: never[]) => void);
        child.stdin?.write(
          JSON.stringify({
            ...spec,
            outDir: options.outDir,
            fileStem: options.fileStem,
          }),
        );
        child.stdin?.end();
      },
    );
    if (output.code !== 0) {
      throw new SongGenerationError(
        `command generator exited ${output.code ?? "by signal"}: ${lastLine(output.stderr) || "no stderr"}`,
      );
    }
    let parsed: { audioPath?: string; audioUrl?: string; title?: string; durationMs?: number };
    try {
      parsed = JSON.parse(lastLine(output.stdout) || "{}") as typeof parsed;
    } catch {
      throw new SongGenerationError("command generator printed something other than JSON.");
    }
    let audioPath = parsed.audioPath;
    if (!audioPath && parsed.audioUrl) {
      audioPath = path.join(options.outDir, `${options.fileStem}.mp3`);
      await download(this.fetchFn, parsed.audioUrl, audioPath, options.signal);
    }
    if (!audioPath) {
      throw new SongGenerationError("command generator returned neither audioPath nor audioUrl.");
    }
    return {
      title: parsed.title?.trim() || spec.title,
      audioPath,
      provider: this.id,
      durationMs:
        typeof parsed.durationMs === "number" && parsed.durationMs > 0 ? parsed.durationMs : undefined,
    };
  }
}

// --- helpers --------------------------------------------------------------------

async function download(
  fetchFn: FetchLike,
  url: string,
  toPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (!/^https?:\/\//iu.test(url)) {
    throw new SongGenerationError(`refusing to download a non-http(s) audio URL: ${url}`);
  }
  const response = await fetchFn(url, { method: "GET", headers: {}, signal });
  if (!response.ok) {
    throw new SongGenerationError(`downloading the song failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new SongGenerationError("downloaded song is empty.");
  }
  await writeFile(toPath, bytes);
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
