import { parseArgs } from "node:util";

import { agentKindSchema, agentStatusSchema } from "@agent-lantern/protocol";

export interface ReporterOptions {
  command: "hook" | "send";
  agentKind: "codex" | "claude" | "custom";
  daemonEndpoint: string;
  token: string;
  status: ReturnType<typeof agentStatusSchema.parse> | undefined;
  sessionIdentifier: string | undefined;
  workspacePath: string | undefined;
  message: string | undefined;
}

export function parseCommandLine(
  argumentValues: string[],
  environment: NodeJS.ProcessEnv,
): ReporterOptions {
  const [commandValue, ...optionArguments] = argumentValues;
  if (commandValue !== "hook" && commandValue !== "send") {
    throw new Error(
      "Usage: agent-status-reporter <hook|send> --agent <codex|claude|custom>",
    );
  }

  const parsedArguments = parseArgs({
    args: optionArguments,
    options: {
      agent: { type: "string" },
      "daemon-endpoint": { type: "string" },
      token: { type: "string" },
      status: { type: "string" },
      "session-identifier": { type: "string" },
      "workspace-path": { type: "string" },
      message: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const agentKind = agentKindSchema.parse(parsedArguments.values.agent);
  const daemonEndpoint =
    parsedArguments.values["daemon-endpoint"] ??
    environment.AGENT_LANTERN_DAEMON_ENDPOINT;
  const token = parsedArguments.values.token ?? environment.AGENT_LANTERN_TOKEN;

  if (!daemonEndpoint) {
    throw new Error("AGENT_LANTERN_DAEMON_ENDPOINT is required.");
  }
  if (!token) {
    throw new Error("AGENT_LANTERN_TOKEN is required.");
  }

  const statusValue = parsedArguments.values.status;
  const status = statusValue ? agentStatusSchema.parse(statusValue) : undefined;
  if (commandValue === "send" && !status) {
    throw new Error("The send command requires --status.");
  }

  return {
    command: commandValue,
    agentKind,
    daemonEndpoint: daemonEndpoint.replace(/\/$/, ""),
    token,
    status,
    sessionIdentifier: parsedArguments.values["session-identifier"],
    workspacePath: parsedArguments.values["workspace-path"],
    message: parsedArguments.values.message,
  };
}
