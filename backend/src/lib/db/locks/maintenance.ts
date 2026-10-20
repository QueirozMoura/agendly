import type { PrismaClient } from "../client.ts";

// Limpezas periódicas (R-d): lotes pequenos, `FOR UPDATE SKIP LOCKED` — nunca esperam lock. Todas atuam em
// tabelas-folha (sessões, tokens, outbox); nenhum DELETE de entidade-pai (R-c).

export interface MaintenanceLimits {
  now: Date;
  batch: number;
  /** Folga depois do vencimento antes de apagar (nunca apagar o que ainda pode estar em uso). */
  marginMs: number;
  sessionIdleMs: number;
  revokedRetentionMs: number;
  outboxRetentionMs: number;
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

export async function deleteExpiredSessions(
  prisma: PrismaClient,
  l: MaintenanceLimits,
): Promise<number> {
  const expired = ago(l.now, l.marginMs);
  const idle = ago(l.now, l.sessionIdleMs + l.marginMs);
  const revoked = ago(l.now, l.revokedRetentionMs);
  return prisma.$executeRaw`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions
       WHERE expires_at < ${expired} OR last_seen_at < ${idle} OR revoked_at < ${revoked}
       LIMIT ${l.batch} FOR UPDATE SKIP LOCKED)`;
}

export async function deleteExpiredAuthTokens(
  prisma: PrismaClient,
  l: MaintenanceLimits,
): Promise<number> {
  const old = ago(l.now, l.marginMs);
  return prisma.$executeRaw`
    DELETE FROM auth_tokens WHERE id IN (
      SELECT id FROM auth_tokens
       WHERE expires_at < ${old} OR used_at < ${old}
       LIMIT ${l.batch} FOR UPDATE SKIP LOCKED)`;
}

export async function deleteFinishedOutbox(
  prisma: PrismaClient,
  l: MaintenanceLimits,
): Promise<number> {
  const old = ago(l.now, l.outboxRetentionMs);
  return prisma.$executeRaw`
    DELETE FROM email_outbox WHERE id IN (
      SELECT id FROM email_outbox
       WHERE status IN ('SENT', 'DEAD') AND created_at < ${old}
       LIMIT ${l.batch} FOR UPDATE SKIP LOCKED)`;
}

/**
 * Registros de idempotência vencidos há mais que a margem (6.4). Usa o `now()` do banco, o mesmo que decide a validade na
 * reivindicação (`expires_at <= now()`), e `FOR UPDATE SKIP LOCKED`: a linha de uma transação aberta (recém-criada, com
 * `expires_at` a 24 h) nunca é elegível, e uma linha vencida que está sendo re-reivindicada é pulada. Atravessa empresas
 * por desenho (limpeza por vencimento); não lê nem devolve dados de nenhuma delas.
 */
export async function deleteExpiredIdempotency(
  prisma: PrismaClient,
  l: MaintenanceLimits,
): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM idempotency_records WHERE id IN (
      SELECT id FROM idempotency_records
       WHERE expires_at < now() - (${l.marginMs}::bigint * interval '1 millisecond')
       LIMIT ${l.batch} FOR UPDATE SKIP LOCKED)`;
}
