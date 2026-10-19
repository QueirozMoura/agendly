import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { clearSessionCookie, sessionCookieName } from "./cookie.ts";
import {
  SESSION_TOUCH_INTERVAL_MS,
  findValidSession,
  touchSession,
  type AuthContext,
} from "./session.ts";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * preHandler de autenticação: a identidade vem EXCLUSIVAMENTE da sessão validada no servidor
 * (cookie → hash → sessão + usuário em uma consulta, com credentials_version; sem cache). Compartilhado por
 * todas as rotas autenticadas.
 */
export function makeAuthenticate(
  app: FastifyInstance,
  opts: { prisma: PrismaClient; secureCookies: boolean },
) {
  const cookieName = sessionCookieName(opts.secureCookies);
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const now = app.clock.now();
    const ctx = await findValidSession(
      opts.prisma,
      request.cookies[cookieName],
      now,
    );
    if (!ctx) {
      clearSessionCookie(reply, opts.secureCookies); // sessão inválida/expirada/desatualizada: limpa o cookie
      throw new AppError(
        "UNAUTHENTICATED",
        401,
        "Sessão inválida ou expirada.",
      );
    }
    request.auth = ctx;
    if (now.getTime() - ctx.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      try {
        await touchSession(opts.prisma, ctx.sessionId, now);
      } catch (err) {
        request.log.warn({ err }, "failed to update session last_seen_at"); // não derruba a requisição
      }
    }
  };
}
