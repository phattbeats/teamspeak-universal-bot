/**
 * Assembles the stt-tts lane from account config (PHA-3228).
 *
 * `channel.ts` stays a registration seam: this is where the lane's parts are
 * chosen and refused. Refusal matters as much as construction here — the lane's
 * whole premise is that no metered per-minute provider appears anywhere in the
 * path, and the only place that can be enforced is at the point the transcriber
 * is built.
 *
 * Known v1 gap, stated rather than hidden: the realtime tools from PHA-3176
 * (`play_music`, `what_did_i_miss`, `who_is_here`, `poke`) are registered on a
 * *provider session*, and this lane has none. Voice turns here reach the agent's
 * ordinary tool surface instead. `!vc` / `!sexton` chat commands are unaffected;
 * they are handled by the runtime, not the session.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RosterEntry } from "../bridge/protocol.js";
import {
  resolveTeamSpeakSecondaryTranscriptionConfig,
  resolveTeamSpeakSegmentationConfig,
  resolveTeamSpeakSpeechConfig,
  resolveTeamSpeakTranscriptionConfig,
  resolveTeamSpeakWakeConfig,
  type ResolvedTeamSpeakTranscriptionConfig,
  type TeamSpeakAccountConfig,
} from "../config.js";
import { createTeamSpeakAgentTurn, type TeamSpeakAgentRuntime } from "./agent-turn.js";
import type { RoomPlaybackQueue } from "./room-playback.js";
import {
  RuntimeSpeechSynthesizer,
  type SpeechSynthesizer,
  type TeamSpeakTtsRuntime,
} from "./speech.js";
import {
  ConcurrencyLimitedTranscriber,
  TeamSpeakSttTtsSpeakerSession,
  type TeamSpeakVoiceAgentTurn,
} from "./stt-tts-speaker-session.js";
import { MiniMaxAsrTranscriber } from "./minimax-asr.js";
import { RoutingTranscriber } from "./stt-routing.js";
import { LocalWhisperTranscriber, type SegmentTranscriber } from "./whisper-local.js";

/** Injectable seams; production leaves these unset. */
export type SttTtsLaneDeps = {
  createTranscriber?:
    | ((config: ResolvedTeamSpeakTranscriptionConfig) => SegmentTranscriber)
    | undefined;
  createSynthesizer?: (() => SpeechSynthesizer) | undefined;
  runAgentTurn?: TeamSpeakVoiceAgentTurn | undefined;
  removeFile?: ((path: string) => Promise<void> | void) | undefined;
};

export type SttTtsLaneParams = {
  cfg: OpenClawConfig;
  config: TeamSpeakAccountConfig;
  accountId: string;
  agentId: string;
  sessionKey: string;
  /** `runtime.agent` and `runtime.tts` from the host PluginRuntime. */
  runtime: { agent: TeamSpeakAgentRuntime; tts: TeamSpeakTtsRuntime };
  humanParticipantCount: () => number;
  onTerminalError?: ((error: Error) => void) | undefined;
  log?: ((message: string) => void) | undefined;
  env?: Record<string, string | undefined> | undefined;
  deps?: SttTtsLaneDeps | undefined;
};

export type SttTtsLane = {
  transcriberId: string;
  speechProviderId: string;
  wakeNames: string[];
  /** The lane's own TTS, for lines the runtime says on its own behalf (PHA-3554). */
  synthesizer: SpeechSynthesizer;
  createSpeakerSession: (
    client: RosterEntry,
    playback: RoomPlaybackQueue,
  ) => TeamSpeakSttTtsSpeakerSession;
};

/**
 * Wake names, defaulting to the routed agent name plus "OpenClaw".
 *
 * The SDK's own default is the same pair, but it is only reachable through
 * `resolveRealtimeVoiceSessionPolicy`, which forces the gate off entirely for a
 * provider that cannot gate on activation names — i.e. always, here. So the
 * default is reproduced rather than borrowed.
 */
