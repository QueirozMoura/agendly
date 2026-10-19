import type { PrismaClient } from "../../lib/db/client.ts";
import { randomToken, sha256Hex } from "../../lib/crypto.ts";

// Política de 3.1: expiração deslizante por inatividade + teto absoluto; last_seen_at no máx. 1x/hora.
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes em base64url

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}

export interface AuthContext {
  sessionId: string;
  /** Empresa ativa da sessão (4.1). A validade da membership é conferida pelo tenantPlugin, não aqui. */
  activeOrganizationId: string | null;
  lastSeenAt: Date;
  user: SessionUser;
}

export async function createSession(
  prisma: PrismaClient,
  input: {
    userId: string;
    credentialsVersion: number; // a lida na MESMA consulta que leu o hash da senha (3.1)
    now: Date;
    ip: string | undefined;
    userAgent: string | undefined;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(input.now.getTime() + SESSION_ABSOLUTE_MS);
  await prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: sha256Hex(token), // o token em claro nunca é gravado
      credentialsVersion: input.credentialsVersion,
      expiresAt,
      lastSeenAt: input.now,
      createdAt: input.now,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * Valida o token em UMA consulta (sessão + usuário via JOIN). A sessão só vale se, ao mesmo tempo:
 * não foi revogada, não passou da inatividade nem do teto absoluto e a credentials_version dela é
 * IGUAL à atual do usuário. Não há cache entre requisições (3.1, S8).
 */
export async function findValidSession(
  prisma: PrismaClient,
  token: string | undefined,
  now: Date,
): Promise<AuthContext | undefined> {
  if (!token || !TOKEN_SHAPE.test(token)) return undefined;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    relationLoadStrategy: "join",
    select: {
      id: true,
      activeOrganizationId: true,
      credentialsVersion: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          emailVerifiedAt: true,
          credentialsVersion: true,
        },
      },
    },
  });
  if (!session) return undefined;
  const t = now.getTime();
  if (
    session.revokedAt !== null ||
    t >= session.expiresAt.getTime() ||
    t - session.lastSeenAt.getTime() >= SESSION_IDLE_MS ||
    session.credentialsVersion !== session.user.credentialsVersion
  ) {
    return undefined;
  }
  const { id, email, name, emailVerifiedAt } = session.user;
  return {
    sessionId: session.id,
    activeOrganizationId: session.activeOrganizationId,
    lastSeenAt: session.lastSeenAt,
    user: { id, email, name, emailVerifiedAt },
  };
}

/** Atualiza last_seen_at no máximo 1x/hora (UPDATE condicional: concorrência não gera escrita extra). */
export async function touchSession(
  prisma: PrismaClient,
  sessionId: string,
  now: Date,
): Promise<void> {
  await prisma.session.updateMany({
    where: {
      id: sessionId,
      revokedAt: null,
      lastSeenAt: { lt: new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS) },
    },
    data: { lastSeenAt: now },
  });
}

export async function revokeSessionByToken(
  prisma: PrismaClient,
  token: string | undefined,
  now: Date,
): Promise<void> {
  if (!token || !TOKEN_SHAPE.test(token)) return;
  await prisma.session.updateMany({
    where: { tokenHash: sha256Hex(token), revokedAt: null },
    data: { revokedAt: now },
  });
}
