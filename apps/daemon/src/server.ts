import { normalizedAgentEventSchema } from "@agent-lantern/protocol";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { hasValidBearerToken } from "./authentication.js";
import type { DaemonConfiguration } from "./configuration.js";
import { SessionStore } from "./session-store.js";

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
  });

  await server.register(cors, {
    origin: configuration.allowedOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  server.get("/health", async () => ({
    status: "ok",
    service: "agent-lantern-daemon",
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

  return server;
}
