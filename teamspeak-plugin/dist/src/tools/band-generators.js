import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
class SongGenerationError extends Error {
}
const defaultFetch = (url, init) => fetch(url, init);
function createSongGenerator(config, deps = {}) {
  switch (config.provider) {
    case "minimax":
      return new MiniMaxSongGenerator(config, deps);
    case "suno-api":
      return new SunoApiSongGenerator(config, deps);
    case "command":
      return new CommandSongGenerator(config, deps);
  }
}
class MiniMaxSongGenerator {
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }
  config;
  deps;
  id = "minimax";
  fetchFn;
  async generate(spec, options) {
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
      audio_setting: { sample_rate: 44100, bitrate: 256e3, format: "mp3" }
    };
    const response = await this.fetchFn(`${baseUrl}/v1/music_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal
    });
    const parsed = await response.json().catch(() => void 0);
    const status = parsed?.base_resp?.status_code ?? (response.ok ? 0 : response.status);
    if (status !== 0) {
      throw new SongGenerationError(
        `MiniMax music refused (status ${status}): ${parsed?.base_resp?.status_msg ?? `HTTP ${response.status}`}`
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
      durationMs: typeof parsed?.extra_info?.music_duration === "number" ? parsed.extra_info.music_duration : void 0
    };
  }
}
class SunoApiSongGenerator {
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }
  config;
  deps;
  id = "suno-api";
  fetchFn;
  async generate(spec, options) {
    const { baseUrl, apiKey } = this.config.sunoApi;
    if (!baseUrl) {
      throw new SongGenerationError("suno-api: no base URL.");
    }
    const body = {
      prompt: spec.vocals && spec.lyrics ? spec.lyrics : "",
      tags: spec.styleTags,
      title: spec.title,
      make_instrumental: !spec.vocals,
      wait_audio: true
    };
    const response = await this.fetchFn(`${baseUrl}/api/custom_generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      },
      body: JSON.stringify(body),
      signal: options.signal
    });
    if (!response.ok) {
      throw new SongGenerationError(
        `suno-api refused (HTTP ${response.status}): ${lastLine(await response.text().catch(() => ""))}`
      );
    }
    const parsed = await response.json();
    const clips = Array.isArray(parsed) ? parsed : [parsed];
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
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1e3) : void 0
    };
  }
}
const defaultSpawn = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
class CommandSongGenerator {
  constructor(config, deps = {}) {
    this.config = config;
    this.deps = deps;
    this.spawnProcess = deps.spawnProcess ?? defaultSpawn;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
  }
  config;
  deps;
  id = "command";
  spawnProcess;
  fetchFn;
  async generate(spec, options) {
    const { path: command, args } = this.config.command;
    if (!command) {
      throw new SongGenerationError("command generator: no path configured.");
    }
    await mkdir(options.outDir, { recursive: true });
    const child = this.spawnProcess(command, args);
    const output = await new Promise(
      (resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const onAbort = () => {
          child.kill("SIGKILL");
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", ((chunk) => {
          stdout += String(chunk);
        }));
        child.stderr?.on("data", ((chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-4e3);
        }));
        child.on("error", ((error) => {
          options.signal.removeEventListener("abort", onAbort);
          reject(new SongGenerationError(`command generator failed to start: ${error.message}`));
        }));
        child.on("close", ((code) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve({ code, stdout, stderr });
        }));
        child.stdin?.on("error", (() => void 0));
        child.stdin?.write(
          JSON.stringify({
            ...spec,
            outDir: options.outDir,
            fileStem: options.fileStem
          })
        );
        child.stdin?.end();
      }
    );
    if (output.code !== 0) {
      throw new SongGenerationError(
        `command generator exited ${output.code ?? "by signal"}: ${lastLine(output.stderr) || "no stderr"}`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(lastLine(output.stdout) || "{}");
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
      durationMs: typeof parsed.durationMs === "number" && parsed.durationMs > 0 ? parsed.durationMs : void 0
    };
  }
}
async function download(fetchFn, url, toPath, signal) {
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
function lastLine(text) {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
export {
  CommandSongGenerator,
  MiniMaxSongGenerator,
  SongGenerationError,
  SunoApiSongGenerator,
  createSongGenerator
};
