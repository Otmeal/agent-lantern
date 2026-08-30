import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDaemonConfiguration } from "./configuration.js";

const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createIsolatedEnvironment(): NodeJS.ProcessEnv {
  const appData = mkdtempSync(join(tmpdir(), "agent-lantern-test-"));
  createdDirectories.push(appData);
  return { APPDATA: appData };
}

describe("loadDaemonConfiguration", () => {
  it("auto-generates and persists a token on first run", () => {
    const environment = createIsolatedEnvironment();

    const configuration = loadDaemonConfiguration(environment);

    expect(configuration.token).toHaveLength(64);
    expect(configuration.bindAddress).toBe("0.0.0.0");
    expect(configuration.port).toBe(48123);

    const persisted = JSON.parse(
      readFileSync(
        join(environment.APPDATA!, "agent-lantern", "config.json"),
        "utf8",
      ),
    );
    expect(persisted.token).toBe(configuration.token);
  });

  it("reuses the previously generated token on subsequent runs", () => {
    const environment = createIsolatedEnvironment();

    const first = loadDaemonConfiguration(environment);
    const second = loadDaemonConfiguration(environment);

    expect(second.token).toBe(first.token);
  });

  it("prefers an explicit AGENT_LANTERN_TOKEN over the shared file", () => {
    const environment = {
      ...createIsolatedEnvironment(),
      AGENT_LANTERN_TOKEN: "explicit-token-that-is-long-enough",
    };

    const configuration = loadDaemonConfiguration(environment);

    expect(configuration.token).toBe(environment.AGENT_LANTERN_TOKEN);
    expect(configuration.bindAddress).toBe("127.0.0.1");
  });
});
