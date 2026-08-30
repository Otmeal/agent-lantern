import { z } from "zod";

/**
 * daemon 的 HTTP payload 格式一旦變動、讓舊版 overlay 讀不動，就要調高這個數字。
 * `sessionSnapshotSchema` 新增必填的 `sessionKey` 正是這種變動：舊版 overlay 若
 * 沿用一個更早版本的 daemon，會在解析 sessions 回應時整批失敗。
 */
export const protocolVersion = 2;

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

/**
 * daemon 的 `/health` 回應。兩個交握欄位都是 optional：交握本身是後來才加上的，
 * 早於它的 daemon 只回 `status` 與 `service`。若在這裡要求必填，最該被判為不相容
 * 的那種舊 daemon 反而會因為驗證失敗而被當成「讀不懂、放行」。缺欄位一律視為
 * 版本過舊。`processIdentifier` 另有一層 optional 的理由：daemon 只把 pid 回給
 * loopback 請求。
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("agent-lantern-daemon"),
  protocolVersion: z.number().int().nonnegative().optional(),
  processIdentifier: z.number().int().positive().optional(),
});

export type AgentKind = z.infer<typeof agentKindSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type NormalizedAgentEvent = z.infer<typeof normalizedAgentEventSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
