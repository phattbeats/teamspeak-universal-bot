import {
  resolveTeamSpeakSecondaryTranscriptionConfig,
  resolveTeamSpeakSegmentationConfig,
  resolveTeamSpeakSpeechConfig,
  resolveTeamSpeakTranscriptionConfig,
  resolveTeamSpeakWakeConfig
} from "../config.js";
import {
  createTeamSpeakAgentTurn
} from "./agent-turn.js";
import {
  RuntimeSpeechSynthesizer
} from "./speech.js";
import {
  ConcurrencyLimitedTranscriber,
  TeamSpeakSttTtsSpeakerSession
} from "./stt-tts-speaker-session.js";
import { RoutingTranscriber } from "./stt-routing.js";
import { createDefaultSttProviderRegistry } from "./stt-registry.js";
function resolveTeamSpeakWakeNames(params) {
  const configured = resolveTeamSpeakWakeConfig(params.config).wakeNames;
  if (configured) {
    return configured.map((name) => name.trim()).filter((name) => name.length > 0);
  }
  const agentName = params.agentId.trim();
  return agentName && agentName.toLowerCase() !== "openclaw" ? [agentName, "OpenClaw"] : ["OpenClaw"];
}
function createSttTtsLane(params) {
  const env = params.env ?? process.env;
  const registry = params.deps?.sttRegistry ?? createDefaultSttProviderRegistry();
  const transcription = resolveTeamSpeakTranscriptionConfig(params.config);
  const speech = resolveTeamSpeakSpeechConfig(params.config);
  const segmentation = resolveTeamSpeakSegmentationConfig(params.config);
  const wakeConfig = resolveTeamSpeakWakeConfig(params.config);
  const wakeNames = resolveTeamSpeakWakeNames({
    config: params.config,
    agentId: params.agentId
  });
  let primaryTranscriber;
  if (params.deps?.createTranscriber) {
    primaryTranscriber = params.deps.createTranscriber(transcription);
  } else {
    const built = registry.create({
      slot: "primary",
      config: transcription,
      env,
      ...params.log ? { log: params.log } : {}
    });
    if (!built.ok) {
      return { ok: false, reason: `voice.streaming.transcription: ${built.reason}` };
    }
    primaryTranscriber = built.provider;
  }
  const secondary = resolveTeamSpeakSecondaryTranscriptionConfig(params.config);
  let transcriber = primaryTranscriber;
  if (secondary.ok) {
    const built = registry.create({
      slot: "secondary",
      config: secondary.config,
      env,
      ...params.log ? { log: params.log } : {}
    });
    if (built.ok) {
      transcriber = new RoutingTranscriber({
        primary: primaryTranscriber,
        secondary: built.provider,
        config: secondary.routing,
        ...params.log ? { log: params.log } : {}
      });
    } else {
      params.log?.(
        `teamspeak voice: secondary transcription disabled - voice.streaming.secondaryTranscription: ${built.reason} Staying on ${primaryTranscriber.id} only.`
      );
    }
  } else if (secondary.reason) {
    params.log?.(`teamspeak voice: secondary transcription disabled - ${secondary.reason}`);
  }
  transcriber = new ConcurrencyLimitedTranscriber(transcriber, 1, 1, params.log);
  const synthesizer = params.deps?.createSynthesizer?.() ?? new RuntimeSpeechSynthesizer({
    config: speech,
    cfg: params.cfg,
    tts: params.runtime.tts,
    ...params.deps?.removeFile ? { removeFile: params.deps.removeFile } : {},
    ...params.config.tools?.music?.ffmpegPath ? { ffmpegPath: params.config.tools.music.ffmpegPath } : {},
    ...params.log ? { log: params.log } : {}
  });
  const runAgentTurn = params.deps?.runAgentTurn ?? createTeamSpeakAgentTurn({
    agent: params.runtime.agent,
    ...params.runtime.reply ? { reply: params.runtime.reply } : {},
    blockStreaming: params.config.voice?.blockStreaming !== false,
    cfg: params.cfg,
    accountId: params.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...params.config.voice?.model ? { model: params.config.voice.model } : {},
    thinking: params.config.voice?.thinking?.trim() || "off",
    ...params.log ? { log: params.log } : {}
  });
  const agentTurnLabel = {
    model: params.config.voice?.model,
    thinking: params.config.voice?.thinking?.trim() || "off"
  };
  return {
    ok: true,
    lane: {
      transcriberId: transcriber.id,
      speechProviderId: synthesizer.id,
      wakeNames,
      synthesizer,
      createSpeakerSession: (client, playback) => new TeamSpeakSttTtsSpeakerSession({
        client,
        wakeConfig,
        wakeNames,
        segmentation,
        transcriber,
        synthesizer,
        runAgentTurn,
        agentTurnLabel,
        playback,
        humanParticipantCount: params.humanParticipantCount,
        ...params.onTerminalError ? { onTerminalError: params.onTerminalError } : {},
        ...params.log ? { log: params.log } : {}
      })
    }
  };
}
export {
  createSttTtsLane,
  resolveTeamSpeakWakeNames
};
