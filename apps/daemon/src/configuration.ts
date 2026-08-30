import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonConfiguration {
  bindAddress: string;
  port: number;
  token: string;
  allowedOrigins: string[];
  /**
   * False when `AGENT_LANTERN_PORT` pins the port, in which case an
   * unavailable port is an error rather than something to work around.
   */
  allowAutomaticPortFallback: boolean;
}

interface SharedSetupConfiguration {
  token: string;
  bindAddress: string;
  port: number;
}

const defaultAllowedOrigins = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
];

const DEFAULT_BIND_ADDRESS = "0.0.0.0";
const DEFAULT_PORT = 48123;

export function sharedConfigurationDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const appDataRoot =
    environment.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appDataRoot, "agent-lantern");
}

export function sharedConfigurationFilePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(sharedConfigurationDirectory(environment), "config.json");
}

function readSharedConfiguration(
  filePath: string,
): SharedSetupConfiguration | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }

  if (
    typeof raw !== "object" ||
    raw === null ||
    !("token" in raw) ||
    typeof (raw as { token: unknown }).token !== "string" ||
    (raw as { token: string }).token.length < 20 ||
    !("bindAddress" in raw) ||
    typeof (raw as { bindAddress: unknown }).bindAddress !== "string" ||
    !("port" in raw) ||
    !Number.isInteger((raw as { port: unknown }).port)
  ) {
    return undefined;
  }

  const parsed = raw as SharedSetupConfiguration;
  return {
    token: parsed.token,
    bindAddress: parsed.bindAddress,
    port: parsed.port,
  };
}

function writeSharedConfiguration(
  filePath: string,
  directory: string,
  configuration: SharedSetupConfiguration,
): void {
  mkdirSync(directory, { recursive: true });
  const temporaryFilePath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryFilePath,
    JSON.stringify(configuration, null, 2) + "\n",
    { mode: 0o600 },
  );
  renameSync(temporaryFilePath, filePath);
}

/**
 * Loads the token/bind-address/port previously auto-generated on this
 * machine, or generates and persists a fresh one on first run so that no
 * manual PowerShell setup is required.
 */
function loadOrCreateSharedConfiguration(
  environment: NodeJS.ProcessEnv,
): SharedSetupConfiguration {
  const filePath = sharedConfigurationFilePath(environment);
  const existing = readSharedConfiguration(filePath);
  if (existing) {
    return existing;
  }

  const created: SharedSetupConfiguration = {
    token: randomBytes(32).toString("hex"),
    bindAddress: DEFAULT_BIND_ADDRESS,
    port: DEFAULT_PORT,
  };
  writeSharedConfiguration(
    filePath,
    sharedConfigurationDirectory(environment),
    created,
  );
  return created;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AGENT_LANTERN_PORT must be a valid TCP port.");
  }
  return port;
}

export function loadDaemonConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DaemonConfiguration {
  const configuredOrigins = environment.AGENT_LANTERN_ALLOWED_ORIGINS?.split(
    ",",
  )
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins =
    configuredOrigins && configuredOrigins.length > 0
      ? configuredOrigins
      : defaultAllowedOrigins;

  if (environment.AGENT_LANTERN_TOKEN) {
    const token = environment.AGENT_LANTERN_TOKEN;
    if (token.length < 20) {
      throw new Error(
        "AGENT_LANTERN_TOKEN is required and must contain at least 20 characters.",
      );
    }

    return {
      bindAddress: environment.AGENT_LANTERN_BIND_ADDRESS ?? "127.0.0.1",
      port: parsePort(environment.AGENT_LANTERN_PORT ?? String(DEFAULT_PORT)),
      token,
      allowedOrigins,
      allowAutomaticPortFallback: environment.AGENT_LANTERN_PORT === undefined,
    };
  }

  const shared = loadOrCreateSharedConfiguration(environment);
  return {
    bindAddress: environment.AGENT_LANTERN_BIND_ADDRESS ?? shared.bindAddress,
    port: parsePort(environment.AGENT_LANTERN_PORT ?? String(shared.port)),
    token: shared.token,
    allowedOrigins,
    allowAutomaticPortFallback: environment.AGENT_LANTERN_PORT === undefined,
  };
}

/**
 * Records the port the daemon actually bound to, so the next start prefers it
 * and the overlay can show the reporter the endpoint that really works. Does
 * nothing when the shared setup file is not in use.
 */
export function updateSharedConfigurationPort(
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = sharedConfigurationFilePath(environment);
  const existing = readSharedConfiguration(filePath);
  if (!existing || existing.port === port) {
    return;
  }

  writeSharedConfiguration(
    filePath,
    sharedConfigurationDirectory(environment),
    { ...existing, port },
  );
}
