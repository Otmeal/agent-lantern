import { describe, expect, it } from "vitest";

import { normalizedAgentEventSchema } from "./index.js";

describe("normalizedAgentEventSchema", () => {
  it("accepts a complete version one event", () => {
    const result = normalizedAgentEventSchema.safeParse({
      schemaVersion: 1,
      eventIdentifier: "event-1",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "session.started",
      status: "starting",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-build" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-1" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unsupported state", () => {
    const result = normalizedAgentEventSchema.safeParse({
      schemaVersion: 1,
      eventIdentifier: "event-2",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "agent.unknown",
      status: "sleeping",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-build" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-2" },
    });

    expect(result.success).toBe(false);
  });
});
