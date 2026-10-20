import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sha256Hex } from "../../lib/crypto.ts";
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
import { makeAuthenticate } from "./authenticate.ts";
import type { OutboxContext } from "../email/outbox.ts";
import {
  logoutAllDevices,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
  type AccountDeps,
} from "./account.ts";
import {
  forgotPasswordBody,
  loginBody,
  registerBody,
  resetPasswordBody,
  verifyEmailBody,
} from "./schemas.ts";
import {
  createSession,
  revokeSessionByToken,
  type AuthContext,
} from "./session.ts";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
  /** Só informativo para a SPA (`emailVerificationRequired`); quem impõe a regra é a rota que a exige. */
  requireEmailVerification: boolean;
  outbox: OutboxContext;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Chave (hash do e-mail ou do id do usuário) dos limitadores por identidade; definida só nas rotas de auth. */
    rateKey?: string;
  }
}

// Limites iniciais (armazenamento em memória, instância única: 3.1 e risco 14).
const LOGIN_PER_IP = { max: 30, timeWindow: "15 minutes" };
const LOGIN_PER_EMAIL = { max: 8, timeWindow: "15 minutes" };
const REGISTER_PER_IP = { max: 10, timeWindow: "1 hour" };
const REGISTER_PER_EMAIL = { max: 3, timeWindow: "1 hour" };
const FORGOT_PER_IP = { max: 10, timeWindow: "1 hour" };
const FORGOT_PER_EMAIL = { max: 3, timeWindow: "1 hour" };
const VERIFY_PER_IP = { max: 20, timeWindow: "15 minutes" };
const RESET_PER_IP = { max: 10, timeWindow: "15 minutes" };
const RESEND_PER_USER = { max: 3, timeWindow: "1 hour" };
const RESEND_PER_IP = { max: 10, timeWindow: "1 hour" };

const FORGOT_MESSAGE =
  "Se o e-mail estiver cadastrado, enviaremos as instruções para redefinir a senha.";
const RESEND_MESSAGE =
  "Se a confirmação de e-mail ainda for necessária, enviaremos um novo link.";

/** Rotas de autenticação/conta: sem escopo de empresa (classificação exigida pelo registro de rotas, 4.4 item 4). */
const AUTH_ROUTE = { access: "auth" } as const;

