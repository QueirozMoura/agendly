import type { FastifyBaseLogger } from "fastify";
import { DecryptError, decryptPayload } from "../lib/crypto.ts";
import type { PrismaClient } from "../lib/db/client.ts";
import { claimEmailBatch, type ClaimedEmail } from "../lib/db/locks/outbox.ts";
import type { Keyring } from "../lib/email/keyring.ts";
import { EmailSendError, type EmailSender } from "../lib/email/sender.ts";
import { sanitizeText } from "../lib/logger.ts";
import type { Clock } from "../lib/time/clock.ts";
import { renderEmail, payloadSchemas } from "../modules/email/templates.ts";

export interface OutboxConfig {
  batchSize: number;
  /** Duração do lease: depois dele outro ciclo pode reivindicar a linha (duplicata possível; at-least-once). */
  leaseMs: number;
  /** Timeout da chamada ao provedor: bem menor que o lease, para reduzir envios em curso quando ele vence. */
  sendTimeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_OUTBOX_CONFIG: OutboxConfig = {
  batchSize: 20,
  leaseMs: 60_000,
  sendTimeoutMs: 10_000,
  maxAttempts: 8,
  backoffBaseMs: 30_000,
  backoffMaxMs: 15 * 60_000,
};

export interface OutboxDeps {
  prisma: PrismaClient;
  keyring: Keyring;
  sender: EmailSender;
  clock: Clock;
  logger: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  baseUrl: string;
  config?: Partial<OutboxConfig>;
  /** Fonte de aleatoriedade do jitter (injetável em testes). */
  random?: () => number;
}

type DeadReason =
  | "MAX_ATTEMPTS"
  | "EXPIRED"
  | "PERMANENT_ERROR"
  | "KEY_UNAVAILABLE"
  | "DECRYPT_FAILED";

/** Backoff exponencial com jitter de ±20%, limitado por backoffMaxMs. */
export function backoffMs(
  attempts: number,
  cfg: OutboxConfig,
  random: () => number,
): number {
  const base = Math.min(
    cfg.backoffBaseMs * 2 ** (attempts - 1),
    cfg.backoffMaxMs,
  );
  return Math.round(base * (0.8 + 0.4 * random()));
}

function timeoutAfter(
  ms: number,
  controller: AbortController,
): { promise: Promise<never>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EmailSendError("timeout ao chamar o provedor de e-mail"));
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Um ciclo da outbox (3.6): reivindica um lote e processa cada linha. Devolve quantas linhas processou.
 * O provedor é chamado FORA de qualquer transação e a atualização final é condicionada ao lock_token.
 */
export async function runOutboxCycle(deps: OutboxDeps): Promise<number> {
  const cfg = { ...DEFAULT_OUTBOX_CONFIG, ...deps.config };
  const claimed = await claimEmailBatch(deps.prisma, {
    now: deps.clock.now(),
    limit: cfg.batchSize,
    leaseMs: cfg.leaseMs,
  });
  // Linhas independentes: uma falha em uma não impede as demais.
  await Promise.all(claimed.map((row) => processRow(deps, cfg, row)));
  return claimed.length;
}

async function processRow(
  deps: OutboxDeps,
  cfg: OutboxConfig,
  row: ClaimedEmail,
): Promise<void> {
  const secrets = [...deps.keyring.secrets()];
  try {
    const now = deps.clock.now();
    if (now >= row.notAfter) return await finishDead(deps, row, "EXPIRED"); // sem chamar o provedor
    if (row.attempts > cfg.maxAttempts)
      return await finishDead(deps, row, "MAX_ATTEMPTS");

    // --- decifrar (chave desconhecida e payload inválido são terminais) ---
    const key = row.keyId ? deps.keyring.get(row.keyId) : undefined;
    if (!key) return await finishDead(deps, row, "KEY_UNAVAILABLE");
    let payload: unknown;
    try {
      if (!row.payloadEncrypted) throw new DecryptError("sem payload");
      payload = JSON.parse(decryptPayload(key, row.payloadEncrypted, row.id));
      payloadSchemas[row.template].parse(payload);
    } catch {
      return await finishDead(deps, row, "DECRYPT_FAILED");
    }
    for (const v of Object.values(payload as Record<string, unknown>)) {
      if (typeof v === "string" && v) secrets.push(v);
    }

    const message = {
      to: row.toEmail,
      ...renderEmail(row.template, payload, deps.baseUrl),
    };

    // --- enviar (fora de transação, com timeout) ---
    const controller = new AbortController();
    const timeout = timeoutAfter(cfg.sendTimeoutMs, controller);
    try {
      await Promise.race([
        deps.sender.send(message, {
          signal: controller.signal,
          idempotencyKey: row.id, // estável: a mesma mensagem usa a mesma chave em toda tentativa
        }),
        timeout.promise,
      ]);
    } finally {
      timeout.clear();
    }
    await finishSent(deps, row);
  } catch (err) {
    await handleSendFailure(deps, cfg, row, err, secrets);
  }
}

async function handleSendFailure(
  deps: OutboxDeps,
  cfg: OutboxConfig,
  row: ClaimedEmail,
  err: unknown,
  secrets: string[],
): Promise<void> {
  // Nunca grava token, payload ou chave: a mensagem é sanitizada com todos os valores conhecidos.
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : "erro desconhecido";
  const lastError = sanitizeText(raw, secrets).slice(0, 300);
  try {
    if (err instanceof EmailSendError && err.permanent) {
      return await finishDead(deps, row, "PERMANENT_ERROR", lastError);
    }
    if (row.attempts >= cfg.maxAttempts) {
      return await finishDead(deps, row, "MAX_ATTEMPTS", lastError);
    }
    const now = deps.clock.now();
    // Retry-After do provedor vale se for maior que o backoff, limitado ao teto operacional (backoffMaxMs).
    const asked =
      err instanceof EmailSendError && err.retryAfterMs !== undefined
        ? Math.min(err.retryAfterMs, cfg.backoffMaxMs)
        : 0;
    const delay = Math.max(
      backoffMs(row.attempts, cfg, deps.random ?? Math.random),
      asked,
    );
    const { count } = await deps.prisma.emailOutbox.updateMany({
      where: { id: row.id, lockToken: row.lockToken },
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(now.getTime() + delay),
        lockedUntil: null,
        lockToken: null,
        lastError,
      },
    });
    if (count === 0) logStale(deps, row);
  } catch (finalErr) {
    // Falha ao registrar o resultado: o lease vencerá e a linha será reivindicada de novo.
    deps.logger.error(
      { err: finalErr, outboxId: row.id },
      "failed to record email outbox result",
    );
  }
}

