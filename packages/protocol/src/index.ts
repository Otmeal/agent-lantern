import { z } from "zod";

export const agentKindSchema = z.enum(["codex", "claude", "custom"]);

export const agentStatusSchema = z.enum([
  "starting",
  "working",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);

export const normalizedAgentEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventIdentifier: z.string().min(1).max(200),
  occurredAt: z.iso.datetime({ offset: true }),
  eventType: z.string().min(1).max(100),
  status: agentStatusSchema,
  agent: z.object({
    kind: agentKindSchema,
    displayName: z.string().min(1).max(100),
  }),
  host: z.object({
    name: z.string().min(1).max(255),
  }),
  workspace: z.object({
    path: z.string().min(1).max(4096),
    name: z.string().min(1).max(255),
  }),
  session: z.object({
    identifier: z.string().min(1).max(255),
  }),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const sessionSnapshotSchema = z.object({
  sessionKey: z.string().min(1),
  agent: normalizedAgentEventSchema.shape.agent,
  host: normalizedAgentEventSchema.shape.host,
  workspace: normalizedAgentEventSchema.shape.workspace,
  session: normalizedAgentEventSchema.shape.session,
  status: agentStatusSchema,
  eventType: z.string(),
  message: z.string().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
});

export const sessionsResponseSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  sessions: z.array(sessionSnapshotSchema),
});

export type AgentKind = z.infer<typeof agentKindSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type NormalizedAgentEvent = z.infer<typeof normalizedAgentEventSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