export function resolveTeamSpeakWakeNames(params: {
  config: TeamSpeakAccountConfig;
  agentId: string;
}): string[] {
  const configured = resolveTeamSpeakWakeConfig(params.config).wakeNames;
  if (configured) {
    return configured.map((name) => name.trim()).filter((name) => name.length > 0);
  }
  const agentName = params.agentId.trim();
  return agentName && agentName.toLowerCase() !== "openclaw"
    ? [agentName, "OpenClaw"]
    : ["OpenClaw"];
}

/**
 * Build the lane, or explain why it cannot run.
 *
 * The failure is a value, not an exception: `startTeamSpeakVoiceRuntime` reports
 * an unstartable account with a warning and no runtime, and a lane that refuses
 * a hosted transcriber should look the same to an operator as a missing
 * bridgeUrl does.
 */
export function createSttTtsLane(
  params: SttTtsLaneParams,
): { ok: true; lane: SttTtsLane } | { ok: false; reason: string } {
  const transcription = resolveTeamSpeakTranscriptionConfig(params.config, params.env);
  if (!transcription.ok) {
    return transcription;
  }
  const speech = resolveTeamSpeakSpeechConfig(params.config);
  const segmentation = resolveTeamSpeakSegmentationConfig(params.config);
  const wakeConfig = resolveTeamSpeakWakeConfig(params.config);
  const wakeNames = resolveTeamSpeakWakeNames({
    config: params.config,
    agentId: params.agentId,
  });

  const primaryTranscriber =
    params.deps?.createTranscriber?.(transcription.config) ??
    new LocalWhisperTranscriber({
      config: transcription.config,
      ...(params.log ? { log: params.log } : {}),
    });

  // The hosted second opinion (PHA-3428 item 3). Absent unless configured, and
  // a misconfiguration warns rather than refusing to start: whisper on its own
  // is a complete transcriber, so losing the upgrade must not lose the lane.
  const secondary = resolveTeamSpeakSecondaryTranscriptionConfig(params.config, params.env);
  let transcriber: SegmentTranscriber = primaryTranscriber;
  if (secondary.ok) {
    transcriber = new RoutingTranscriber({
      primary: primaryTranscriber,
      secondary: new MiniMaxAsrTranscriber({
        config: secondary.config,
        ...(params.log ? { log: params.log } : {}),
      }),
      config: secondary.routing,
      ...(params.log ? { log: params.log } : {}),
    });
  } else if (secondary.reason) {
    params.log?.(`teamspeak voice: secondary transcription disabled - ${secondary.reason}`);
  }
  // Shared by every speaker session this account opens, so the in-flight cap
  // is per-bot: whisper.cpp's own decode slot is one process, shared the same
  // way (PHA-3607).
  transcriber = new ConcurrencyLimitedTranscriber(transcriber, 1, 1, params.log);
  const synthesizer =
    params.deps?.createSynthesizer?.() ??
    new RuntimeSpeechSynthesizer({
      config: speech,
      cfg: params.cfg,
      tts: params.runtime.tts,
      ...(params.deps?.removeFile ? { removeFile: params.deps.removeFile } : {}),
      ...(params.config.tools?.music?.ffmpegPath
        ? { ffmpegPath: params.config.tools.music.ffmpegPath }
        : {}),
      ...(params.log ? { log: params.log } : {}),
    });
  const runAgentTurn =
    params.deps?.runAgentTurn ??
    createTeamSpeakAgentTurn({
      agent: params.runtime.agent,
      cfg: params.cfg,
      accountId: params.accountId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ...(params.config.voice?.model ? { model: params.config.voice.model } : {}),
      ...(params.log ? { log: params.log } : {}),
    });

  return {
    ok: true,
    lane: {
      transcriberId: transcriber.id,
      speechProviderId: synthesizer.id,
      wakeNames,
      synthesizer,
      createSpeakerSession: (client, playback) =>
        new TeamSpeakSttTtsSpeakerSession({
          client,
          wakeConfig,
          wakeNames,
          segmentation,
          transcriber,
          synthesizer,
          runAgentTurn,
          playback,
          humanParticipantCount: params.humanParticipantCount,
          ...(params.onTerminalError ? { onTerminalError: params.onTerminalError } : {}),
          ...(params.log ? { log: params.log } : {}),
        }),
    },
  };
}
