import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sha256Hex } from "../../lib/crypto.ts";
import { classifyDbError } from "../../lib/db/errors.ts";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from "./cookie.ts";
import {
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "./password.ts";
import { loginBody, registerBody } from "./schemas.ts";
import {
  SESSION_TOUCH_INTERVAL_MS,
  createSession,
  findValidSession,
  revokeSessionByToken,
  touchSession,
  type AuthContext,
} from "./session.ts";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    /** Chave (hash do e-mail) usada pelos limitadores por e-mail; definida só dentro desta rota. */
    emailRateKey?: string;
  }
}

// Limites iniciais (armazenamento em memória, instância única: 3.1 e risco 14).
const LOGIN_PER_IP = { max: 30, timeWindow: "15 minutes" };
const LOGIN_PER_EMAIL = { max: 8, timeWindow: "15 minutes" };
const REGISTER_PER_IP = { max: 10, timeWindow: "1 hour" };
const REGISTER_PER_EMAIL = { max: 3, timeWindow: "1 hour" };

const REGISTER_MESSAGE =
  "Cadastro recebido. Use seu e-mail e senha para entrar. Se já houver uma conta com este e-mail, nada foi alterado.";

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const cookieName = sessionCookieName(secureCookies);

  // Duas chaves independentes: por IP e por e-mail (hash, para não guardar PII na memória do limiter).
  const makeLimiter = (
    cfg: { max: number; timeWindow: string },
    key: (r: FastifyRequest) => string,
  ) => app.createRateLimit({ ...cfg, keyGenerator: key });
  const limiters = {
    loginIp: makeLimiter(LOGIN_PER_IP, (r) => `login:ip:${r.ip}`),
    loginEmail: makeLimiter(
      LOGIN_PER_EMAIL,
      (r) => `login:email:${r.emailRateKey}`,
    ),
    registerIp: makeLimiter(REGISTER_PER_IP, (r) => `register:ip:${r.ip}`),
    registerEmail: makeLimiter(
      REGISTER_PER_EMAIL,
      (r) => `register:email:${r.emailRateKey}`,
    ),
  };

  async function enforce(
    request: FastifyRequest,
    reply: FastifyReply,
    emailLimiter: (typeof limiters)[keyof typeof limiters],
    ipLimiter: (typeof limiters)[keyof typeof limiters],
    email: string,
  ): Promise<void> {
    request.emailRateKey = sha256Hex(email);
    for (const limiter of [ipLimiter, emailLimiter]) {
      const result = await limiter(request);
      // Atenção: createRateLimit devolve isAllowed=false também para requisições DENTRO do limite
      // (isAllowed=true só para chaves em allowList); o bloqueio real é isExceeded/isBanned.
      if (!result.isAllowed && (result.isExceeded || result.isBanned)) {
        reply.header("retry-after", String(result.ttlInSeconds));
        throw new AppError(
          "RATE_LIMITED",
          429,
          "Muitas tentativas. Tente novamente mais tarde.",
        );
      }
    }
  }

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/auth/") || request.url === "/api/me") {
      reply.header("cache-control", "no-store");
    }
  });

  // --- Cadastro: resposta idêntica exista a conta ou não (sem enumeração) ---
  app.post("/api/auth/register", async (request, reply) => {
    const body = registerBody.parse(request.body);
    await enforce(
      request,
      reply,
      limiters.registerEmail,
      limiters.registerIp,
      body.email,
    );

    // O hash é calculado SEMPRE, antes de saber se o e-mail existe: mesmo custo nos dois caminhos.
    const passwordHash = await hashPassword(body.password);
    try {
      await prisma.user.create({
        data: { email: body.email, name: body.name, passwordHash },
      });
    } catch (err) {
      // E-mail já cadastrado (inclui corrida entre dois cadastros): mesma resposta, nada é alterado.
      // O aviso por e-mail (ACCOUNT_EXISTS) e a verificação dependem da outbox: Etapa 5.
      if (classifyDbError(err) !== "unique_violation") throw err;
    }
    return reply.status(202).send({ message: REGISTER_MESSAGE });
  });

  // --- Login ---
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    await enforce(
      request,
      reply,
      limiters.loginEmail,
      limiters.loginIp,
      body.email,
    );

    // Leitura ÚNICA: hash da senha e credentials_version vêm da mesma linha (3.1, S9). A sessão
    // criada abaixo carrega exatamente a versão que acompanhava o hash verificado.
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
        passwordHash: true,
        credentialsVersion: true,
      },
    });

    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyAgainstDummy(body.password);
    if (!user || !ok) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        401,
        "E-mail ou senha incorretos.",
      );
    }

    const { token } = await createSession(prisma, {
      userId: user.id,
      credentialsVersion: user.credentialsVersion,
      now: app.clock.now(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    setSessionCookie(reply, secureCookies, token);
    return reply.send({ user: publicUser(user) });
  });

  // --- Logout: idempotente; sempre limpa o cookie ---
  app.post("/api/auth/logout", async (request, reply) => {
    await revokeSessionByToken(
      prisma,
      request.cookies[cookieName],
      app.clock.now(),
    );
    clearSessionCookie(reply, secureCookies);
    return reply.status(204).send();
  });

  // --- Sessão atual ---
  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    return { user: publicUser((request.auth as AuthContext).user) };
  });

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const now = app.clock.now();
    const ctx = await findValidSession(
      prisma,
      request.cookies[cookieName],
      now,
    );
    if (!ctx) {
      clearSessionCookie(reply, secureCookies); // sessão inválida/expirada/desatualizada: limpa o cookie
      throw new AppError(
        "UNAUTHENTICATED",
        401,
        "Sessão inválida ou expirada.",
      );
    }
    request.auth = ctx;
    if (now.getTime() - ctx.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      try {
        await touchSession(prisma, ctx.sessionId, now);
      } catch (err) {
        request.log.warn({ err }, "failed to update session last_seen_at"); // não derruba a requisição
      }
    }
  }
}

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerifiedAt !== null,
  };
}
