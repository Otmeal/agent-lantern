import {
  normalizedAgentEventSchema,
  protocolVersion,
} from "@agent-lantern/protocol";
import cors from "@fastify/cors";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { hasValidBearerToken } from "./authentication.js";
import type { DaemonConfiguration } from "./configuration.js";
import { SessionStore } from "./session-store.js";

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    // 連線已經斷掉時 Fastify 取不到對端位址。當成外部請求即可：省略 pid 只是
    // 少一個欄位，把 /health 變成 500 反而會讓 overlay 判定沒有 daemon。
    return false;
  }

  // IPv4-mapped IPv6（`::ffff:127.0.0.1`）在雙堆疊 socket 上很常見，先剝掉前綴
  // 再比對，否則本機請求會被當成外部請求。
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "::1" || normalized.startsWith("127.");
}

/**
 * Routing-level rejections (an over-long path parameter, an unparseable URL)
 * are answered before the hook chain runs, so `@fastify/cors` never gets to
 * add its headers. A browser then discards the response and the overlay only
 * sees `TypeError: Failed to fetch`, with the real status hidden. Re-adding
 * the origin header here keeps those failures legible to the overlay.
 */
function sendFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): void {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && allowedOrigins.includes(requestOrigin)) {
    void reply.header("access-control-allow-origin", requestOrigin);
    void reply.header("vary", "Origin");
  }

  void reply
    .code(error.statusCode ?? 500)
    .send({ error: error.message, code: error.code });
}

export interface ServerDependencies {
  configuration: DaemonConfiguration;
  sessionStore?: SessionStore;
}

export async function buildServer({
  configuration,
  sessionStore = new SessionStore(),
}: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({
    logger: true,
    bodyLimit: 64 * 1024,
    // A sessionKey is the base64url of `[host, workspacePath, agentKind,
    // sessionId]`, so its length follows the workspace path. find-my-way
    // defaults to 100 characters, which a perfectly ordinary path already
    // exceeds, and the resulting 414 is routed before the CORS hook can run
    // (see `frameworkErrors` below).
    routerOptions: { maxParamLength: 2048 },
    // Routing-level rejections never reach the `onRequest` hook that
    // `@fastify/cors` installs, so without this their responses carry no
    // `Access-Control-Allow-Origin` and the overlay sees an opaque
    // `TypeError: Failed to fetch` instead of the status the daemon sent.
    frameworkErrors: (error, request, reply) => {
      sendFrameworkError(
        error,
        request as unknown as FastifyRequest,
        reply as unknown as FastifyReply,
        configuration.allowedOrigins,
      );
    },
  });

  await server.register(cors, {
    origin: configuration.allowedOrigins,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  server.get("/health", async (request) => ({
    status: "ok",
    service: "agent-lantern-daemon",
    protocolVersion,
    // pid 只回給 loopback。daemon 預設綁 0.0.0.0（讓 WSL 與 Tailscale 連得
    // 進來），而 /health 刻意不驗 token，沒有理由把行程資訊送給同一個網段上
    // 的任何人；會用到 pid 的只有本機 overlay 的探測，它一律走 127.0.0.1。
    ...(isLoopbackAddress(request.ip)
      ? { processIdentifier: process.pid }
      : {}),
  }));

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }

    if (
      !hasValidBearerToken(request.headers.authorization, configuration.token)
    ) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  server.post("/api/v1/events", async (request, reply) => {
    const parsedEvent = normalizedAgentEventSchema.safeParse(request.body);
    if (!parsedEvent.success) {
      return reply.code(400).send({
        error: "Invalid event payload",
        details: parsedEvent.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const accepted = sessionStore.apply(parsedEvent.data);
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  server.get("/api/v1/sessions", async () => ({
    generatedAt: new Date().toISOString(),
    sessions: sessionStore.list(),
  }));

  server.delete("/api/v1/sessions/:sessionKey", async (request, reply) => {
    const { sessionKey } = request.params as { sessionKey: string };
    const removed = sessionStore.remove(sessionKey);
    if (!removed) {
      return reply.code(404).send({ error: "Session not found" });
    }

    return reply.code(204).send();
  });

  return server;
}
