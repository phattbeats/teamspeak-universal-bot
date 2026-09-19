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
import { bridgePcmDurationMs, chunkBridgePcm } from "./audio.js";
import { evaluateFuzzyWakeName } from "./fuzzy-wake.js";
import type { RoomPlaybackQueue } from "./room-playback.js";
import { SpeakerSegmenter, type SpeakerSegment } from "./segmenter.js";
import { splitIntoSpeechChunks, type SpeechSynthesizer } from "./speech.js";
import type { SegmentTranscriber, TranscriptionRequest } from "./whisper-local.js";
import { WakeGate } from "./wake-gate.js";

/** One agent turn: heard text in, speakable text out. */
export type TeamSpeakVoiceAgentTurn = (params: {
  clientId: TeamSpeakClientId;
  nickname: string;
  /** Transcript with any leading/trailing wake name already removed. */
  message: string;
  /** The wake name that opened the gate, when one was required. */
  wakeName?: string;
}) => Promise<string>;

export type TeamSpeakSttTtsSessionParams = {
  client: RosterEntry;
  /** requireWakeName / wakeNames / bargeIn, already folded from voice + voice.realtime. */
  wakeConfig: TeamSpeakVoiceRealtimeConfig;
  /** Wake names to accept once the gate is active. Empty disables matching. */
  wakeNames: string[];
  segmentation: ResolvedTeamSpeakSegmentationConfig;
  transcriber: SegmentTranscriber;
  synthesizer: SpeechSynthesizer;
  runAgentTurn: TeamSpeakVoiceAgentTurn;
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
 * Off by default. Brandon, PHA-3428 2026-09-13: "HE LISTENS FOR HIS NAME ONLY."
 * A follow-up window is, by construction, a turn that answers without the name,
 * so it stays shut unless `voice.followUpSilenceMs` turns it back on.
 */
const DEFAULT_FOLLOW_UP_SILENCE_MS = 0;

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
    this.queue = this.queue
      .then(() => this.runTurn(segment, generation))
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

  private async runTurn(segment: SpeakerSegment, generation: number): Promise<void> {
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    const sttStartedAt = this.now();
    const heard = await transcribeSegment(this.params.transcriber, {
      pcm48kMono: segment.pcm48kMono,
      label: this.nickname,
      durationMs: segment.durationMs,
      clientId: this.clientId,
    });
    const transcript = heard.text;
    const sttProvider = heard.provider;
    const sttMs = this.now() - sttStartedAt;
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    if (!transcript) {
      this.params.log?.(
        `teamspeak voice: empty transcript clientId=${this.clientId} segmentMs=${Math.round(segment.durationMs)} sttMs=${Math.round(sttMs)} sttProvider=${sttProvider}`,
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

    const agentStartedAt = this.now();
    const reply = await this.params.runAgentTurn({
      clientId: this.clientId,
      nickname: this.nickname,
      message: gated.message,
      ...(gated.wakeName ? { wakeName: gated.wakeName } : {}),
    });
    const agentMs = this.now() - agentStartedAt;
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    if (!reply.trim()) {
      this.params.log?.(
        `teamspeak voice: agent turn produced nothing speakable clientId=${this.clientId} agentMs=${Math.round(agentMs)}`,
      );
      return;
    }

    // Pipelined synthesis (PHA-3607, "streaming TTS"): one T2A call per
    // sentence instead of one for the whole reply, so playback of sentence one
    // starts while sentence two is still being synthesized. There is no host
    // support for token-level streaming synthesis (see speech.ts), so this is
    // the honest version of it -- real first-audio win, at the cost of a
    // little more *total* synthesis time on a multi-sentence reply.
    const chunks = splitIntoSpeechChunks(reply);
    let firstChunkTtsMs: number | undefined;
    let firstAudioMs: number | undefined;
    let speechProvider: string | undefined;
    let totalAudioMs = 0;
    let spokenChunks = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkStartedAt = this.now();
      const chunkSpeech = await this.params.synthesizer.synthesize(chunks[index] as string);
      const chunkTtsMs = this.now() - chunkStartedAt;
      if (index === 0) {
        firstChunkTtsMs = chunkTtsMs;
      }
      if (this.isStopped() || generation !== this.generation) {
        return;
      }
      if (chunkSpeech.status === "empty") {
        continue;
      }
      if (chunkSpeech.status === "failed") {
        // The first chunk failing fails the turn, same as the old one-call
        // behavior. A later chunk failing does not retroactively fail a turn
        // that already spoke something -- stop here and keep what played.
        if (spokenChunks === 0) {
          throw new Error(`speech synthesis failed: ${chunkSpeech.error}`);
        }
        this.params.log?.(
          `teamspeak voice: speech chunk failed clientId=${this.clientId} chunk=${index + 1}/${chunks.length}: ${chunkSpeech.error}`,
        );
        break;
      }
      for (const frame of chunkBridgePcm(chunkSpeech.pcm48kMono)) {
        this.params.playback.enqueue(this.playbackOwnerKey, frame);
      }
      spokenChunks += 1;
      totalAudioMs += bridgePcmDurationMs(chunkSpeech.pcm48kMono);
      speechProvider ??= chunkSpeech.provider;
      // The moment this fires is the real "first audio" instant: the bridge
      // starts streaming these frames out while later chunks are still being
      // synthesized, so this must be stamped here, not after the whole loop.
      firstAudioMs ??= Math.round(this.now() - segment.closedAt);
    }
    // The utterance is complete the moment the last chunk is queued: unlike a
    // realtime provider there is no later "response done" event to wait for,
    // and holding the lane past the last frame would block the next speaker
    // for nothing.
    this.params.playback.release(this.playbackOwnerKey);
    if (spokenChunks === 0) {
      return;
    }

    // Stamped at the *end* of our own speech, not the start: the speaker is
    // silent while the answer plays, and that silence is not dead air.
    this.conversationIdleFrom = this.now() + totalAudioMs;
    this.lastTimings = {
      segmentMs: Math.round(segment.durationMs),
      sttMs: Math.round(sttMs),
      agentMs: Math.round(agentMs),
      ttsMs: Math.round(firstChunkTtsMs ?? 0),
      firstAudioMs: firstAudioMs ?? Math.round(this.now() - segment.closedAt),
    };
    this.params.log?.(
      `teamspeak voice: stt-tts turn clientId=${this.clientId} nickname=${this.nickname} ` +
        `segmentMs=${this.lastTimings.segmentMs} sttMs=${this.lastTimings.sttMs} ` +
        `agentMs=${this.lastTimings.agentMs} ttsMs=${this.lastTimings.ttsMs} ` +
        `firstAudioMs=${this.lastTimings.firstAudioMs} ttsChunks=${spokenChunks}/${chunks.length} ` +
        `sttProvider=${sttProvider} speechProvider=${speechProvider ?? this.params.synthesizer.id}${this.lastFuzzyHearing ? ` wakeHeardAs=${JSON.stringify(this.lastFuzzyHearing)}` : ""}`,
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
      const message = fuzzy.text.trim() || transcript.trim();
      return { message, wakeName: fuzzy.activationName };
    }
    this.lastFuzzyHearing = undefined;
    // The other bot's name, or close enough to it: theirs to answer, not ours,
    // and not a follow-up either -- they said who they meant.
    if (evaluated.excludedBy) {
      this.lastExcludedBy = evaluated.excludedBy;
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
 * Read a transcript plus the provider that produced it.
 *
 * `SegmentTranscriber` only promises `transcribe`, and the routing transcriber
 * is the one implementation that can also say *who* answered. Feature-detecting
 * here keeps `sttProvider` honest on both paths — it reports the real provider
 * when routing is on, and the plain transcriber's own id when it is off —
 * without forcing every implementation to carry the richer method.
 */
export async function transcribeSegment(
  transcriber: SegmentTranscriber,
  request: TranscriptionRequest,
): Promise<{ text: string; provider: string }> {
  const detailed = (
    transcriber as SegmentTranscriber & {
      transcribeDetailed?: (
        request: TranscriptionRequest,
      ) => Promise<{ text: string; provider: string }>;
    }
  ).transcribeDetailed;
  if (typeof detailed === "function") {
    return await detailed.call(transcriber, request);
  }
  return { text: await transcriber.transcribe(request), provider: transcriber.id };
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
export class ConcurrencyLimitedTranscriber implements SegmentTranscriber {
  readonly id: string;
  private inFlight = 0;
  private readonly waiting: Array<(proceed: boolean) => void> = [];

  constructor(
    private readonly inner: SegmentTranscriber,
    private readonly maxInFlight = 1,
    private readonly maxQueueDepth = 1,
    private readonly log?: (message: string) => void,
  ) {
    this.id = inner.id;
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    const { text } = await this.transcribeDetailed(request);
    return text;
  }

  async transcribeDetailed(request: TranscriptionRequest): Promise<{ text: string; provider: string }> {
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
        return { text: "", provider: this.id };
      }
    }
    this.inFlight += 1;
    try {
      return await transcribeSegment(this.inner, request);
    } finally {
      this.inFlight -= 1;
      const next = this.waiting.shift();
      next?.(true);
    }
  }
}
