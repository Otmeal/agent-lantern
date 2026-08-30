import type { AgentKind, AgentStatus } from "@agent-lantern/protocol";

export interface AgentIntegrationResult {
  agentKind: AgentKind;
  agentDisplayName: string;
  eventType: string;
  status: AgentStatus;
  sessionIdentifier: string | undefined;
  workspacePath: string | undefined;
  message: string | undefined;
  metadata: Record<string, unknown>;
}

export interface AgentIntegration {
  normalize(hookPayload: Record<string, unknown>): AgentIntegrationResult;
}
