/**
 * Roster-driven speaker session lifecycle.
 *
 * Discord opens one realtime session per speaking user and keys it by Discord
 * user id. TeamSpeak's equivalent identity on the wire is the runtime
 * `clientId`, which is what the bridge tags every `speaker_audio` frame with,
 * so sessions are keyed by clientId and only *labelled* by nickname. Nicknames
 * change mid-session on TeamSpeak and are not unique; keying by them would
 * silently merge two people into one provider connection.
 */
import type { RosterEntry, TeamSpeakClientId } from "../bridge/protocol.js";

/** The part of a per-speaker realtime session this manager needs. */
export type SpeakerSession = {
  readonly clientId: TeamSpeakClientId;
  readonly label: string;
  connect(): Promise<void>;
  /** Nickname changes relabel a live session instead of recycling it. */
  relabel(nickname: string): void;
  close(reason: string): void;
};

export type SpeakerSessionManagerParams = {
  createSession: (client: RosterEntry) => SpeakerSession;
  /** The bridge's own client id, so the Sexton never opens a session on itself. */
  selfClientId?: (() => TeamSpeakClientId | undefined) | undefined;
  /** Roster changes are also surfaced as silent events into the agent session. */
  onRosterEvent?: ((event: RosterEvent) => void) | undefined;
  onSessionError?: ((clientId: TeamSpeakClientId, error: Error) => void) | undefined;
  log?: ((message: string) => void) | undefined;
};

export type RosterEvent =
  | { kind: "joined"; client: RosterEntry }
  | { kind: "left"; client: RosterEntry }
  | { kind: "renamed"; client: RosterEntry; previousNickname: string };

export class SpeakerSessionManager {
  private readonly sessions = new Map<TeamSpeakClientId, SpeakerSession>();
  private roster = new Map<TeamSpeakClientId, RosterEntry>();
  private closed = false;

  constructor(private readonly params: SpeakerSessionManagerParams) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Humans currently in the channel, excluding the bridge's own client. */
  humanParticipantCount(): number {
    return this.roster.size;
  }

  /** The last roster snapshot, minus the bot — what `who_is_here` answers with. */
  rosterEntries(): RosterEntry[] {
    return Array.from(this.roster.values());
  }

  hasSession(clientId: TeamSpeakClientId): boolean {
    return this.sessions.has(clientId);
  }

  get(clientId: TeamSpeakClientId): SpeakerSession | undefined {
    return this.sessions.get(clientId);
  }

  sessionKeys(): TeamSpeakClientId[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Apply a full roster snapshot. The bridge sends `roster` on every change, so
   * this is a diff against the previous snapshot rather than an event stream.
   */
  applyRoster(entries: RosterEntry[]): void {
    if (this.closed) {
      return;
    }
    const selfClientId = this.params.selfClientId?.();
    const next = new Map<TeamSpeakClientId, RosterEntry>();
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
          previousNickname: previous.nickname,
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

  closeAll(reason: string): void {
    for (const clientId of Array.from(this.sessions.keys())) {
      this.closeSession(clientId, reason);
    }
    this.roster = new Map();
  }

  close(reason: string): void {
    this.closed = true;
    this.closeAll(reason);
  }

  private openSession(client: RosterEntry): void {
    if (this.sessions.has(client.clientId)) {
      return;
    }
    let session: SpeakerSession;
    try {
      session = this.params.createSession(client);
    } catch (error) {
      this.params.onSessionError?.(
        client.clientId,
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    this.sessions.set(client.clientId, session);
    this.params.log?.(
      `teamspeak voice: speaker session opening clientId=${client.clientId} nickname=${client.nickname}`,
    );
    void session.connect().catch((error: unknown) => {
      // A provider that never comes up must not leave a dead entry in the map;
      // the next roster snapshot would otherwise treat this speaker as covered.
      if (this.sessions.get(client.clientId) === session) {
        this.sessions.delete(client.clientId);
      }
      this.params.onSessionError?.(
        client.clientId,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  private closeSession(clientId: TeamSpeakClientId, reason: string): void {
    const session = this.sessions.get(clientId);
    if (!session) {
      return;
    }
    this.sessions.delete(clientId);
    this.params.log?.(
      `teamspeak voice: speaker session closing clientId=${clientId} reason=${reason}`,
    );
    try {
      session.close(reason);
    } catch (error) {
      this.params.onSessionError?.(
        clientId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
