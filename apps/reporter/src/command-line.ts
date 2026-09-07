import { parseArgs } from "node:util";

import { agentKindSchema, agentStatusSchema } from "@agent-lantern/protocol";

import {
  collectDestinations,
  type DestinationProblem,
  endpointKeyPrefix,
  type ReporterDestination,
} from "./destinations.js";

export interface ReporterOptions {
  command: "hook" | "send";
  agentKind: "codex" | "claude" | "custom";
  destinations: ReporterDestination[];
  destinationProblems: DestinationProblem[];
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
  const { destinations, problems } = collectDestinations(environment, {
    endpoint: parsedArguments.values["daemon-endpoint"],
    token: parsedArguments.values.token,
  });
  // 一個有效目的地都湊不出來才丟出，訊息沿用單一目的地時代的文字。
  if (destinations.length === 0) {
    const detail = problems.map((problem) => problem.message).join("\n");
    throw new Error(detail || `${endpointKeyPrefix} is required.`);
  }

  const statusValue = parsedArguments.values.status;
  const status = statusValue ? agentStatusSchema.parse(statusValue) : undefined;
  if (commandValue === "send" && !status) {
    throw new Error("The send command requires --status.");
  }

  return {
    command: commandValue,
    agentKind,
    destinations,
    destinationProblems: problems,
    status,
    sessionIdentifier: parsedArguments.values["session-identifier"],
    workspacePath: parsedArguments.values["workspace-path"],
    message: parsedArguments.values.message,
  };
}
