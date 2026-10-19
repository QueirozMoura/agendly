// Locks explícitos (único lugar com `FOR NO KEY UPDATE`; V15, regra de 4.4/L8) e hierarquia global de 6.5.
// Domínio de agendamento: N1 customers → N2 professionals (ordenados por id) → N3 idempotência → N4 escritas-folha.
// Domínio de autenticação: A1 users → A2 auth_tokens → A3 sessions → A4 email_outbox.
// Cada aquisição passa pelo guard de ordem (`guard.ts`) antes de a consulta ser enviada.
import type { TxClient } from "../client.ts";
import {
  checkOrder,
  compareIds,
  normalizeId,
  recordAcquired,
} from "./guard.ts";

export {
  LockCoverageViolation,
  LockOrderViolation,
  enterLeafWrite,
  heldProfessionals,
} from "./guard.ts";
export {
  LOCK_TIMEOUT_MS,
  TRANSACTION_OPTIONS,
  runLocked,
} from "./transaction.ts";

/** A1: trava a linha do usuário. Toda operação que altera tokens/sessões de um usuário começa por aqui. */
export async function lockUser(tx: TxClient, userId: string): Promise<void> {
  const key = normalizeId(userId);
  if (checkOrder(tx, "A1", key)) return;
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
  recordAcquired(tx, "A1", key);
}

/** Linha da empresa (6.5: "Editar configurações da empresa": linha da empresa apenas). Serializa edições concorrentes. */
export async function lockOrganization(
  tx: TxClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR NO KEY UPDATE`;
}

/**
 * N2 (6.5): trava os profissionais dados DA EMPRESA dada (`FOR NO KEY UPDATE`). Remove duplicatas, ordena por id e
 * emite UM `SELECT … FOR NO KEY UPDATE` por profissional, em ordem crescente (um único `ORDER BY … FOR NO KEY UPDATE`
 * não garante a ordem de aquisição). Devolve false se algum não existe NESSA empresa (inexistente e alheio são
 * indistinguíveis); nesse caso a chamada para ali e o chamador deve abortar (404). O guard rejeita, antes de esperar,
 * um profissional com id menor que o último travado na transação.
 */
export async function lockProfessionals(
  tx: Pick<TxClient, "$queryRaw">,
  organizationId: string,
  professionalIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(professionalIds.map(normalizeId))].sort(compareIds);
  for (const id of ids) {
    if (checkOrder(tx, "N2", id)) continue; // já travado nesta transação
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals
       WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid
         FOR NO KEY UPDATE`;
    if (rows.length !== 1) return false;
    recordAcquired(tx, "N2", id);
  }
  return true;
}

/** N2 de UM profissional: atalho de `lockProfessionals`. */
export function lockProfessional(
  tx: Pick<TxClient, "$queryRaw">,
  organizationId: string,
  professionalId: string,
): Promise<boolean> {
  return lockProfessionals(tx, organizationId, [professionalId]);
}
