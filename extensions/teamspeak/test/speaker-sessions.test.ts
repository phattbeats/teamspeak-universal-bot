/**
 * Acceptance: "speaker sessions open/close on roster" (PHA-3175).
 */
import { describe, expect, it, vi } from "vitest";
import type { RosterEntry } from "../src/bridge/protocol.js";
import { SpeakerSessionManager, type SpeakerSession } from "../src/voice/speaker-sessions.js";
import { rosterEntry } from "./mock-bridge.js";

type FakeSession = SpeakerSession & {
  closedWith: string[];
  connectCount: number;
  labels: string[];
};

function createFactory(options: { failConnectFor?: number[] } = {}) {
  const created: FakeSession[] = [];
  const createSession = (client: RosterEntry): SpeakerSession => {
    const session: FakeSession = {
      clientId: client.clientId,
      label: client.nickname,
      closedWith: [],
      connectCount: 0,
      labels: [client.nickname],
      async connect() {
        this.connectCount += 1;
        if (options.failConnectFor?.includes(client.clientId)) {
          throw new Error(`provider refused ${client.clientId}`);
        }
      },
      relabel(nickname: string) {
        this.labels.push(nickname);
      },
      close(reason: string) {
        this.closedWith.push(reason);
      },
    };
    created.push(session);
    return session;
  };
  return { created, createSession };
}

describe("SpeakerSessionManager", () => {
  it("opens one session per human on the roster, keyed by clientId", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({ createSession: factory.createSession });

    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(12, "guest")]);

    expect(manager.sessionCount).toBe(2);
    expect(manager.sessionKeys().sort()).toEqual([11, 12]);
    expect(factory.created.map((session) => session.connectCount)).toEqual([1, 1]);
  });

  it("never opens a session on the bridge's own client", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({
      createSession: factory.createSession,
      selfClientId: () => 99,
    });

    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(99, "Sexton")]);

    expect(manager.sessionKeys()).toEqual([11]);
    expect(manager.humanParticipantCount()).toBe(1);
  });

  it("closes the session of a client that left, and leaves the rest alone", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({ createSession: factory.createSession });

    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(12, "guest")]);
    manager.applyRoster([rosterEntry(11, "brandon")]);

    expect(manager.sessionKeys()).toEqual([11]);
    const guest = factory.created.find((session) => session.clientId === 12);
    expect(guest?.closedWith).toEqual(["left-channel"]);
    const brandon = factory.created.find((session) => session.clientId === 11);
    expect(brandon?.closedWith).toEqual([]);
  });

  it("is idempotent across repeated identical roster snapshots", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({ createSession: factory.createSession });

    const roster = [rosterEntry(11, "brandon")];
    manager.applyRoster(roster);
    manager.applyRoster(roster);
    manager.applyRoster(roster);

    // The bridge re-sends the full roster on every change; a rebuild each time
    // would drop the provider connection mid-sentence.
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.connectCount).toBe(1);
  });

  it("relabels a renamed client instead of recycling its session", () => {
    const factory = createFactory();
    const events: string[] = [];
    const manager = new SpeakerSessionManager({
      createSession: factory.createSession,
      onRosterEvent: (event) => events.push(event.kind),
    });

    manager.applyRoster([rosterEntry(11, "brandon")]);
    manager.applyRoster([rosterEntry(11, "brandon|afk")]);

    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.labels).toEqual(["brandon", "brandon|afk"]);
    expect(factory.created[0]?.closedWith).toEqual([]);
    expect(events).toEqual(["joined", "renamed"]);
  });

  it("emits joined/left roster events for the agent session", () => {
    const factory = createFactory();
    const onRosterEvent = vi.fn();
    const manager = new SpeakerSessionManager({
      createSession: factory.createSession,
      onRosterEvent,
    });

    manager.applyRoster([rosterEntry(11, "brandon")]);
    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(12, "guest")]);
    manager.applyRoster([rosterEntry(12, "guest")]);

    expect(onRosterEvent.mock.calls.map(([event]) => [event.kind, event.client.nickname])).toEqual([
      ["joined", "brandon"],
      ["joined", "guest"],
      ["left", "brandon"],
    ]);
  });

  it("drops a session whose provider never connected so a later roster can retry", async () => {
    const factory = createFactory({ failConnectFor: [12] });
    const onSessionError = vi.fn();
    const manager = new SpeakerSessionManager({
      createSession: factory.createSession,
      onSessionError,
    });

    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(12, "guest")]);
    await vi.waitFor(() => expect(onSessionError).toHaveBeenCalled());

    expect(manager.sessionKeys()).toEqual([11]);
    expect(onSessionError.mock.calls[0]?.[0]).toBe(12);
  });

  it("closes every session when the bridge connection drops", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({ createSession: factory.createSession });

    manager.applyRoster([rosterEntry(11, "brandon"), rosterEntry(12, "guest")]);
    manager.closeAll("bridge-disconnected:reset");

    expect(manager.sessionCount).toBe(0);
    expect(manager.humanParticipantCount()).toBe(0);
    for (const session of factory.created) {
      expect(session.closedWith).toEqual(["bridge-disconnected:reset"]);
    }
  });

  it("reopens sessions from the next roster after a disconnect", () => {
    const factory = createFactory();
    const manager = new SpeakerSessionManager({ createSession: factory.createSession });

    manager.applyRoster([rosterEntry(11, "brandon")]);
    manager.closeAll("bridge-disconnected:reset");
    manager.applyRoster([rosterEntry(11, "brandon")]);

    expect(manager.sessionKeys()).toEqual([11]);
    expect(factory.created).toHaveLength(2);
  });
});
