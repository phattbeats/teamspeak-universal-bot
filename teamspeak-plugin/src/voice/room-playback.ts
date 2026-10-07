/**
 * One playback lane for the whole TeamSpeak channel.
 *
 * Discord gives every speaker its own realtime session but only one
 * `AudioPlayer` per room (extensions/discord/src/voice/realtime-player.ts).
 * The same constraint applies here for a stronger reason: the bridge mixes our
 * `voice_audio` lane into a single Opus stream, so if two speaker sessions
 * wrote concurrently their answers would be summed into one garbled voice.
 *
 * This queue serializes utterances by owner: whoever writes first owns the lane
 * until it releases, and other owners' audio waits behind it.
 */
import { bridgePcmDurationMs } from "./audio.js";

export type RoomPlaybackSink = {
  /** Write 48 kHz mono PCM16 to the bridge's `voice_audio` lane. */
  writeVoiceAudio: (pcm48kMono: Buffer) => void;
  /** Tell the bridge to drop voice samples it has already queued. */
  clearVoice: () => void;
};

export type RoomPlaybackOwnerKey = string;

type QueuedChunk = {
  owner: RoomPlaybackOwnerKey;
  pcm48kMono: Buffer;
};

type ActiveUtterance = {
  owner: RoomPlaybackOwnerKey;
  /** Audio duration handed to the bridge for this utterance, in milliseconds. */
  writtenMs: number;
};

export type RoomPlaybackQueueParams = {
  sink: RoomPlaybackSink;
  /**
   * Minimum assistant playback duration before a barge-in truncates audio
   * (Discord's `voice.realtime.minBargeInAudioEndMs`, default 250ms).
   *
   * The bridge has no provider-native echo handler, so the guard runs locally:
   * our own voice comes back through the channel as a `speaker_start` from
   * whoever the server attributes it to, and without this window the Sexton
   * interrupts itself on its own first syllable.
   */
  minBargeInAudioEndMs: number;
  /** Notified when a barge-in retires an owner so it can interrupt its provider. */
  onOwnerInterrupted?: ((owner: RoomPlaybackOwnerKey, reason: string) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

export class RoomPlaybackQueue {
  private queue: QueuedChunk[] = [];
  private active: ActiveUtterance | undefined;
  private closed = false;

  /**
   * Another bot sharing the channel (Bexton, Lexton...) is talking right now
   * (#3829). The runtime sets it from that bot's speaker_start/stop; the
   * sessions read it so a follow-up answer doesn't start on top of it.
   */
  otherBotSpeaking = false;

  constructor(private readonly params: RoomPlaybackQueueParams) {}

  get pendingChunkCount(): number {
    return this.queue.length;
  }

  get activeOwner(): RoomPlaybackOwnerKey | undefined {
    return this.active?.owner;
  }

  /** Audio duration already handed to the bridge for the active utterance. */
  get activeWrittenMs(): number {
    return this.active?.writtenMs ?? 0;
  }

  isActive(): boolean {
    return this.active !== undefined || this.queue.length > 0;
  }

  enqueue(owner: RoomPlaybackOwnerKey, pcm48kMono: Buffer): void {
    if (this.closed || pcm48kMono.length === 0) {
      return;
    }
    this.queue.push({ owner, pcm48kMono });
    this.drain();
  }

  /**
   * The owner's provider finished speaking. Release the lane so a waiting
   * owner can start; without this a stalled session would hold the room.
   */
  release(owner: RoomPlaybackOwnerKey): void {
    if (this.active?.owner !== owner) {
      return;
    }
    this.active = undefined;
    this.drain();
  }

  /**
   * Interrupt playback. Clears everything queued for the room and asks the
   * bridge to drop what it has already buffered.
   *
   * Returns false when the echo guard declined the interruption, so callers can
   * log the difference between "ignored" and "interrupted".
   */
  handleBargeIn(reason: string, options?: { force?: boolean }): boolean {
    if (this.closed || !this.isActive()) {
      return false;
    }
    const force = options?.force === true;
    const writtenMs = this.activeWrittenMs;
    if (!force && this.active && writtenMs < this.params.minBargeInAudioEndMs) {
      this.params.log?.(
        `teamspeak voice: barge-in ignored as echo reason=${reason} outputAudioMs=${writtenMs} minBargeInAudioEndMs=${this.params.minBargeInAudioEndMs}`,
      );
      return false;
    }
    const interrupted = this.active?.owner;
    const waiting = new Set(this.queue.map((chunk) => chunk.owner));
    this.queue = [];
    this.active = undefined;
    this.params.sink.clearVoice();
    this.params.log?.(
      `teamspeak voice: barge-in reason=${reason} outputAudioMs=${writtenMs} owner=${interrupted ?? "none"}`,
    );
    if (interrupted) {
      waiting.add(interrupted);
    }
    for (const owner of waiting) {
      this.params.onOwnerInterrupted?.(owner, reason);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.active = undefined;
  }

  private drain(): void {
    if (this.closed) {
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) {
        return;
      }
      if (this.active && this.active.owner !== next.owner) {
        // Another speaker owns the lane; hold this chunk until it releases.
        return;
      }
      this.queue.shift();
      this.active ??= { owner: next.owner, writtenMs: 0 };
      this.active.writtenMs += bridgePcmDurationMs(next.pcm48kMono);
      this.params.sink.writeVoiceAudio(next.pcm48kMono);
    }
  }
}
