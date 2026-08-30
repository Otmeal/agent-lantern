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
});
