import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { registerErrorHandling } from "./plugins/error-handler.ts";
import {
  registerHealthRoutes,
  type HealthDeps,
} from "./modules/health/routes.ts";
import { systemClock, type Clock } from "./lib/time/clock.ts";

export interface AppOptions extends HealthDeps {
  logger: FastifyServerOptions["logger"];
  clock?: Clock;
}

declare module "fastify" {
  interface FastifyInstance {
    clock: Clock;
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // O id é sempre gerado aqui: um x-request-id enviado pelo cliente não é confiável.
    genReqId: () => randomUUID(),
    requestIdLogLabel: "requestId",
  });

  app.decorate("clock", options.clock ?? systemClock);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerErrorHandling(app);
  registerHealthRoutes(app, { checkDatabase: options.checkDatabase });
  return app;
}
