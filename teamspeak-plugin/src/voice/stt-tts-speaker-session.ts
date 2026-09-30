/**
 * The stt-tts lane: one session per TeamSpeak client (PHA-3228).
 *
 *   bridge `speaker_audio` (48k mono pcm16, per clientId)
 *     -> SpeakerSegmenter (speaker_start/stop + hangover)
 *     -> local whisper.cpp                      [no metered provider]
 *     -> wake-name gate                         [WakeGate, unchanged]
 *     -> OpenClaw agent turn (MiniMax text model)
 *     -> MiniMax T2A via the host TTS runtime
 *     -> 48k pcm16 -> RoomPlaybackQueue -> `voice_audio`
 *
 * This is the same interface `TeamSpeakRealtimeSpeakerSession` implements, so
 * the runtime, the roster manager, the room queue, and the `!vc` / `!sexton`
 * commands are all lane-agnostic and untouched. What changes is the middle:
 * there is no provider session, so endpointing, gating, and turn ordering are
 * this class's job rather than the harness's.
 *
 * The honest limits, from the issue and kept rather than papered over:
 *  - First audio lands in roughly 1.5-3s, not sub-second. Every stage is timed
 *    and logged so `speech-2.8-turbo` versus `-hd` is a measurement, not a guess.
 *  - Barge-in is weaker by construction. `WakeGate.isBargeInEnabled()` keeps its
 *    realtime semantics, but an interrupt can only drop queued audio and retire
 *    the in-flight turn; it cannot truncate a provider mid-utterance, because
 *    there is no provider holding one.
 */