async function finishSent(deps: OutboxDeps, row: ClaimedEmail): Promise<void> {
  const { count } = await deps.prisma.emailOutbox.updateMany({
    where: { id: row.id, lockToken: row.lockToken },
    data: {
      status: "SENT",
      sentAt: deps.clock.now(),
      payloadEncrypted: null, // O8: o token em claro deixa de existir no banco
      lockedUntil: null,
      lockToken: null,
      lastError: null,
    },
  });
  if (count === 0) logStale(deps, row);
}

async function finishDead(
  deps: OutboxDeps,
  row: ClaimedEmail,
  reason: DeadReason,
  lastError?: string,
): Promise<void> {
  const { count } = await deps.prisma.emailOutbox.updateMany({
    where: { id: row.id, lockToken: row.lockToken },
    data: {
      status: "DEAD",
      deadReason: reason,
      payloadEncrypted: null,
      lockedUntil: null,
      lockToken: null,
      lastError: lastError ?? null,
    },
  });
  if (count === 0) return logStale(deps, row);
  // Alerta operacional (7): erro estruturado, sem payload nem token.
  deps.logger.error(
    { outboxId: row.id, template: row.template, reason },
    "email outbox message is dead",
  );
}

function logStale(deps: OutboxDeps, row: ClaimedEmail): void {
  // Outro ciclo reivindicou esta linha (lease vencido): o resultado deste processo atrasado é descartado.
  deps.logger.warn(
    { outboxId: row.id },
    "email outbox update skipped: lock lost",
  );
}
