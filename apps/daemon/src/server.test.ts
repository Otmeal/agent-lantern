import { protocolVersion } from "@agent-lantern/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./server.js";

const token = "test-token-that-is-long-enough";
const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createServer() {
  const server = await buildServer({
    configuration: {
      bindAddress: "127.0.0.1",
      port: 48123,
      token,
      allowedOrigins: ["http://localhost:1420"],
      allowAutomaticPortFallback: true,
    },
  });
  servers.push(server);
  return server;
}

describe("daemon API", () => {
  it("answers /health without a bearer token and reports the protocol version handshake fields", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "agent-lantern-daemon",
      protocolVersion,
      processIdentifier: process.pid,
    });
  });

  it("withholds the process identifier from /health requests that are not loopback", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "100.64.1.2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "agent-lantern-daemon",
      protocolVersion,
    });
  });

  it("rejects requests without a token", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts an event and exposes the latest session state", async () => {
    const server = await createServer();
    const event = {
      schemaVersion: 1,
      eventIdentifier: "event-1",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "codex.Stop",
      status: "completed",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-host" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-1" },
      message: "本回合已完成",
    };

    const eventResponse = await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: event,
    });
    const sessionsResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(eventResponse.statusCode).toBe(202);
    expect(sessionsResponse.json().sessions).toMatchObject([
      {
        host: { name: "remote-host" },
        status: "completed",
        session: { identifier: "session-1" },
      },
    ]);
  });

  it("includes a non-empty sessionKey on each session snapshot", async () => {
    const server = await createServer();
    const event = {
      schemaVersion: 1,
      eventIdentifier: "event-session-key",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "codex.Stop",
      status: "completed",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-host" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-key-check" },
    };

    await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: event,
    });
    const sessionsResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });

    const sessions = sessionsResponse.json().sessions as Array<{
      sessionKey: string;
    }>;
    expect(sessions).toHaveLength(1);
    expect(typeof sessions[0]?.sessionKey).toBe("string");
    expect(sessions[0]?.sessionKey.length).toBeGreaterThan(0);
  });

  it("deletes a session by its sessionKey and removes it from a subsequent GET", async () => {
    const server = await createServer();
    const event = {
      schemaVersion: 1,
      eventIdentifier: "event-delete-1",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "codex.Stop",
      status: "completed",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-host" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-delete" },
    };

    await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: event,
    });
    const beforeDelete = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    const sessionKey = beforeDelete.json().sessions[0].sessionKey as string;

    const deleteResponse = await server.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionKey}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const afterDelete = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(deleteResponse.statusCode).toBe(204);
    expect(afterDelete.json().sessions).toHaveLength(0);
  });

  it("returns 404 when deleting an unknown or garbage sessionKey", async () => {
    const server = await createServer();
    const deleteResponse = await server.inject({
      method: "DELETE",
      url: "/api/v1/sessions/not-a-real-key",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json()).toEqual({ error: "Session not found" });
  });

  it("rejects a non-canonical variant of a real sessionKey and leaves the session in place", async () => {
    const server = await createServer();
    const event = {
      schemaVersion: 1,
      eventIdentifier: "event-delete-noncanonical",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "codex.Stop",
      status: "completed",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-host" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-noncanonical" },
    };

    await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: event,
    });
    const beforeDelete = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    const sessionKey = beforeDelete.json().sessions[0].sessionKey as string;

    const deleteResponse = await server.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionKey}=`,
      headers: { authorization: `Bearer ${token}` },
    });
    const afterDelete = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(deleteResponse.statusCode).toBe(404);
    expect(afterDelete.json().sessions).toHaveLength(1);
  });

  it("rejects DELETE requests without a bearer token", async () => {
    const server = await createServer();
    const deleteResponse = await server.inject({
      method: "DELETE",
      url: "/api/v1/sessions/whatever",
    });

    expect(deleteResponse.statusCode).toBe(401);
  });

  it("recreates a session on a fresh event after deletion", async () => {
    const server = await createServer();
    const baseEvent = {
      schemaVersion: 1,
      eventIdentifier: "event-recreate-1",
      occurredAt: "2026-08-30T12:00:00.000Z",
      eventType: "codex.Stop",
      status: "completed",
      agent: { kind: "codex", displayName: "Codex" },
      host: { name: "remote-host" },
      workspace: { path: "/srv/application", name: "application" },
      session: { identifier: "session-recreate" },
    };

    await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: baseEvent,
    });
    const beforeDelete = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    const sessionKey = beforeDelete.json().sessions[0].sessionKey as string;

    await server.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionKey}`,
      headers: { authorization: `Bearer ${token}` },
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...baseEvent, eventIdentifier: "event-recreate-2" },
    });
    const afterRepost = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(afterRepost.json().sessions).toMatchObject([
      {
        session: { identifier: "session-recreate" },
        status: "completed",
      },
    ]);
  });
});