import { matchRealtimeVoiceActivationName } from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceWakeNamePolicy } from "openclaw/plugin-sdk/realtime-voice";
import type { RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";
import type {
  ResolvedTeamSpeakSegmentationConfig,
  TeamSpeakVoiceRealtimeConfig,
} from "../config.js";
import { evaluateFuzzyWakeName } from "./fuzzy-wake.js";
import type { RoomPlaybackQueue } from "./room-playback.js";
import { SpeakerSegmenter, type SpeakerSegment } from "./segmenter.js";
import { SpeechPipeline } from "./speech-pipeline.js";
import type { SpeechSynthesizer } from "./speech.js";
import type {
  SttProvider,
  SttProviderKind,
  SttRequest,
  SttResult,
} from "./stt-provider.js";
import { WakeGate } from "./wake-gate.js";

export type TeamSpeakVoiceAgentTurnHooks = {
  /** Reply text as it streams in, in order (PHA-3792). Optional for a turn to call. */
  onBlock?: ((text: string) => void) | undefined;
};

export type TeamSpeakVoiceAgentTurnOutcome = {
  text: string;
  path?: "block-stream" | "ingress" | undefined;
  blocks?: number | undefined;
};

/**
 * One agent turn: heard text in, speakable text out.
 *
 * A turn may stream: if it calls `hooks.onBlock` the session starts speaking
 * that text immediately, and the returned text is only used for what the
 * blocks did not already cover. A turn that ignores the hooks and returns a
 * plain string (the ingress fallback, and every test double written before
 * PHA-3792) is spoken whole at the end, as before.
 */
export type TeamSpeakVoiceAgentTurn = (
  params: {
    clientId: TeamSpeakClientId;
    nickname: string;
    /** Transcript with any leading/trailing wake name already removed. */
    message: string;
    /** The wake name that opened the gate, when one was required. */
    wakeName?: string;
    /** Opened by the follow-up window, not by the name (PHA-3829). */
    followUp?: boolean;
  },
  hooks: TeamSpeakVoiceAgentTurnHooks,
) => Promise<string | TeamSpeakVoiceAgentTurnOutcome>;

export type TeamSpeakSttTtsSessionParams = {
  client: RosterEntry;
  /** requireWakeName / wakeNames / bargeIn, already folded from voice + voice.realtime. */
  wakeConfig: TeamSpeakVoiceRealtimeConfig;
  /** Wake names to accept once the gate is active. Empty disables matching. */
  wakeNames: string[];
  segmentation: ResolvedTeamSpeakSegmentationConfig;
  transcriber: SttProvider;
  synthesizer: SpeechSynthesizer;
  runAgentTurn: TeamSpeakVoiceAgentTurn;
  /**
   * Model and thinking level the turn ran with, for the per-turn log line
   * only (PHA-3789). Not the actual model selected by fallback/rotation --
   * `runCommandFromIngress` does not return that to the ingress caller, only
   * `payloads`. Labeled "requested" in the log for that reason.
   */
  agentTurnLabel?: { model?: string | undefined; thinking?: string | undefined } | undefined;
  playback: RoomPlaybackQueue;
  humanParticipantCount: () => number;
  onTerminalError?: ((error: Error) => void) | undefined;
  now?: (() => number) | undefined;
  setTimeoutFn?: ((handler: () => void, ms: number) => unknown) | undefined;
  clearTimeoutFn?: ((handle: unknown) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

/** Latency breakdown for one heard utterance, in milliseconds. */
export type TeamSpeakVoiceTurnTimings = {
  segmentMs: number;
  sttMs: number;
  agentMs: number;
  ttsMs: number;
  /** Segment close -> first audio frame handed to the bridge. The budget. */
  firstAudioMs: number;
};

/**
 * How long the conversation stays open after the last thing was said.
 *
 * Brandon, PHA-3428: "it's like a real conversation, wake on his name, wait 3-5
 * seconds max of silence before ending it. Anything past that is awkward dead
 * air." So this is a *silence* budget, not a window from the reply: it is
 * measured from the moment the bot's own speech finishes playing to the moment
 * the speaker starts their next burst. Waiting politely for a long answer to
 * play out does not spend it, and a long follow-up question does not either --
 * only actual dead air does.
 *
 * Was off by default (Brandon, PHA-3428 2026-09-13: "HE LISTENS FOR HIS NAME
 * ONLY"). Reversed in PHA-3783 (2026-09-24): with the window shut, nobody could
 * answer the bot's own question without saying the name again, and it "just
 * doesn't respond". 15 s of dead air after our speech ends is the default now;
 * `voice.followUpSilenceMs: 0` shuts it again for a bot that must be name-only.
 */
export const DEFAULT_FOLLOW_UP_SILENCE_MS = 15_000;

/**
 * Nameless follow-ups in a row before the name is needed again (PHA-3829).
 * Each answer re-armed the window, so one "henchman" bought a bot two
 * straight minutes of replying to every line one person said.
 */
export const MAX_CONSECUTIVE_FOLLOW_UPS = 3;

export class TeamSpeakSttTtsSpeakerSession {
  readonly clientId: TeamSpeakClientId;
  private nickname: string;
  private status: "inactive" | "active" | "stopped" = "inactive";
  private readonly gate: WakeGate;
  private readonly segmenter: SpeakerSegmenter;
  private readonly now: () => number;
  /** Serializes turns: two answers on one lane would be summed into noise. */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by barge-in and close, so a turn that finishes late stays silent. */
  private generation = 0;
  private lastTimings: TeamSpeakVoiceTurnTimings | undefined;
  /** When the bot's last answer finishes playing; dead air is counted from here. */
  private conversationIdleFrom: number | undefined;
  /** Nameless follow-ups answered since the name was last said. */
  private consecutiveFollowUps = 0;
  /** What whisper called the wake name on the last fuzzy match, for the log. */
  private lastFuzzyHearing: string | undefined;
  /** The other bot's name that claimed the last declined hearing, for the log (PHA-3605). */
  private lastExcludedBy: string | undefined;

  constructor(private readonly params: TeamSpeakSttTtsSessionParams) {
    this.clientId = params.client.clientId;
    this.nickname = params.client.nickname;
    this.now = params.now ?? (() => Date.now());
    this.gate = new WakeGate({
      wakeNamePolicy: () => resolveSttTtsWakeNamePolicy(params.wakeConfig.requireWakeName),
      humanParticipantCount: () => this.params.humanParticipantCount(),
      realtimeConfig: () => this.params.wakeConfig,
      // There is no realtime provider here, so barge-in has no provider-keyed
      // `interruptResponseOnInputAudio` to read; the configured value decides.
      providerId: () => undefined,
    });
    this.segmenter = new SpeakerSegmenter({
      hangoverMs: params.segmentation.hangoverMs,
      minSegmentMs: params.segmentation.minSegmentMs,
      maxSegmentMs: params.segmentation.maxSegmentMs,
      onSegment: (segment) => this.enqueueTurn(segment),
      onDropped: (durationMs) =>
        this.params.log?.(
          `teamspeak voice: segment dropped as too short clientId=${this.clientId} durationMs=${Math.round(durationMs)} minSegmentMs=${params.segmentation.minSegmentMs}`,
        ),
      ...(params.now ? { now: params.now } : {}),
      ...(params.setTimeoutFn ? { setTimeoutFn: params.setTimeoutFn } : {}),
      ...(params.clearTimeoutFn ? { clearTimeoutFn: params.clearTimeoutFn } : {}),
    });
  }

  /** Room playback key: the clientId owns the lane, not the nickname. */
  get playbackOwnerKey(): string {
    return `client:${this.clientId}`;
  }

  get label(): string {
    return this.nickname;
  }

  get wakeNameRequired(): boolean {
    return this.gate.isWakeNameRequired();
  }

  get bargeInEnabled(): boolean {
    return this.gate.isBargeInEnabled();
  }

  /** The last completed turn's latency breakdown; the budget's evidence. */
  get timings(): TeamSpeakVoiceTurnTimings | undefined {
    return this.lastTimings;
  }

  relabel(nickname: string): void {
    this.nickname = nickname;
  }

  /**
   * No provider session to open. The lane is a request/response pipeline that
   * exists as soon as its parts are constructed, so this only reports the
   * configuration it will run with — the line an operator reads to confirm the
   * mic is going nowhere.
   */
  async connect(): Promise<void> {
    if (this.status === "stopped") {
      return;
    }
    this.status = "active";
    this.params.log?.(
      `teamspeak voice: stt-tts session ready clientId=${this.clientId} nickname=${this.nickname} ` +
        `transcription=${this.params.transcriber.id} speech=${this.params.synthesizer.id} ` +
        `requireWakeName=${this.wakeNameRequired} wakeNames=${this.params.wakeNames.join(",") || "none"} ` +
        `wakeAliases=${this.params.wakeConfig.wakeAliases?.join(",") || "none"} excludeWakeNames=${this.params.wakeConfig.excludeWakeNames?.join(",") || "none"} ` +
        `bargeIn=${this.bargeInEnabled} humanParticipants=${this.params.humanParticipantCount()}`,
    );
  }

  /** Bridge `speaker_audio` for this client -> the open segment. */
  sendInputAudio(pcm48kMono: Buffer): void {
    if (this.isStopped()) {
      return;
    }
    this.segmenter.appendAudio(pcm48kMono);
  }

  /**
   * A human started talking.
   *
   * Two jobs at once: reopen this speaker's segment (cancelling a pending
   * hangover close), and interrupt playback if the gate allows it. Only the
   * session that owns the room lane can interrupt, which is why the runtime
   * asks each session rather than broadcasting.
   */
  handleSpeakerStart(reason = "speaker-start"): boolean {
    if (this.isStopped()) {
      return false;
    }
    this.segmenter.handleSpeakerStart();
    if (!this.bargeInEnabled) {
      return false;
    }
    if (this.params.playback.activeOwner !== this.playbackOwnerKey) {
      return false;
    }
    const interrupted = this.params.playback.handleBargeIn(reason);
    if (interrupted) {
      // The queue is drained, but a turn may still be mid-synthesis. Retire it
      // rather than letting its audio arrive after the interruption.
      this.generation += 1;
    }
    return interrupted;
  }

  /** The speaker stopped; arm the hangover that closes the segment. */
  handleSpeakerStop(): void {
    if (this.isStopped()) {
      return;
    }
    this.segmenter.handleSpeakerStop();
  }

  /** Close the follow-up window; the next answer needs our name (PHA-3829). */
  endFollowUp(reason: string): void {
    if (this.conversationIdleFrom === undefined) {
      return;
    }
    this.conversationIdleFrom = undefined;
    this.consecutiveFollowUps = 0;
    this.params.log?.(
      `teamspeak voice: follow-up window closed clientId=${this.clientId} reason=${reason}`,
    );
  }

  close(reason: string): void {
    if (this.status === "stopped") {
      return;
    }
    this.status = "stopped";
    this.generation += 1;
    this.segmenter.close();
    this.params.playback.release(this.playbackOwnerKey);
    this.params.log?.(
      `teamspeak voice: stt-tts session closed clientId=${this.clientId} reason=${reason}`,
    );
  }

  private isStopped(): boolean {
    return this.status === "stopped";
  }

  private enqueueTurn(segment: SpeakerSegment): void {
    const generation = this.generation;
    // Transcription starts the moment the segment closes, NOT when the queue
    // frees up (PHA-3789 latency pass). STT has no side effects on the lane,
    // so it does not need the serialization the agent turn and playback do.
    // Without this, a speaker who talks again while the previous answer is
    // still synthesizing its trailing chunks pays the full sttMs on top of
    // that wait -- the 2-3s of unexplained firstAudioMs seen in live logs.
    const sttStartedAt = this.now();
    const transcription = this.params.transcriber
      .transcribe({
        pcm48kMono: segment.pcm48kMono,
        label: this.nickname,
        durationMs: segment.durationMs,
        clientId: this.clientId,
      })
      // `heard.ms` is the provider's own time; `sttMs` is what this lane waited,
      // which includes any queue wait inside the concurrency limiter. They are
      // the same number on a quiet channel and diverge under load, so both are
      // kept rather than one standing in for the other.
      .then((heard) => ({ heard, sttMs: this.now() - sttStartedAt }));
    // A rejection is handled inside runTurn (awaited there); this keeps the
    // pre-queue promise from reporting as unhandled while it waits its turn.
    transcription.catch(() => undefined);
    this.queue = this.queue
      .then(() => this.runTurn(segment, generation, transcription))
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // One failed turn is not a dead session: whisper or MiniMax being
        // briefly unreachable should cost this utterance, not the channel.
        this.params.log?.(
          `teamspeak voice: stt-tts turn failed clientId=${this.clientId}: ${failure.message}`,
        );
        this.params.onTerminalError?.(failure);
      });
  }

  private async runTurn(
    segment: SpeakerSegment,
    generation: number,
    transcription: Promise<{ heard: SttResult; sttMs: number }>,
  ): Promise<void> {
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    // How long this segment sat behind the previous turn before its own work
    // could start. Zero on a quiet lane; the number to watch when a speaker
    // chains utterances.
    const queueWaitMs = this.now() - segment.closedAt;
    const { heard, sttMs } = await transcription;
    const transcript = heard.text;
    const sttProvider = heard.provider;
    // Absent unless the provider was asked for a score; see `whisper-local.ts`
    // for what that costs.
    const sttConfidence =
      heard.confidence === undefined ? "" : ` sttConfidence=${heard.confidence.toFixed(2)}`;
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    if (!transcript) {
      this.params.log?.(
        `teamspeak voice: empty transcript clientId=${this.clientId} segmentMs=${Math.round(segment.durationMs)} sttMs=${Math.round(sttMs)} sttProvider=${sttProvider}${sttConfidence}`,
      );
      return;
    }

    const gated = this.applyWakeGate(transcript, segment);
    if (!gated) {
      this.params.log?.(
        `teamspeak voice: wake gate declined clientId=${this.clientId} humanParticipants=${this.params.humanParticipantCount()} wakeNames=${this.params.wakeNames.join(",") || "none"}${this.lastExcludedBy ? ` excludedBy=${JSON.stringify(this.lastExcludedBy)}` : ""} heard=${JSON.stringify(transcript.slice(0, 160))}`,
      );
      return;
    }

    // Speech starts before the agent turn ends (PHA-3792). The pipeline is
    // built first so a block that arrives mid-generation has somewhere to go;
    // it synthesizes in order with one call prefetched ahead of playback
    // (PHA-3789) and puts frames on the room queue as each chunk lands. A
    // turn that does not stream (ingress fallback, older doubles) delivers
    // nothing through `onBlock`, and its returned text is pushed whole below
    // -- the pre-PHA-3792 behavior, unchanged.
    const isLive = () => !this.isStopped() && generation === this.generation;
    // A nameless follow-up doesn't start on top of another bot (PHA-3829).
    // Named turns still speak: they asked for us.
    const isFollowUp = this.wakeNameRequired && !gated.wakeName;
    let yieldedToOtherBot = false;
    const mayStartSpeaking = () => {
      if (!yieldedToOtherBot && isFollowUp && firstBlockAt === undefined && this.params.playback.otherBotSpeaking) {
        yieldedToOtherBot = true;
        this.params.log?.(
          `teamspeak voice: follow-up answer dropped, another bot is talking clientId=${this.clientId}`,
        );
      }
      return !yieldedToOtherBot;
    };
    const pipeline = new SpeechPipeline({
      synthesizer: this.params.synthesizer,
      playback: this.params.playback,
      ownerKey: this.playbackOwnerKey,
      isLive,
      now: this.now,
      ...(this.params.log ? { log: this.params.log } : {}),
    });
    let streamedText = "";
    let firstBlockAt: number | undefined;
    const agentStartedAt = this.now();
    let outcome: TeamSpeakVoiceAgentTurnOutcome;
    try {
      const raw = await this.params.runAgentTurn(
        {
          clientId: this.clientId,
          nickname: this.nickname,
          message: gated.message,
          ...(gated.wakeName ? { wakeName: gated.wakeName } : {}),
          ...(isFollowUp ? { followUp: true } : {}),
        },
        {
          onBlock: (text) => {
            if (!isLive() || !mayStartSpeaking()) {
              return;
            }
            firstBlockAt ??= this.now();
            streamedText += text;
            pipeline.push(text);
          },
        },
      );
      outcome = typeof raw === "string" ? { text: raw } : raw;
    } catch (error) {
      // Let the pipeline drain what it already has before failing the turn;
      // a block that was spoken should not be cut off by the model's error.
      await pipeline.finish();
      this.params.playback.release(this.playbackOwnerKey);
      throw error;
    }
    const agentMs = this.now() - agentStartedAt;
    if (isLive() && mayStartSpeaking()) {
      const reply = outcome.text.trim();
      if (!streamedText) {
        if (reply) {
          pipeline.push(reply);
        }
      } else if (reply.replace(/\s+/g, "") !== streamedText.replace(/\s+/g, "")) {
        // The blocks and the returned text disagree; the returned text is the
        // fuller record (an aborted stream falls back to a final payload
        // there), so speak whatever the blocks did not already cover.
        const tail = reply.startsWith(streamedText) ? reply.slice(streamedText.length).trim() : "";
        if (tail) {
          pipeline.push(tail);
        } else if (!reply.startsWith(streamedText)) {
          this.params.log?.(
            `teamspeak voice: streamed blocks and final reply differ clientId=${this.clientId} streamedChars=${streamedText.length} replyChars=${reply.length}; keeping the streamed blocks`,
          );
        }
      }
    }
    const speech = await pipeline.finish();
    // The utterance is complete the moment the last chunk is queued: unlike a
    // realtime provider there is no later "response done" event to wait for,
    // and holding the lane past the last frame would block the next speaker
    // for nothing.
    this.params.playback.release(this.playbackOwnerKey);
    if (!isLive()) {
      return;
    }
    if (speech.error !== undefined) {
      throw new Error(`speech synthesis failed: ${speech.error}`);
    }
    if (speech.totalChunks === 0) {
      this.params.log?.(
        `teamspeak voice: agent turn produced nothing speakable clientId=${this.clientId} agentMs=${Math.round(agentMs)} path=${outcome.path ?? "unknown"}`,
      );
      return;
    }
    if (speech.spokenChunks === 0) {
      return;
    }

    // Stamped at the *end* of our own speech, not the start: the speaker is
    // silent while the answer plays, and that silence is not dead air.
    this.conversationIdleFrom = this.now() + speech.totalAudioMs;
    this.lastTimings = {
      segmentMs: Math.round(segment.durationMs),
      sttMs: Math.round(sttMs),
      agentMs: Math.round(agentMs),
      ttsMs: Math.round(speech.firstChunkTtsMs ?? 0),
      firstAudioMs: Math.round((speech.firstAudioAt ?? this.now()) - segment.closedAt),
    };
    // How long into the agent turn the first block landed: the number that
    // shows the streaming win, since ttsMs now starts here rather than after
    // agentMs. Equal to agentMs on a turn that did not stream.
    const firstBlockMs = Math.round((firstBlockAt ?? agentStartedAt + agentMs) - agentStartedAt);
    const requestedModel = this.params.agentTurnLabel?.model ?? "default";
    const requestedThinking = this.params.agentTurnLabel?.thinking ?? "default";
    this.params.log?.(
      `teamspeak voice: stt-tts turn clientId=${this.clientId} nickname=${this.nickname} ` +
        `segmentMs=${this.lastTimings.segmentMs} queueWaitMs=${Math.round(queueWaitMs)} sttMs=${this.lastTimings.sttMs} ` +
        `agentMs=${this.lastTimings.agentMs} firstBlockMs=${firstBlockMs} ttsMs=${this.lastTimings.ttsMs} ` +
        `firstAudioMs=${this.lastTimings.firstAudioMs} ttsChunks=${speech.spokenChunks}/${speech.totalChunks} ` +
        `replyPath=${outcome.path ?? "unknown"} blocks=${outcome.blocks ?? 0} ` +
        `sttProvider=${sttProvider}${sttConfidence} sttMsProvider=${Math.round(heard.ms)} ` +
        `speechProvider=${speech.speechProvider ?? this.params.synthesizer.id} ` +
        // No prompt/output token counts or cost here: neither reply path
        // returns usage to the caller (PHA-3789 finding, see
        // TOOL-CATALOG.md §4.6). requestedModel/Thinking are the ask, not
        // necessarily what the host actually ran.
        `requestedModel=${requestedModel} requestedThinking=${requestedThinking}${this.lastFuzzyHearing ? ` wakeHeardAs=${JSON.stringify(this.lastFuzzyHearing)}` : ""}`,
    );
  }

  /**
   * Apply the wake gate to a transcript.
   *
   * The realtime lane hands wake names to a provider that gates activation
   * itself. Here the gate is text: the SDK's own activation-name matcher, which
   * accepts a leading or trailing name, tolerates the fuzzy hearings whisper
   * produces, and returns the transcript with the name removed so the agent is
   * not asked to answer "Sexton" as if it were the question.
   */
  private applyWakeGate(
    transcript: string,
    segment: SpeakerSegment,
  ): { message: string; wakeName?: string } | undefined {
    if (!this.wakeNameRequired) {
      return { message: transcript };
    }
    const wakeNames = this.params.wakeNames;
    if (wakeNames.length === 0) {
      // The gate is on and nothing can open it. Refusing is the safe reading:
      // the alternative answers everyone in a room that asked for a gate.
      return undefined;
    }
    this.lastExcludedBy = undefined;
    const matched = matchRealtimeVoiceActivationName(transcript, wakeNames);
    if (matched) {
      this.lastFuzzyHearing = undefined;
      this.consecutiveFollowUps = 0;
      const message = matched.text.trim() || transcript.trim();
      return { message, wakeName: matched.activationName };
    }
    // The SDK matcher wants the name at the head or tail, spelled as configured.
    // Local whisper gives neither reliably, so try a normalized edit-distance
    // match over every word and adjacent word pair before declining.
    const evaluated = evaluateFuzzyWakeName(transcript, wakeNames, {
      aliases: this.params.wakeConfig.wakeAliases,
      excludeNames: this.params.wakeConfig.excludeWakeNames,
    });
    const fuzzy = evaluated.match;
    if (fuzzy) {
      this.lastFuzzyHearing = fuzzy.heardAs;
      this.consecutiveFollowUps = 0;
      const message = fuzzy.text.trim() || transcript.trim();
      return { message, wakeName: fuzzy.activationName };
    }
    this.lastFuzzyHearing = undefined;
    // The other bot's name, or close enough to it: theirs to answer, not ours,
    // and not a follow-up either -- they said who they meant.
    if (evaluated.excludedBy) {
      this.lastExcludedBy = evaluated.excludedBy;
      this.endFollowUp(`named-other-bot:${evaluated.excludedBy}`);
      return undefined;
    }
    // Follow-up: they said the name a moment ago, we answered, and they came
    // straight back. Dead air is measured from the end of our answer to the
    // start of their burst -- not to now(), which would also charge them for
    // however long they spoke and however long whisper took to hear it.
    const followUpSilenceMs =
      this.params.wakeConfig.followUpSilenceMs ?? DEFAULT_FOLLOW_UP_SILENCE_MS;
    if (followUpSilenceMs <= 0) {
      return undefined;
    }
    const idleFrom = this.conversationIdleFrom;
    if (idleFrom !== undefined && segment.startedAt - idleFrom <= followUpSilenceMs) {
      if (this.consecutiveFollowUps >= MAX_CONSECUTIVE_FOLLOW_UPS) {
        this.endFollowUp("follow-up-limit");
        return undefined;
      }
      this.consecutiveFollowUps += 1;
      return { message: transcript };
    }
    return undefined;
  }
}

/**
 * Wake-name policy for a lane with no provider.
 *
 * `resolveRealtimeVoiceSessionPolicy` forces "never" whenever the provider
 * cannot gate on activation names, which is always true here — so calling it
 * would silently disable the gate this lane is required to have. The three-way
 * choice it makes for a capable provider is reproduced directly instead.
 */
export function resolveSttTtsWakeNamePolicy(
  requireWakeName: boolean | undefined,
): RealtimeVoiceWakeNamePolicy {
  if (requireWakeName === true) {
    return "always";
  }
  if (requireWakeName === false) {
    return "never";
  }
  return "automatic";
}

/**
 * Caps whisper requests to what the server can actually run at once (PHA-3607).
 *
 * whisper.cpp's server has no request-level parallelism — one process, one
 * mutex, one decode slot per bot (see the pool doc) — so letting every
 * concurrent speaker submit independently does not run them in parallel, it
 * only stacks each one behind a full `timeoutMs` wait apiece (the PHA-3597
 * decode/abort/resubmit livelock: several people talking at once queue up
 * requests that each eventually time out in turn instead of finishing sooner).
 *
 * One instance is shared by every `TeamSpeakSttTtsSpeakerSession` on an
 * account (wired in `stt-tts-lane.ts`), so the limit is per-bot, not
 * per-speaker. A segment that arrives while the queue is already full evicts
 * whichever segment was waiting longest: it can only be staler than the new
 * one, and evicting it immediately (an empty transcript, same as silence)
 * costs nothing next to leaving it to time out on its own turn.
 */
export class ConcurrencyLimitedTranscriber implements SttProvider {
  readonly id: string;
  readonly kind: SttProviderKind;
  private inFlight = 0;
  private readonly waiting: Array<(proceed: boolean) => void> = [];

  constructor(
    private readonly inner: SttProvider,
    private readonly maxInFlight = 1,
    private readonly maxQueueDepth = 1,
    private readonly log?: (message: string) => void,
  ) {
    this.id = inner.id;
    this.kind = inner.kind;
  }

  isBackedOff(): boolean {
    return this.inner.isBackedOff?.() ?? false;
  }

  backoffRemainingMs(): number {
    return this.inner.backoffRemainingMs?.() ?? 0;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (this.inFlight >= this.maxInFlight) {
      if (this.waiting.length >= this.maxQueueDepth) {
        const evicted = this.waiting.shift();
        this.log?.(
          `teamspeak voice: stt queue full, dropping oldest queued segment label=${request.label} inFlight=${this.inFlight} queueDepth=${this.waiting.length}`,
        );
        evicted?.(false);
      }
      const proceed = await new Promise<boolean>((resolve) => {
        this.waiting.push(resolve);
      });
      if (!proceed) {
        return { text: "", provider: this.id, ms: 0 };
      }
    }
    this.inFlight += 1;
    try {
      // The inner result passes through untouched: its `ms` is provider time,
      // and the queue wait ahead of it is already reported separately as
      // `queueWaitMs`. Folding the two together would hide which one grew.
      return await this.inner.transcribe(request);
    } finally {
      this.inFlight -= 1;
      const next = this.waiting.shift();
      next?.(true);
    }
  }
}
