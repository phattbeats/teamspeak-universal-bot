import { matchRealtimeVoiceActivationName } from "openclaw/plugin-sdk/realtime-voice";
import { evaluateFuzzyWakeName } from "./fuzzy-wake.js";
import { SpeakerSegmenter } from "./segmenter.js";
import { SpeechPipeline } from "./speech-pipeline.js";
import { WakeGate } from "./wake-gate.js";
const DEFAULT_FOLLOW_UP_SILENCE_MS = 15e3;
const MAX_CONSECUTIVE_FOLLOW_UPS = 3;
class TeamSpeakSttTtsSpeakerSession {
  constructor(params) {
    this.params = params;
    this.clientId = params.client.clientId;
    this.nickname = params.client.nickname;
    this.now = params.now ?? (() => Date.now());
    this.gate = new WakeGate({
      wakeNamePolicy: () => resolveSttTtsWakeNamePolicy(params.wakeConfig.requireWakeName),
      humanParticipantCount: () => this.params.humanParticipantCount(),
      realtimeConfig: () => this.params.wakeConfig,
      // There is no realtime provider here, so barge-in has no provider-keyed
      // `interruptResponseOnInputAudio` to read; the configured value decides.
      providerId: () => void 0
    });
    this.segmenter = new SpeakerSegmenter({
      hangoverMs: params.segmentation.hangoverMs,
      minSegmentMs: params.segmentation.minSegmentMs,
      maxSegmentMs: params.segmentation.maxSegmentMs,
      onSegment: (segment) => this.enqueueTurn(segment),
      onDropped: (durationMs) => this.params.log?.(
        `teamspeak voice: segment dropped as too short clientId=${this.clientId} durationMs=${Math.round(durationMs)} minSegmentMs=${params.segmentation.minSegmentMs}`
      ),
      ...params.now ? { now: params.now } : {},
      ...params.setTimeoutFn ? { setTimeoutFn: params.setTimeoutFn } : {},
      ...params.clearTimeoutFn ? { clearTimeoutFn: params.clearTimeoutFn } : {}
    });
  }
  params;
  clientId;
  nickname;
  status = "inactive";
  gate;
  segmenter;
  now;
  /** Serializes turns: two answers on one lane would be summed into noise. */
  queue = Promise.resolve();
  /** Bumped by barge-in and close, so a turn that finishes late stays silent. */
  generation = 0;
  lastTimings;
  /** When the bot's last answer finishes playing; dead air is counted from here. */
  conversationIdleFrom;
  /** Nameless follow-ups answered since the name was last said. */
  consecutiveFollowUps = 0;
  /** What whisper called the wake name on the last fuzzy match, for the log. */
  lastFuzzyHearing;
  /** The other bot's name that claimed the last declined hearing, for the log (#3605). */
  lastExcludedBy;
  /** Room playback key: the clientId owns the lane, not the nickname. */
  get playbackOwnerKey() {
    return `client:${this.clientId}`;
  }
  get label() {
    return this.nickname;
  }
  get wakeNameRequired() {
    return this.gate.isWakeNameRequired();
  }
  get bargeInEnabled() {
    return this.gate.isBargeInEnabled();
  }
  /** The last completed turn's latency breakdown; the budget's evidence. */
  get timings() {
    return this.lastTimings;
  }
  relabel(nickname) {
    this.nickname = nickname;
  }
  /**
   * No provider session to open. The lane is a request/response pipeline that
   * exists as soon as its parts are constructed, so this only reports the
   * configuration it will run with — the line an operator reads to confirm the
   * mic is going nowhere.
   */
  async connect() {
    if (this.status === "stopped") {
      return;
    }
    this.status = "active";
    this.params.log?.(
      `teamspeak voice: stt-tts session ready clientId=${this.clientId} nickname=${this.nickname} transcription=${this.params.transcriber.id} speech=${this.params.synthesizer.id} requireWakeName=${this.wakeNameRequired} wakeNames=${this.params.wakeNames.join(",") || "none"} wakeAliases=${this.params.wakeConfig.wakeAliases?.join(",") || "none"} excludeWakeNames=${this.params.wakeConfig.excludeWakeNames?.join(",") || "none"} bargeIn=${this.bargeInEnabled} humanParticipants=${this.params.humanParticipantCount()}`
    );
  }
  /** Bridge `speaker_audio` for this client -> the open segment. */
  sendInputAudio(pcm48kMono) {
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
  handleSpeakerStart(reason = "speaker-start") {
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
      this.generation += 1;
    }
    return interrupted;
  }
  /** The speaker stopped; arm the hangover that closes the segment. */
  handleSpeakerStop() {
    if (this.isStopped()) {
      return;
    }
    this.segmenter.handleSpeakerStop();
  }
  /** Close the follow-up window; the next answer needs our name (#3829). */
  endFollowUp(reason) {
    if (this.conversationIdleFrom === void 0) {
      return;
    }
    this.conversationIdleFrom = void 0;
    this.consecutiveFollowUps = 0;
    this.params.log?.(
      `teamspeak voice: follow-up window closed clientId=${this.clientId} reason=${reason}`
    );
  }
  close(reason) {
    if (this.status === "stopped") {
      return;
    }
    this.status = "stopped";
    this.generation += 1;
    this.segmenter.close();
    this.params.playback.release(this.playbackOwnerKey);
    this.params.log?.(
      `teamspeak voice: stt-tts session closed clientId=${this.clientId} reason=${reason}`
    );
  }
  isStopped() {
    return this.status === "stopped";
  }
  enqueueTurn(segment) {
    const generation = this.generation;
    const sttStartedAt = this.now();
    const transcription = this.params.transcriber.transcribe({
      pcm48kMono: segment.pcm48kMono,
      label: this.nickname,
      durationMs: segment.durationMs,
      clientId: this.clientId
    }).then((heard) => ({ heard, sttMs: this.now() - sttStartedAt }));
    transcription.catch(() => void 0);
    this.queue = this.queue.then(() => this.runTurn(segment, generation, transcription)).catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.params.log?.(
        `teamspeak voice: stt-tts turn failed clientId=${this.clientId}: ${failure.message}`
      );
      this.params.onTerminalError?.(failure);
    });
  }
  async runTurn(segment, generation, transcription) {
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    const queueWaitMs = this.now() - segment.closedAt;
    const { heard, sttMs } = await transcription;
    const transcript = heard.text;
    const sttProvider = heard.provider;
    const sttConfidence = heard.confidence === void 0 ? "" : ` sttConfidence=${heard.confidence.toFixed(2)}`;
    if (this.isStopped() || generation !== this.generation) {
      return;
    }
    if (!transcript) {
      this.params.log?.(
        `teamspeak voice: empty transcript clientId=${this.clientId} segmentMs=${Math.round(segment.durationMs)} sttMs=${Math.round(sttMs)} sttProvider=${sttProvider}${sttConfidence}`
      );
      return;
    }
    this.params.onHeard?.(transcript, this.nickname);
    const gated = this.applyWakeGate(transcript, segment);
    if (!gated) {
      this.params.log?.(
        `teamspeak voice: wake gate declined clientId=${this.clientId} humanParticipants=${this.params.humanParticipantCount()} wakeNames=${this.params.wakeNames.join(",") || "none"}${this.lastExcludedBy ? ` excludedBy=${JSON.stringify(this.lastExcludedBy)}` : ""} heard=${JSON.stringify(transcript.slice(0, 160))}`
      );
      return;
    }
    const isLive = () => !this.isStopped() && generation === this.generation;
    const isFollowUp = this.wakeNameRequired && !gated.wakeName;
    let yieldedToOtherBot = false;
    const mayStartSpeaking = () => {
      if (!yieldedToOtherBot && isFollowUp && firstBlockAt === void 0 && this.params.playback.otherBotSpeaking) {
        yieldedToOtherBot = true;
        this.params.log?.(
          `teamspeak voice: follow-up answer dropped, another bot is talking clientId=${this.clientId}`
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
      ...this.params.log ? { log: this.params.log } : {}
    });
    let streamedText = "";
    let firstBlockAt;
    const agentStartedAt = this.now();
    let outcome;
    try {
      const raw = await this.params.runAgentTurn(
        {
          clientId: this.clientId,
          nickname: this.nickname,
          message: gated.message,
          ...gated.wakeName ? { wakeName: gated.wakeName } : {},
          ...isFollowUp ? { followUp: true } : {}
        },
        {
          onBlock: (text) => {
            if (!isLive() || !mayStartSpeaking()) {
              return;
            }
            firstBlockAt ??= this.now();
            streamedText += text;
            pipeline.push(text);
          }
        }
      );
      outcome = typeof raw === "string" ? { text: raw } : raw;
    } catch (error) {
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
        const tail = reply.startsWith(streamedText) ? reply.slice(streamedText.length).trim() : "";
        if (tail) {
          pipeline.push(tail);
        } else if (!reply.startsWith(streamedText)) {
          this.params.log?.(
            `teamspeak voice: streamed blocks and final reply differ clientId=${this.clientId} streamedChars=${streamedText.length} replyChars=${reply.length}; keeping the streamed blocks`
          );
        }
      }
    }
    const speech = await pipeline.finish();
    this.params.playback.release(this.playbackOwnerKey);
    if (!isLive()) {
      return;
    }
    if (speech.error !== void 0) {
      throw new Error(`speech synthesis failed: ${speech.error}`);
    }
    if (speech.totalChunks === 0) {
      this.params.log?.(
        `teamspeak voice: agent turn produced nothing speakable clientId=${this.clientId} agentMs=${Math.round(agentMs)} path=${outcome.path ?? "unknown"}`
      );
      return;
    }
    if (speech.spokenChunks === 0) {
      return;
    }
    this.conversationIdleFrom = this.now() + speech.totalAudioMs;
    this.lastTimings = {
      segmentMs: Math.round(segment.durationMs),
      sttMs: Math.round(sttMs),
      agentMs: Math.round(agentMs),
      ttsMs: Math.round(speech.firstChunkTtsMs ?? 0),
      firstAudioMs: Math.round((speech.firstAudioAt ?? this.now()) - segment.closedAt)
    };
    const firstBlockMs = Math.round((firstBlockAt ?? agentStartedAt + agentMs) - agentStartedAt);
    const requestedModel = this.params.agentTurnLabel?.model ?? "default";
    const requestedThinking = this.params.agentTurnLabel?.thinking ?? "default";
    this.params.log?.(
      `teamspeak voice: stt-tts turn clientId=${this.clientId} nickname=${this.nickname} segmentMs=${this.lastTimings.segmentMs} queueWaitMs=${Math.round(queueWaitMs)} sttMs=${this.lastTimings.sttMs} agentMs=${this.lastTimings.agentMs} firstBlockMs=${firstBlockMs} ttsMs=${this.lastTimings.ttsMs} firstAudioMs=${this.lastTimings.firstAudioMs} ttsChunks=${speech.spokenChunks}/${speech.totalChunks} replyPath=${outcome.path ?? "unknown"} blocks=${outcome.blocks ?? 0} sttProvider=${sttProvider}${sttConfidence} sttMsProvider=${Math.round(heard.ms)} speechProvider=${speech.speechProvider ?? this.params.synthesizer.id} requestedModel=${requestedModel} requestedThinking=${requestedThinking}${this.lastFuzzyHearing ? ` wakeHeardAs=${JSON.stringify(this.lastFuzzyHearing)}` : ""}`
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
  applyWakeGate(transcript, segment) {
    if (!this.wakeNameRequired) {
      return { message: transcript };
    }
    const wakeNames = this.params.wakeNames;
    if (wakeNames.length === 0) {
      return void 0;
    }
    this.lastExcludedBy = void 0;
    const matched = matchRealtimeVoiceActivationName(transcript, wakeNames);
    if (matched) {
      this.lastFuzzyHearing = void 0;
      this.consecutiveFollowUps = 0;
      const message = matched.text.trim() || transcript.trim();
      return { message, wakeName: matched.activationName };
    }
    const evaluated = evaluateFuzzyWakeName(transcript, wakeNames, {
      aliases: this.params.wakeConfig.wakeAliases,
      excludeNames: this.params.wakeConfig.excludeWakeNames
    });
    const fuzzy = evaluated.match;
    if (fuzzy) {
      this.lastFuzzyHearing = fuzzy.heardAs;
      this.consecutiveFollowUps = 0;
      const message = fuzzy.text.trim() || transcript.trim();
      return { message, wakeName: fuzzy.activationName };
    }
    this.lastFuzzyHearing = void 0;
    if (evaluated.excludedBy) {
      this.lastExcludedBy = evaluated.excludedBy;
      this.endFollowUp(`named-other-bot:${evaluated.excludedBy}`);
      return void 0;
    }
    const followUpSilenceMs = this.params.wakeConfig.followUpSilenceMs ?? DEFAULT_FOLLOW_UP_SILENCE_MS;
    if (followUpSilenceMs <= 0) {
      return void 0;
    }
    const idleFrom = this.conversationIdleFrom;
    if (idleFrom !== void 0 && segment.startedAt - idleFrom <= followUpSilenceMs) {
      if (this.consecutiveFollowUps >= MAX_CONSECUTIVE_FOLLOW_UPS) {
        this.endFollowUp("follow-up-limit");
        return void 0;
      }
      this.consecutiveFollowUps += 1;
      return { message: transcript };
    }
    return void 0;
  }
}
function resolveSttTtsWakeNamePolicy(requireWakeName) {
  if (requireWakeName === true) {
    return "always";
  }
  if (requireWakeName === false) {
    return "never";
  }
  return "automatic";
}
class ConcurrencyLimitedTranscriber {
  constructor(inner, maxInFlight = 1, maxQueueDepth = 1, log) {
    this.inner = inner;
    this.maxInFlight = maxInFlight;
    this.maxQueueDepth = maxQueueDepth;
    this.log = log;
    this.id = inner.id;
    this.kind = inner.kind;
  }
  inner;
  maxInFlight;
  maxQueueDepth;
  log;
  id;
  kind;
  inFlight = 0;
  waiting = [];
  isBackedOff() {
    return this.inner.isBackedOff?.() ?? false;
  }
  backoffRemainingMs() {
    return this.inner.backoffRemainingMs?.() ?? 0;
  }
  async transcribe(request) {
    if (this.inFlight >= this.maxInFlight) {
      if (this.waiting.length >= this.maxQueueDepth) {
        const evicted = this.waiting.shift();
        this.log?.(
          `teamspeak voice: stt queue full, dropping oldest queued segment label=${request.label} inFlight=${this.inFlight} queueDepth=${this.waiting.length}`
        );
        evicted?.(false);
      }
      const proceed = await new Promise((resolve) => {
        this.waiting.push(resolve);
      });
      if (!proceed) {
        return { text: "", provider: this.id, ms: 0 };
      }
    }
    this.inFlight += 1;
    try {
      return await this.inner.transcribe(request);
    } finally {
      this.inFlight -= 1;
      const next = this.waiting.shift();
      next?.(true);
    }
  }
}
export {
  ConcurrencyLimitedTranscriber,
  DEFAULT_FOLLOW_UP_SILENCE_MS,
  MAX_CONSECUTIVE_FOLLOW_UPS,
  TeamSpeakSttTtsSpeakerSession,
  resolveSttTtsWakeNamePolicy
};
