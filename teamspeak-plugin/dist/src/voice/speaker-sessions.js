class SpeakerSessionManager {
  constructor(params) {
    this.params = params;
  }
  params;
  sessions = /* @__PURE__ */ new Map();
  roster = /* @__PURE__ */ new Map();
  closed = false;
  get sessionCount() {
    return this.sessions.size;
  }
  /** Humans currently in the channel, excluding the bridge's own client. */
  humanParticipantCount() {
    return this.roster.size;
  }
  /** The last roster snapshot, minus the bot — what `who_is_here` answers with. */
  rosterEntries() {
    return Array.from(this.roster.values());
  }
  hasSession(clientId) {
    return this.sessions.has(clientId);
  }
  get(clientId) {
    return this.sessions.get(clientId);
  }
  sessionKeys() {
    return Array.from(this.sessions.keys());
  }
  /**
   * Apply a full roster snapshot. The bridge sends `roster` on every change, so
   * this is a diff against the previous snapshot rather than an event stream.
   */
  applyRoster(entries) {
    if (this.closed) {
      return;
    }
    const selfClientId = this.params.selfClientId?.();
    const next = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (entry.clientId === selfClientId) {
        continue;
      }
      next.set(entry.clientId, entry);
    }
    for (const [clientId, entry] of next) {
      const previous = this.roster.get(clientId);
      if (!previous) {
        this.params.onRosterEvent?.({ kind: "joined", client: entry });
        this.openSession(entry);
        continue;
      }
      if (previous.nickname !== entry.nickname) {
        this.params.onRosterEvent?.({
          kind: "renamed",
          client: entry,
          previousNickname: previous.nickname
        });
        this.sessions.get(clientId)?.relabel(entry.nickname);
      }
    }
    for (const [clientId, entry] of this.roster) {
      if (next.has(clientId)) {
        continue;
      }
      this.params.onRosterEvent?.({ kind: "left", client: entry });
      this.closeSession(clientId, "left-channel");
    }
    this.roster = next;
  }
  closeAll(reason) {
    for (const clientId of Array.from(this.sessions.keys())) {
      this.closeSession(clientId, reason);
    }
    this.roster = /* @__PURE__ */ new Map();
  }
  close(reason) {
    this.closed = true;
    this.closeAll(reason);
  }
  openSession(client) {
    if (this.sessions.has(client.clientId)) {
      return;
    }
    if (this.params.shouldOpenSession?.(client) === false) {
      this.params.log?.(
        `teamspeak voice: speaker session skipped clientId=${client.clientId} nickname=${client.nickname} reason=excluded-nickname`
      );
      return;
    }
    let session;
    try {
      session = this.params.createSession(client);
    } catch (error) {
      this.params.onSessionError?.(
        client.clientId,
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }
    this.sessions.set(client.clientId, session);
    this.params.log?.(
      `teamspeak voice: speaker session opening clientId=${client.clientId} nickname=${client.nickname}`
    );
    void session.connect().catch((error) => {
      if (this.sessions.get(client.clientId) === session) {
        this.sessions.delete(client.clientId);
      }
      this.params.onSessionError?.(
        client.clientId,
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }
  closeSession(clientId, reason) {
    const session = this.sessions.get(clientId);
    if (!session) {
      return;
    }
    this.sessions.delete(clientId);
    this.params.log?.(
      `teamspeak voice: speaker session closing clientId=${clientId} reason=${reason}`
    );
    try {
      session.close(reason);
    } catch (error) {
      this.params.onSessionError?.(
        clientId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
export {
  SpeakerSessionManager
};
