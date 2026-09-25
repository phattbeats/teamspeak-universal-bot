import { bridgePcmDurationMs } from "./audio.js";
class RoomPlaybackQueue {
  constructor(params) {
    this.params = params;
  }
  params;
  queue = [];
  active;
  closed = false;
  get pendingChunkCount() {
    return this.queue.length;
  }
  get activeOwner() {
    return this.active?.owner;
  }
  /** Audio duration already handed to the bridge for the active utterance. */
  get activeWrittenMs() {
    return this.active?.writtenMs ?? 0;
  }
  isActive() {
    return this.active !== void 0 || this.queue.length > 0;
  }
  enqueue(owner, pcm48kMono) {
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
  release(owner) {
    if (this.active?.owner !== owner) {
      return;
    }
    this.active = void 0;
    this.drain();
  }
  /**
   * Interrupt playback. Clears everything queued for the room and asks the
   * bridge to drop what it has already buffered.
   *
   * Returns false when the echo guard declined the interruption, so callers can
   * log the difference between "ignored" and "interrupted".
   */
  handleBargeIn(reason, options) {
    if (this.closed || !this.isActive()) {
      return false;
    }
    const force = options?.force === true;
    const writtenMs = this.activeWrittenMs;
    if (!force && this.active && writtenMs < this.params.minBargeInAudioEndMs) {
      this.params.log?.(
        `teamspeak voice: barge-in ignored as echo reason=${reason} outputAudioMs=${writtenMs} minBargeInAudioEndMs=${this.params.minBargeInAudioEndMs}`
      );
      return false;
    }
    const interrupted = this.active?.owner;
    const waiting = new Set(this.queue.map((chunk) => chunk.owner));
    this.queue = [];
    this.active = void 0;
    this.params.sink.clearVoice();
    this.params.log?.(
      `teamspeak voice: barge-in reason=${reason} outputAudioMs=${writtenMs} owner=${interrupted ?? "none"}`
    );
    if (interrupted) {
      waiting.add(interrupted);
    }
    for (const owner of waiting) {
      this.params.onOwnerInterrupted?.(owner, reason);
    }
    return true;
  }
  close() {
    this.closed = true;
    this.queue = [];
    this.active = void 0;
  }
  drain() {
    if (this.closed) {
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) {
        return;
      }
      if (this.active && this.active.owner !== next.owner) {
        return;
      }
      this.queue.shift();
      this.active ??= { owner: next.owner, writtenMs: 0 };
      this.active.writtenMs += bridgePcmDurationMs(next.pcm48kMono);
      this.params.sink.writeVoiceAudio(next.pcm48kMono);
    }
  }
}
export {
  RoomPlaybackQueue
};
