import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";

import { normalizeAgentHook } from "@agent-lantern/integrations";
import {
  type AgentKind,
  type AgentStatus,
  normalizedAgentEventSchema,
} from "@agent-lantern/protocol";

import { parseCommandLine } from "./command-line.js";
import { loadReporterEnvironment } from "./configuration-file.js";
import { parseJsonObject, readStandardInput } from "./input.js";
import {
  installUsage,
  parseInstallCommandLine,
} from "./install/command-line.js";
import { runInstallCommand } from "./install/index.js";

interface EventDetails {
  agentKind: AgentKind;
  agentDisplayName: string;
  eventType: string;
  status: AgentStatus;
  sessionIdentifier: string;
  workspacePath: string;
  message: string | undefined;
  metadata: Record<string, unknown>;
}

const usage = `agent-status-reporter — Agent Lantern 的 hook reporter

  hook   --agent <codex|claude>            由代理程式的 hook 呼叫，讀取標準輸入的 JSON
  send   --agent <...> --status <...>      手動送出一次狀態，用來測試連線

${installUsage}`;

async function main(): Promise<void> {
  const [commandValue, ...commandArguments] = process.argv.slice(2);

  if (
    commandValue === undefined ||
    commandValue === "help" ||
    commandValue === "--help" ||
    commandValue === "-h"
  ) {
    console.log(usage);
    return;
  }

  // install / uninstall 只改本機設定檔，走和事件回報完全不同的流程。
  if (commandValue === "install" || commandValue === "uninstall") {
    const tokenFromStandardInput = commandArguments.includes("--token-stdin")
      ? (await readStandardInput()).split(/\r?\n/)[0]?.trim()
      : undefined;
    const installEnvironment = await loadReporterEnvironment(process.env);
    await runInstallCommand(
      parseInstallCommandLine(
        commandValue,
        commandArguments,
        installEnvironment,
        tokenFromStandardInput,
      ),
    );
    return;
  }

  const reporterEnvironment = await loadReporterEnvironment(process.env);
  const options = parseCommandLine(process.argv.slice(2), reporterEnvironment);
  const eventDetails =
    options.command === "hook"
      ? await createHookEventDetails(options)
      : createManualEventDetails(options);
  const event = normalizedAgentEventSchema.parse({
    schemaVersion: 1,
    eventIdentifier: randomUUID(),
    occurredAt: new Date().toISOString(),
    eventType: eventDetails.eventType,
    status: eventDetails.status,
    agent: {
      kind: eventDetails.agentKind,
      displayName: eventDetails.agentDisplayName,
    },
    host: { name: reporterEnvironment.AGENT_LANTERN_HOST_NAME ?? hostname() },
    workspace: {
      path: eventDetails.workspacePath,
      name: basename(eventDetails.workspacePath),
    },
    session: { identifier: eventDetails.sessionIdentifier },
    ...(eventDetails.message === undefined
      ? {}
      : { message: eventDetails.message }),
    metadata: eventDetails.metadata,
  });

  const response = await fetch(`${options.daemonEndpoint}/api/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2_500),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Daemon rejected the event with ${response.status}: ${responseText}`,
    );
  }
}

async function createHookEventDetails(
  options: ReturnType<typeof parseCommandLine>,
): Promise<EventDetails> {
  const standardInput = await readStandardInput();
  if (!standardInput) {
    throw new Error(
      "The hook command expects a JSON object on standard input.",
    );
  }

  const hookPayload = parseJsonObject(standardInput);
  const normalizedHook = normalizeAgentHook(options.agentKind, hookPayload);
  const workspacePath = resolve(
    options.workspacePath ?? normalizedHook.workspacePath ?? process.cwd(),
  );

  return {
    agentKind: normalizedHook.agentKind,
    agentDisplayName: normalizedHook.agentDisplayName,
    eventType: normalizedHook.eventType,
    status: normalizedHook.status,
    sessionIdentifier:
      options.sessionIdentifier ??
      normalizedHook.sessionIdentifier ??
      `process-${process.ppid}`,
    workspacePath,
    message: options.message ?? normalizedHook.message,
    metadata: normalizedHook.metadata,
  };
}

function createManualEventDetails(
  options: ReturnType<typeof parseCommandLine>,
): EventDetails {
  const workspacePath = resolve(options.workspacePath ?? process.cwd());
  return {
    agentKind: options.agentKind,
    agentDisplayName:
      options.agentKind === "codex"
        ? "Codex"
        : options.agentKind === "claude"
          ? "Claude"
          : "Custom agent",
    eventType: "manual.status",
    status: options.status ?? "working",
    sessionIdentifier: options.sessionIdentifier ?? `manual-${process.ppid}`,
    workspacePath,
    message: options.message,
    metadata: {},
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agent-status-reporter: ${message}`);
  process.exitCode = 1;
});
