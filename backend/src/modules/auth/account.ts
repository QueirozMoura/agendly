import { randomToken, sha256Hex } from "../../lib/crypto.ts";
import type { PrismaClient, TxClient } from "../../lib/db/client.ts";
import { classifyDbError } from "../../lib/db/errors.ts";
import { lockUser } from "../../lib/db/locks/index.ts";
import { AppError } from "../../lib/errors.ts";
import { enqueueEmail, type OutboxContext } from "../email/outbox.ts";

// Fluxos de conta que mexem em users/auth_tokens/sessions/email_outbox. Toda transação respeita a ordem de
// locks do domínio de autenticação (6.5): A1 users → A2 auth_tokens → A3 sessions → A4 email_outbox.

/** Validade dos links de verificação e de redefinição (3.4: 30–60 min; 3.6 supõe tokens de vida curta). */
export const AUTH_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Validade (not_after) dos avisos sem token: depois disso já não fazem sentido. */
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AccountDeps {
  prisma: PrismaClient;
  outbox: OutboxContext;
}

type TokenType = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

const tokenInvalid = () =>
  new AppError(
    "TOKEN_INVALID_OR_EXPIRED",
    400,
    "Link inválido, expirado ou já utilizado.",
  );

/** Token de 32 bytes do CSPRNG; só o SHA-256 vai ao banco. Invalida antes os pendentes do mesmo tipo. */
async function issueToken(
  tx: TxClient,
  userId: string,
  type: TokenType,
  now: Date,
): Promise<string> {
  await tx.authToken.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: now },
  });
  const raw = randomToken(32);
  await tx.authToken.create({
    data: {
      userId,
      type,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(now.getTime() + AUTH_TOKEN_TTL_MS),
      createdAt: now,
    },
  });
  return raw;
}

/**
 * Cadastro sem enumeração (3.3): e-mail novo => usuário + token + VERIFY_EMAIL na mesma transação;
 * e-mail existente (inclusive perdendo uma corrida) => só o aviso ACCOUNT_EXISTS. Quem chama responde igual.
 */
export async function registerUser(
  deps: AccountDeps,
  input: { email: string; name: string; passwordHash: string },
): Promise<void> {
  const now = deps.outbox.clock.now();
  const existing = await deps.prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (!existing) {
    try {
      await deps.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash: input.passwordHash,
            createdAt: now,
          },
        });
        const token = await issueToken(tx, user.id, "EMAIL_VERIFICATION", now);
        await enqueueEmail(tx, deps.outbox, {
          to: input.email,
          template: "VERIFY_EMAIL",
          payload: { name: input.name, token },
          ttlMs: AUTH_TOKEN_TTL_MS,
        });
      });
      return;
    } catch (err) {
      if (classifyDbError(err) !== "unique_violation") throw err; // corrida: outro cadastro venceu
    }
  }
  await deps.prisma.$transaction((tx) =>
    enqueueEmail(tx, deps.outbox, {
      to: input.email,
      template: "ACCOUNT_EXISTS",
      payload: {},
      ttlMs: NOTICE_TTL_MS,
    }),
  );
}

/** Reenvio da verificação: já verificado => não faz nada (a resposta é a mesma). */
export async function resendVerification(
  deps: AccountDeps,
  userId: string,
): Promise<void> {
  const now = deps.outbox.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    await lockUser(tx, userId); // A1
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt) return;
    const token = await issueToken(tx, userId, "EMAIL_VERIFICATION", now); // A2
    await enqueueEmail(tx, deps.outbox, {
      to: user.email,
      template: "VERIFY_EMAIL",
      payload: { name: user.name, token },
      ttlMs: AUTH_TOKEN_TTL_MS,
    }); // A4
  });
}

/** Consumo atômico e de uso único do token de verificação (3.3). */
export async function verifyEmail(
  deps: AccountDeps,
  rawToken: string,
): Promise<void> {
  const tokenHash = sha256Hex(rawToken);
  // Leitura SEM lock só para descobrir o usuário (passo 0).
  const found = await deps.prisma.authToken.findUnique({
    where: { tokenHash },
    select: { userId: true, type: true },
  });
  if (!found || found.type !== "EMAIL_VERIFICATION") throw tokenInvalid();

  const now = deps.outbox.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    await lockUser(tx, found.userId); // A1
    const { count } = await tx.authToken.updateMany({
      where: {
        tokenHash,
        type: "EMAIL_VERIFICATION",
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    }); // A2
    if (count === 0) throw tokenInvalid(); // rollback; mesmo erro para expirado, usado e inexistente
    await tx.user.updateMany({
      where: { id: found.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
  });
}

/** Solicitação de redefinição (3.4): o chamador responde 202 sempre, exista o usuário ou não. */
export async function requestPasswordReset(
  deps: AccountDeps,
  email: string,
): Promise<void> {
  const user = await deps.prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) return;
  const now = deps.outbox.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id); // A1
    const token = await issueToken(tx, user.id, "PASSWORD_RESET", now); // A2 (invalida os pendentes)
    await enqueueEmail(tx, deps.outbox, {
      to: user.email,
      template: "RESET_PASSWORD",
      payload: { token },
      ttlMs: AUTH_TOKEN_TTL_MS,
    }); // A4
  });
}

/**
 * Redefinição de senha (3.4), tudo em UMA transação READ COMMITTED. O hash Argon2id da nova senha já vem
 * calculado (operação lenta: não pode segurar locks). Qualquer falha desfaz tudo e o token continua utilizável.
 */
export async function resetPassword(
  deps: AccountDeps,
  input: { rawToken: string; newPasswordHash: string },
): Promise<void> {
  const tokenHash = sha256Hex(input.rawToken);
  // 0. leitura sem lock do token para descobrir o usuário
  const found = await deps.prisma.authToken.findUnique({
    where: { tokenHash },
    select: { userId: true, type: true },
  });
  if (!found || found.type !== "PASSWORD_RESET") throw tokenInvalid();

  const now = deps.outbox.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    await lockUser(tx, found.userId); // 1. A1: serializa com qualquer outra operação de credencial
    const { count } = await tx.authToken.updateMany({
      where: {
        tokenHash,
        type: "PASSWORD_RESET",
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    }); // 2. A2: consome o token (uso único)
    if (count === 0) throw tokenInvalid();
    const user = await tx.user.update({
      where: { id: found.userId },
      data: {
        passwordHash: input.newPasswordHash,
        credentialsVersion: { increment: 1 },
      },
      select: { email: true },
    }); // 3. nova senha + nova versão de credenciais
    await tx.authToken.updateMany({
      where: { userId: found.userId, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: now },
    }); // 4. demais tokens pendentes
    await tx.session.updateMany({
      where: { userId: found.userId, revokedAt: null },
      data: { revokedAt: now },
    }); // 5. A3: revoga sessões visíveis (a versão fecha a janela das que não são)
    await enqueueEmail(tx, deps.outbox, {
      to: user.email,
      template: "PASSWORD_CHANGED",
      payload: {},
      ttlMs: NOTICE_TTL_MS,
    }); // 6. A4
  });
}

/** Sair de todos os dispositivos: A1 → A3. Não altera a credentials_version (só troca de senha altera). */
export async function logoutAllDevices(
  deps: AccountDeps,
  userId: string,
): Promise<void> {
  const now = deps.outbox.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  });
}
