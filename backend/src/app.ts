import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { PrismaClient } from "./lib/db/client.ts";
import type { Keyring } from "./lib/email/keyring.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { registerCsrfProtection } from "./plugins/csrf.ts";
import { professionalRoutes } from "./modules/professionals/routes.ts";
import { serviceRoutes } from "./modules/services/routes.ts";
import { organizationRoutes } from "./modules/organizations/routes.ts";
import { registerErrorHandling } from "./plugins/error-handler.ts";
import { installRouteRegistry } from "./plugins/route-registry.ts";
import {
  registerHealthRoutes,
  type HealthDeps,
} from "./modules/health/routes.ts";
import { systemClock, type Clock } from "./lib/time/clock.ts";

export interface AuthOptions {
  prisma: PrismaClient;
  /** Chaves de cifragem da outbox (o relógio vem de `clock`). */
  keyring: Keyring;
  allowedOrigins: readonly string[];
  /** true em produção: cookie Secure com prefixo __Host-. */
  secureCookies: boolean;
}

export interface AppOptions extends HealthDeps {
  logger: FastifyServerOptions["logger"];
  clock?: Clock;
  /** Só com TRUST_PROXY=true (atrás de proxy reverso): req.ip passa a vir de X-Forwarded-For. */
  trustProxy?: boolean;
  /** Sem isto, nenhuma rota de autenticação (nem a proteção CSRF) é registrada. */
  auth?: AuthOptions;
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
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 16 * 1024, // todos os corpos da API são pequenos JSONs; limita abuso de memória
  });

  app.decorate("clock", options.clock ?? systemClock);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  installRouteRegistry(app); // antes de qualquer rota
  registerErrorHandling(app);
  registerHealthRoutes(app, { checkDatabase: options.checkDatabase });

  if (options.auth) {
    const { prisma, keyring, allowedOrigins, secureCookies } = options.auth;
    registerCsrfProtection(app, allowedOrigins);
    app.register(cookie);
    app.register(rateLimit, { global: false }); // limites aplicados por rota (createRateLimit)
    app.register(organizationRoutes, { prisma, secureCookies });
    app.register(serviceRoutes, { prisma, secureCookies });
    app.register(professionalRoutes, { prisma, secureCookies });
    app.register(authRoutes, {
      prisma,
      secureCookies,
      outbox: { keyring, clock: app.clock },
    });
  }
  return app;
}
