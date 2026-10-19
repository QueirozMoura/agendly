// Locks explícitos e consultas com SKIP LOCKED (único lugar com `FOR NO KEY UPDATE`; V15, regra de 4.4/L8).
// Domínio de autenticação (6.5): A1 users → A2 auth_tokens → A3 sessions → A4 email_outbox.
// A hierarquia completa com guard de ordem em tempo de execução é entregue na Etapa 9.
import type { TxClient } from "../client.ts";

/** A1: trava a linha do usuário. Toda operação que altera tokens/sessões de um usuário começa por aqui. */
export async function lockUser(tx: TxClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
}

/** Linha da empresa (6.5: "Editar configurações da empresa": linha da empresa apenas). Serializa edições concorrentes. */
export async function lockOrganization(
  tx: TxClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR NO KEY UPDATE`;
}