const REGISTER_MESSAGE =
  "Cadastro recebido. Use seu e-mail e senha para entrar. Se já houver uma conta com este e-mail, nada foi alterado.";

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies, requireEmailVerification } = opts;
  const authenticate = makeAuthenticate(app, { prisma, secureCookies });
  const account: AccountDeps = { prisma, outbox: opts.outbox };
  const cookieName = sessionCookieName(secureCookies);

  // Duas chaves independentes: por IP e por e-mail (hash, para não guardar PII na memória do limiter).
  const makeLimiter = (
    cfg: { max: number; timeWindow: string },
    key: (r: FastifyRequest) => string,
  ) => app.createRateLimit({ ...cfg, keyGenerator: key });
  const limiters = {
    loginIp: makeLimiter(LOGIN_PER_IP, (r) => `login:ip:${r.ip}`),
    loginEmail: makeLimiter(LOGIN_PER_EMAIL, (r) => `login:email:${r.rateKey}`),
    registerIp: makeLimiter(REGISTER_PER_IP, (r) => `register:ip:${r.ip}`),
    registerEmail: makeLimiter(
      REGISTER_PER_EMAIL,
      (r) => `register:email:${r.rateKey}`,
    ),
    forgotIp: makeLimiter(FORGOT_PER_IP, (r) => `forgot:ip:${r.ip}`),
    forgotEmail: makeLimiter(
      FORGOT_PER_EMAIL,
      (r) => `forgot:email:${r.rateKey}`,
    ),
    verifyIp: makeLimiter(VERIFY_PER_IP, (r) => `verify:ip:${r.ip}`),
    resetIp: makeLimiter(RESET_PER_IP, (r) => `reset:ip:${r.ip}`),
    resendUser: makeLimiter(RESEND_PER_USER, (r) => `resend:user:${r.rateKey}`),
    resendIp: makeLimiter(RESEND_PER_IP, (r) => `resend:ip:${r.ip}`),
  };

  type Limiter = (typeof limiters)[keyof typeof limiters];

  /** Aplica os limitadores em ordem (IP primeiro). `identity` (e-mail ou id) vira a chave, em hash. */
  async function enforce(
    request: FastifyRequest,
    reply: FastifyReply,
    list: Limiter[],
    identity?: string,
  ): Promise<void> {
    if (identity !== undefined) request.rateKey = sha256Hex(identity);
    for (const limiter of list) {
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
  app.post(
    "/api/auth/register",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      const body = registerBody.parse(request.body);
      await enforce(
        request,
        reply,
        [limiters.registerIp, limiters.registerEmail],
        body.email,
      );

      // O hash é calculado SEMPRE, antes de saber se o e-mail existe: mesmo custo nos dois caminhos.
      const passwordHash = await hashPassword(body.password);
      await registerUser(account, {
        email: body.email,
        name: body.name,
        passwordHash,
      });
      return reply.status(202).send({ message: REGISTER_MESSAGE });
    },
  );

  // --- Login ---
  app.post(
    "/api/auth/login",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      const body = loginBody.parse(request.body);
      await enforce(
        request,
        reply,
        [limiters.loginIp, limiters.loginEmail],
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
      return reply.send({ user: publicUser(user, requireEmailVerification) });
    },
  );

  // --- Logout: idempotente; sempre limpa o cookie ---
  app.post(
    "/api/auth/logout",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      await revokeSessionByToken(
        prisma,
        request.cookies[cookieName],
        app.clock.now(),
      );
      clearSessionCookie(reply, secureCookies);
      return reply.status(204).send();
    },
  );

  // --- Sair de todos os dispositivos (A1 → A3) ---
  app.post(
    "/api/auth/logout-all",
    { preHandler: authenticate, config: AUTH_ROUTE },
    async (request, reply) => {
      await logoutAllDevices(account, (request.auth as AuthContext).user.id);
      clearSessionCookie(reply, secureCookies);
      return reply.status(204).send();
    },
  );

  // --- Verificação de e-mail (3.3): token no CORPO, nunca em query string ---
  app.post(
    "/api/auth/verify-email",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      const body = verifyEmailBody.parse(request.body);
      await enforce(request, reply, [limiters.verifyIp]);
      await verifyEmail(account, body.token);
      return reply.status(204).send();
    },
  );

  // --- Reenvio da verificação: limite por usuário e por IP; resposta igual verificado ou não ---
  app.post(
    "/api/auth/resend-verification",
    { preHandler: authenticate, config: AUTH_ROUTE },
    async (request, reply) => {
      const { user } = request.auth as AuthContext;
      await enforce(
        request,
        reply,
        [limiters.resendIp, limiters.resendUser],
        user.id,
      );
      await resendVerification(account, user.id);
      return reply.status(202).send({ message: RESEND_MESSAGE });
    },
  );

  // --- Recuperação de senha (3.4): 202 e mensagem idênticas exista o e-mail ou não ---
  app.post(
    "/api/auth/forgot-password",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      const body = forgotPasswordBody.parse(request.body);
      await enforce(
        request,
        reply,
        [limiters.forgotIp, limiters.forgotEmail],
        body.email,
      );
      await requestPasswordReset(account, body.email);
      return reply.status(202).send({ message: FORGOT_MESSAGE });
    },
  );

  app.post(
    "/api/auth/reset-password",
    { config: AUTH_ROUTE },
    async (request, reply) => {
      const body = resetPasswordBody.parse(request.body);
      await enforce(request, reply, [limiters.resetIp]);
      // Hash lento calculado ANTES da transação (não pode segurar locks), mesmo se o token for inválido.
      const newPasswordHash = await hashPassword(body.newPassword);
      await resetPassword(account, { rawToken: body.token, newPasswordHash });
      clearSessionCookie(reply, secureCookies);
      return reply.status(204).send();
    },
  );

  // --- Sessão atual ---
  app.get(
    "/api/me",
    { preHandler: authenticate, config: AUTH_ROUTE },
    async (request) => {
      return {
        user: publicUser(
          (request.auth as AuthContext).user,
          requireEmailVerification,
        ),
      };
    },
  );
}

function publicUser(
  u: {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: Date | null;
  },
  requireEmailVerification: boolean,
) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerifiedAt !== null,
    // Reflete a regra EFETIVA do servidor, para a interface não prometer nem negar o que a API não faz.
    emailVerificationRequired: requireEmailVerification,
  };
}
