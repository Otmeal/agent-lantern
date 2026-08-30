import type { AgentKind } from "@agent-lantern/protocol";

import { ClaudeIntegration } from "./claude.js";
import { CodexIntegration } from "./codex.js";
import type { AgentIntegration, AgentIntegrationResult } from "./types.js";

const integrations: Readonly<Partial<Record<AgentKind, AgentIntegration>>> = {
  codex: new CodexIntegration(),
  claude: new ClaudeIntegration(),
};

export function normalizeAgentHook(
  agentKind: AgentKind,
  hookPayload: Record<string, unknown>,
): AgentIntegrationResult {
  const integration = integrations[agentKind];
  if (!integration) {
    throw new Error(`No hook integration is registered for ${agentKind}.`);
  }

  return integration.normalize(hookPayload);
}

export type { AgentIntegration, AgentIntegrationResult } from "./types.js";

export {
  buildExampleDocument,
  buildHookInstallationPlan,
  installableAgentKinds,
  isReporterHookCommand,
  quoteCommandPath,
  reporterCommandName,
} from "./hook-installation.js";
export type {
  HookCommandDefinition,
  HookGroupDefinition,
  HookInstallationPlan,
  HookInstallationPlanOptions,
} from "./hook-installation.js";
