import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { resolveListeningPort } from "./port.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

function occupyPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    openServers.push(server);
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine the occupied port."));
        return;
      }
      resolve(address.port);
    });
  });
}

describe("resolveListeningPort", () => {
  it("keeps the preferred port when it is available", async () => {
    const freePort = await occupyPort("127.0.0.1");
    await new Promise((resolve) => openServers.pop()!.close(resolve));

    await expect(resolveListeningPort("127.0.0.1", freePort)).resolves.toBe(
      freePort,
    );
  });

  it("falls back to an available port when the preferred one is taken", async () => {
    const takenPort = await occupyPort("127.0.0.1");

    const resolvedPort = await resolveListeningPort("127.0.0.1", takenPort);

    expect(resolvedPort).not.toBe(takenPort);
    expect(resolvedPort).toBeGreaterThan(0);
  });
});
