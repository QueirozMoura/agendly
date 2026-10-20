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
import { appointmentRoutes } from "./modules/appointments/routes.ts";
import { customerRoutes } from "./modules/customers/routes.ts";
import { availabilityRoutes } from "./modules/availability/routes.ts";
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
  /**
   * Exigir e-mail verificado para criar empresa (R10). Omitido = exigido (padrão seguro). `false` só fora de produção,
   * via REQUIRE_EMAIL_VERIFICATION (config do servidor, nunca do cliente); com `secureCookies` (produção) é recusado.
   */
  requireEmailVerification?: boolean;
}

export interface AppOptions extends HealthDeps {
  logger: FastifyServerOptions["logger"];
  clock?: Clock;
  /**
   * Proxies confiáveis (ver TRUST_PROXY em config/env.ts): nº de saltos ou lista de IPs/CIDRs. NUNCA `true`: confiaria
   * em qualquer X-Forwarded-For e deixaria o cliente forjar o IP (e fugir do rate limit).
   */
  trustProxy?: false | number | string[];
  /** Sem isto, nenhuma rota de autenticação (nem a proteção CSRF) é registrada. */
  auth?: AuthOptions;
}

declare module "fastify" {
  interface FastifyInstance {
    clock: Clock;
  }
}

/**
 * Número de saltos ⇒ função de confiança (os tipos do Fastify não aceitam `number`, embora o runtime aceite): confia nos
 * `n` primeiros saltos a partir da conexão (índice 0 = o proxy mais próximo) e lê o IP do cliente da DIREITA do
 * X-Forwarded-For, então entradas forjadas pelo cliente à esquerda são ignoradas.
 */
export function toFastifyTrustProxy(
  value: AppOptions["trustProxy"],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value === "number") return (_address, hop) => hop < value;
  return value ?? false;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // O id é sempre gerado aqui: um x-request-id enviado pelo cliente não é confiável.
    genReqId: () => randomUUID(),
    requestIdLogLabel: "requestId",
    trustProxy: toFastifyTrustProxy(options.trustProxy),
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
    const requireEmailVerification =
      options.auth.requireEmailVerification ?? true;
    if (secureCookies && !requireEmailVerification)
      throw new Error(
        "A verificação de e-mail não pode ser dispensada em produção.",
      );
    registerCsrfProtection(app, allowedOrigins);
    app.register(cookie);
    app.register(rateLimit, { global: false }); // limites aplicados por rota (createRateLimit)
    app.register(organizationRoutes, {
      prisma,
      secureCookies,
      requireEmailVerification,
    });
    app.register(serviceRoutes, { prisma, secureCookies });
    app.register(professionalRoutes, { prisma, secureCookies });
    app.register(availabilityRoutes, { prisma, secureCookies });
    app.register(appointmentRoutes, { prisma, secureCookies });
    app.register(customerRoutes, { prisma, secureCookies });
    app.register(authRoutes, {
      prisma,
      secureCookies,
      requireEmailVerification,
      outbox: { keyring, clock: app.clock },
    });
  }
  return app;
}
