// Travas do domínio de agendamento além do profissional (6.5): N1 cliente, N3 idempotência e a linha do agendamento (N4).
// Todo SQL cru daqui filtra por `organization_id` (o chamador passa o do contexto validado da sessão) e passa pelo guard
// de ordem ANTES de ser emitido. A ordem global é N1 → N2 (`lockProfessionals`) → N3 → N4.
import { newId } from "../../ids.ts";
import type { TxClient } from "../client.ts";
import { checkOrder, normalizeId, recordAcquired } from "./guard.ts";

type Raw = Pick<TxClient, "$queryRaw">;

/** N1 por id: trava a linha do cliente DA EMPRESA. `false` se não existe nessa empresa (inexistente = alheio). */
export async function lockCustomerById(
  tx: Raw,
  organizationId: string,
  customerId: string,
): Promise<boolean> {
  const key = `id:${normalizeId(customerId)}`;
  if (checkOrder(tx, "N1", key)) return true;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM customers
     WHERE organization_id = ${organizationId}::uuid AND id = ${customerId}::uuid
       FOR NO KEY UPDATE`;
  if (rows.length !== 1) return false;
  recordAcquired(tx, "N1", key);
  return true;
}

export interface NewCustomer {
  name: string;
  phoneE164: string;
  email: string | null;
  notes: string | null;
}

/**
 * N1 por telefone (cliente novo ou existente): `INSERT … ON CONFLICT DO NOTHING` e trava a linha. Um cliente que já
 * existe NÃO é sobrescrito (os dados informados são ignorados). A espera por um INSERT concorrente do mesmo telefone é
 * em índice único (folha). Devolve o id do cliente.
 */
export async function ensureAndLockCustomerByPhone(
  tx: Raw & Pick<TxClient, "$executeRaw">,
  organizationId: string,
  customer: NewCustomer,
): Promise<string> {
  const key = `phone:${customer.phoneE164}`;
  checkOrder(tx, "N1", key);
  await tx.$executeRaw`
    INSERT INTO customers (id, organization_id, name, phone_e164, email, notes, created_at, updated_at)
    VALUES (${newId()}::uuid, ${organizationId}::uuid, ${customer.name}, ${customer.phoneE164},
            ${customer.email}, ${customer.notes}, now(), now())
    ON CONFLICT (organization_id, phone_e164) DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM customers
     WHERE organization_id = ${organizationId}::uuid AND phone_e164 = ${customer.phoneE164}
       FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) throw new Error("cliente não encontrado após INSERT … ON CONFLICT");
  recordAcquired(tx, "N1", key);
  return row.id;
}

/** N4: relê o agendamento COM trava (confere profissional e `version` depois). `false` se não existe na empresa. */
export async function lockAppointment(
  tx: Raw,
  organizationId: string,
  appointmentId: string,
): Promise<boolean> {
  const key = `appt:${normalizeId(appointmentId)}`;
  if (checkOrder(tx, "N4", key)) return true;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM appointments
     WHERE organization_id = ${organizationId}::uuid AND id = ${appointmentId}::uuid
       FOR NO KEY UPDATE`;
  if (rows.length !== 1) return false;
  recordAcquired(tx, "N4", key);
  return true;
}

export type IdempotencyClaim =
  | { kind: "claimed" }
  | {
      kind: "existing";
      requestHash: string;
      responseStatus: number | null;
      responseBody: unknown;
    };

const IDEMPOTENCY_TTL_SQL = "24 hours";

/**
 * N3 (6.4): reivindica a chave `(empresa, escopo, chave)` NA transação do agendamento, depois de N1/N2. Insere, ou
 * re-reivindica atomicamente um registro VENCIDO (V13); se há registro vigente, devolve seu hash e resposta. Como o
 * registro só fica visível junto com o agendamento (mesmo commit), uma requisição concorrente espera o índice único
 * (folha) e então cai em `existing`. A validade usa o `now()` do banco, o mesmo da limpeza.
 */
export async function claimIdempotencyKey(
  tx: Raw,
  organizationId: string,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const lockKey = `${scope}:${normalizeId(key)}`;
  const held = checkOrder(tx, "N3", lockKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, created_at, expires_at)
      VALUES (${newId()}::uuid, ${organizationId}::uuid, ${scope}, ${key}::uuid, ${requestHash}, now(),
              now() + ${IDEMPOTENCY_TTL_SQL}::interval)
      ON CONFLICT (organization_id, scope, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash, appointment_id = NULL, response_status = NULL,
            response_body = NULL, created_at = now(), expires_at = EXCLUDED.expires_at
        WHERE idempotency_records.expires_at <= now()
      RETURNING id`;
    if (claimed.length === 1) {
      if (!held) recordAcquired(tx, "N3", lockKey);
      return { kind: "claimed" };
    }
    const found = await tx.$queryRaw<
      {
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }[]
    >`
      SELECT request_hash, response_status, response_body FROM idempotency_records
       WHERE organization_id = ${organizationId}::uuid AND scope = ${scope} AND key = ${key}::uuid`;
    const row = found[0];
    if (row) {
      if (!held) recordAcquired(tx, "N3", lockKey);
      return {
        kind: "existing",
        requestHash: row.request_hash,
        responseStatus: row.response_status,
        responseBody: row.response_body,
      };
    }
    // O registro sumiu entre o conflito e a leitura (limpeza concorrente de linha vencida): tenta reivindicar de novo.
  }
  throw new Error("não foi possível reivindicar a chave de idempotência");
}
