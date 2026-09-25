const DEFAULT_COMMAND_PREFIX = "!";
const DEFAULT_VOICE_MODE = "agent-proxy";
const DEFAULT_SEXTON_LOG_DIR = "/mnt/user/appdata/sexton";
const DEFAULT_CATCH_UP_LINES = 15;
const DEFAULT_CATCH_UP_MAX_LINES = 40;
const DEFAULT_MUSIC_VOLUME = 0.6;
const DEFAULT_MUSIC_PREBUFFER_MS = 240;
const DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS = 2e4;
function areTeamSpeakToolsEnabled(config) {
  return config?.tools?.enabled !== false;
}
function isTeamSpeakMusicEnabled(config) {
  return areTeamSpeakToolsEnabled(config) && config?.tools?.music?.enabled !== false;
}
const DEFAULT_BAND_PROVIDER = "minimax";
const DEFAULT_BAND_GENERATE_TIMEOUT_MS = 36e4;
const DEFAULT_BAND_INTRO_GAP_MS = 700;
const DEFAULT_BAND_KEEP_SONGS = 20;
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MUSIC_MODEL = "music-3.0";
function isTeamSpeakBandEnabled(config) {
  return isTeamSpeakMusicEnabled(config) && config?.tools?.band?.enabled === true;
}
function resolveTeamSpeakBandConfig(config, env = process.env) {
  const raw = config?.tools?.band;
  const provider = raw?.provider?.trim() || DEFAULT_BAND_PROVIDER;
  const resolved = {
    name: raw?.name?.trim() || void 0,
    aliases: Array.isArray(raw?.aliases) ? raw.aliases.map((alias) => String(alias).trim()).filter(Boolean) : void 0,
    provider,
    minimax: {
      apiKey: raw?.minimax?.apiKey?.trim() || env.MINIMAX_API_KEY?.trim() || void 0,
      baseUrl: (raw?.minimax?.baseUrl?.trim() || DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/u, ""),
      model: raw?.minimax?.model?.trim() || DEFAULT_MINIMAX_MUSIC_MODEL
    },
    sunoApi: {
      baseUrl: (raw?.sunoApi?.baseUrl?.trim() || env.SUNO_API_BASE_URL?.trim() || void 0)?.replace(
        /\/+$/u,
        ""
      ),
      apiKey: raw?.sunoApi?.apiKey?.trim() || env.SUNO_API_KEY?.trim() || void 0
    },
    command: {
      path: raw?.command?.path?.trim() || void 0,
      args: raw?.command?.args ?? []
    },
    songsDir: raw?.songsDir?.trim() || void 0,
    generateTimeoutMs: positiveMs(raw?.generateTimeoutMs, DEFAULT_BAND_GENERATE_TIMEOUT_MS),
    announce: raw?.announce !== false,
    introGapMs: nonNegativeMs(raw?.introGapMs, DEFAULT_BAND_INTRO_GAP_MS),
    keepSongs: typeof raw?.keepSongs === "number" && Number.isFinite(raw.keepSongs) && raw.keepSongs >= 1 ? Math.floor(raw.keepSongs) : DEFAULT_BAND_KEEP_SONGS
  };
  switch (provider) {
    case "minimax":
      if (!resolved.minimax.apiKey) {
        return {
          ok: false,
          reason: "tools.band.provider=minimax needs tools.band.minimax.apiKey or MINIMAX_API_KEY."
        };
      }
      return { ok: true, config: resolved };
    case "suno-api":
      if (!resolved.sunoApi.baseUrl) {
        return {
          ok: false,
          reason: "tools.band.provider=suno-api needs tools.band.sunoApi.baseUrl or SUNO_API_BASE_URL."
        };
      }
      return { ok: true, config: resolved };
    case "command":
      if (!resolved.command.path) {
        return { ok: false, reason: "tools.band.provider=command needs tools.band.command.path." };
      }
      return { ok: true, config: resolved };
    default:
      return {
        ok: false,
        reason: `tools.band.provider="${String(provider)}" is not one of minimax, suno-api, command.`
      };
  }
}
function resolveSextonLogDir(config, env = process.env) {
  return config?.tools?.logDir?.trim() || env.TEAMSPEAK_SEXTON_LOG_DIR?.trim() || DEFAULT_SEXTON_LOG_DIR;
}
function isTeamSpeakVoiceEnabled(config) {
  return config?.voice?.enabled !== false;
}
const DEFAULT_WHISPER_URL = "http://whisper:8080/inference";
const DEFAULT_WHISPER_LANGUAGE = "en";
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15e3;
const DEFAULT_SPEECH_TIMEOUT_MS = 2e4;
const DEFAULT_SPEECH_PROVIDER = "minimax";
const DEFAULT_SPEECH_MODEL = "speech-2.8-hd";
const DEFAULT_SEGMENT_HANGOVER_MS = 600;
const DEFAULT_MIN_SEGMENT_MS = 320;
const DEFAULT_MAX_SEGMENT_MS = 2e4;
const LOCAL_TRANSCRIPTION_PROVIDERS = ["whisper-local"];
function isLocalTranscriptionProvider(provider) {
  return LOCAL_TRANSCRIPTION_PROVIDERS.includes(
    (provider ?? "").trim().toLowerCase()
  );
}
function resolveTeamSpeakTranscriptionConfig(config, env = process.env) {
  const raw = config?.voice?.streaming?.transcription;
  const provider = raw?.provider?.trim() || LOCAL_TRANSCRIPTION_PROVIDERS[0];
  if (!isLocalTranscriptionProvider(provider)) {
    return {
      ok: false,
      reason: `voice.streaming.transcription.provider="${provider}" is not a local transcriber. voice.mode=stt-tts only runs local speech-to-text (${LOCAL_TRANSCRIPTION_PROVIDERS.join(", ")}); every registered OpenClaw transcription provider is metered and hosted.`
    };
  }
  return {
    ok: true,
    config: {
      provider,
      url: raw?.url?.trim() || env.TEAMSPEAK_WHISPER_URL?.trim() || DEFAULT_WHISPER_URL,
      model: raw?.model?.trim() || void 0,
      language: raw?.language?.trim() || DEFAULT_WHISPER_LANGUAGE,
      timeoutMs: positiveMs(raw?.timeoutMs, DEFAULT_TRANSCRIPTION_TIMEOUT_MS)
    }
  };
}
const SECONDARY_TRANSCRIPTION_PROVIDERS = ["minimax-asr"];
const DEFAULT_MINIMAX_ASR_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_ASR_MODEL = "asr-1.0";
const DEFAULT_SECONDARY_TIMEOUT_MS = 8e3;
const DEFAULT_SECONDARY_SLOW_MS = 3e3;
const DEFAULT_SECONDARY_BACKOFF_MS = 6e5;
const DEFAULT_LONG_SEGMENT_MS = 8e3;
const DEFAULT_EMPTY_ESCALATION_MIN_MS = 1500;
const DEFAULT_MAX_FRUITLESS_ESCALATIONS = 3;
const DEFAULT_FRUITLESS_COOLDOWN_MS = 12e4;
function resolveTeamSpeakSecondaryTranscriptionConfig(config, env = process.env) {
  const raw = config?.voice?.streaming?.secondaryTranscription;
  if (!raw) {
    return { ok: false, reason: void 0 };
  }
  const apiKey = raw.apiKey?.trim() || env.MINIMAX_API_KEY?.trim() || "";
  const provider = raw.provider?.trim() || SECONDARY_TRANSCRIPTION_PROVIDERS[0];
  if (!SECONDARY_TRANSCRIPTION_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      reason: `voice.streaming.secondaryTranscription.provider="${provider}" is not implemented (${SECONDARY_TRANSCRIPTION_PROVIDERS.join(", ")}).`
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      reason: "voice.streaming.secondaryTranscription is configured but no apiKey was found (set it there or as MINIMAX_API_KEY); staying on whisper-local only."
    };
  }
  return {
    ok: true,
    config: {
      provider,
      baseUrl: (raw.baseUrl?.trim() || DEFAULT_MINIMAX_ASR_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, ""),
      apiKey,
      model: raw.model?.trim() || DEFAULT_MINIMAX_ASR_MODEL,
      language: raw.language?.trim() || DEFAULT_WHISPER_LANGUAGE,
      timeoutMs: positiveMs(raw.timeoutMs, DEFAULT_SECONDARY_TIMEOUT_MS),
      slowMs: positiveMs(raw.slowMs, DEFAULT_SECONDARY_SLOW_MS),
      backoffMs: positiveMs(raw.backoffMs, DEFAULT_SECONDARY_BACKOFF_MS)
    },
    routing: {
      longSegmentMs: positiveMs(raw.longSegmentMs, DEFAULT_LONG_SEGMENT_MS),
      emptyEscalationMinMs: positiveMs(raw.emptyEscalationMinMs, DEFAULT_EMPTY_ESCALATION_MIN_MS),
      maxFruitlessEscalations: positiveMs(
        raw.maxFruitlessEscalations,
        DEFAULT_MAX_FRUITLESS_ESCALATIONS
      ),
      fruitlessCooldownMs: positiveMs(raw.fruitlessCooldownMs, DEFAULT_FRUITLESS_COOLDOWN_MS)
    }
  };
}
function resolveTeamSpeakSpeechConfig(config) {
  const raw = config?.voice?.streaming?.speech;
  return {
    provider: raw?.provider?.trim() || DEFAULT_SPEECH_PROVIDER,
    model: raw?.model?.trim() || DEFAULT_SPEECH_MODEL,
    voiceId: raw?.voiceId?.trim() || void 0,
    timeoutMs: positiveMs(raw?.timeoutMs, DEFAULT_SPEECH_TIMEOUT_MS)
  };
}
function resolveTeamSpeakSegmentationConfig(config) {
  const raw = config?.voice?.streaming?.segmentation;
  return {
    hangoverMs: nonNegativeMs(raw?.hangoverMs, DEFAULT_SEGMENT_HANGOVER_MS),
    minSegmentMs: nonNegativeMs(raw?.minSegmentMs, DEFAULT_MIN_SEGMENT_MS),
    maxSegmentMs: positiveMs(raw?.maxSegmentMs, DEFAULT_MAX_SEGMENT_MS)
  };
}
function resolveTeamSpeakWakeConfig(config) {
  const voice = config?.voice;
  const realtime = voice?.realtime;
  const requireWakeName = voice?.requireWakeName ?? realtime?.requireWakeName;
  const wakeNames = voice?.wakeNames ?? realtime?.wakeNames;
  const wakeAliases = voice?.wakeAliases ?? realtime?.wakeAliases;
  const excludeWakeNames = voice?.excludeWakeNames ?? realtime?.excludeWakeNames;
  const bargeIn = voice?.bargeIn ?? realtime?.bargeIn;
  const followUpSilenceMs = voice?.followUpSilenceMs ?? realtime?.followUpSilenceMs;
  return {
    ...requireWakeName === void 0 ? {} : { requireWakeName },
    ...wakeNames === void 0 ? {} : { wakeNames },
    ...wakeAliases === void 0 ? {} : { wakeAliases },
    ...excludeWakeNames === void 0 ? {} : { excludeWakeNames },
    ...bargeIn === void 0 ? {} : { bargeIn },
    ...followUpSilenceMs === void 0 ? {} : { followUpSilenceMs }
  };
}
function positiveMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function nonNegativeMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function resolveTeamSpeakVoiceMode(config) {
  return config?.voice?.mode ?? DEFAULT_VOICE_MODE;
}
export {
  DEFAULT_BAND_GENERATE_TIMEOUT_MS,
  DEFAULT_BAND_INTRO_GAP_MS,
  DEFAULT_BAND_KEEP_SONGS,
  DEFAULT_BAND_PROVIDER,
  DEFAULT_CATCH_UP_LINES,
  DEFAULT_CATCH_UP_MAX_LINES,
  DEFAULT_COMMAND_PREFIX,
  DEFAULT_EMPTY_ESCALATION_MIN_MS,
  DEFAULT_FRUITLESS_COOLDOWN_MS,
  DEFAULT_LONG_SEGMENT_MS,
  DEFAULT_MAX_FRUITLESS_ESCALATIONS,
  DEFAULT_MAX_SEGMENT_MS,
  DEFAULT_MINIMAX_ASR_BASE_URL,
  DEFAULT_MINIMAX_ASR_MODEL,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MUSIC_MODEL,
  DEFAULT_MIN_SEGMENT_MS,
  DEFAULT_MUSIC_PREBUFFER_MS,
  DEFAULT_MUSIC_RESOLVE_TIMEOUT_MS,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_SECONDARY_BACKOFF_MS,
  DEFAULT_SECONDARY_SLOW_MS,
  DEFAULT_SECONDARY_TIMEOUT_MS,
  DEFAULT_SEGMENT_HANGOVER_MS,
  DEFAULT_SEXTON_LOG_DIR,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_SPEECH_PROVIDER,
  DEFAULT_SPEECH_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_VOICE_MODE,
  DEFAULT_WHISPER_LANGUAGE,
  DEFAULT_WHISPER_URL,
  LOCAL_TRANSCRIPTION_PROVIDERS,
  SECONDARY_TRANSCRIPTION_PROVIDERS,
  areTeamSpeakToolsEnabled,
  isLocalTranscriptionProvider,
  isTeamSpeakBandEnabled,
  isTeamSpeakMusicEnabled,
  isTeamSpeakVoiceEnabled,
  resolveSextonLogDir,
  resolveTeamSpeakBandConfig,
  resolveTeamSpeakSecondaryTranscriptionConfig,
  resolveTeamSpeakSegmentationConfig,
  resolveTeamSpeakSpeechConfig,
  resolveTeamSpeakTranscriptionConfig,
  resolveTeamSpeakVoiceMode,
  resolveTeamSpeakWakeConfig
};
