import type { PrismaClient } from "../client.ts";

export interface ClaimedEmail {
  id: string;
  toEmail: string;
  template:
    "VERIFY_EMAIL" | "RESET_PASSWORD" | "PASSWORD_CHANGED" | "ACCOUNT_EXISTS";
  payloadEncrypted: Buffer | null;
  keyId: string | null;
  attempts: number;
  notAfter: Date;
  lockToken: string;
}

interface Row {
  id: string;
  to_email: string;
  template: ClaimedEmail["template"];
  payload_encrypted: Buffer | null;
  key_id: string | null;
  attempts: number;
  not_after: Date;
  lock_token: string;
}

/**
 * Reivindica um lote (3.6, regra 2): PENDING vencidas ou SENDING com lease vencido, com SKIP LOCKED
 * (nunca espera), marcando SENDING, novo lease e novo lock_token por linha. `attempts` é incrementado já
 * na reivindicação, então um processo que morre repetidamente também esgota as tentativas.
 */
export async function claimEmailBatch(
  prisma: PrismaClient,
  input: { now: Date; limit: number; leaseMs: number },
): Promise<ClaimedEmail[]> {
  const lockedUntil = new Date(input.now.getTime() + input.leaseMs);
  const rows = await prisma.$queryRaw<Row[]>`
    UPDATE email_outbox AS o
       SET status = 'SENDING', locked_until = ${lockedUntil}, lock_token = gen_random_uuid(),
           attempts = o.attempts + 1
     WHERE o.id IN (
       SELECT id FROM email_outbox
        WHERE (status = 'PENDING' AND next_attempt_at <= ${input.now})
           OR (status = 'SENDING' AND locked_until < ${input.now})
        ORDER BY next_attempt_at
        LIMIT ${input.limit}
        FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING o.id, o.to_email, o.template, o.payload_encrypted, o.key_id, o.attempts,
              o.not_after, o.lock_token::text AS lock_token`;
  return rows.map((r) => ({
    id: r.id,
    toEmail: r.to_email,
    template: r.template,
    payloadEncrypted: r.payload_encrypted
      ? Buffer.from(r.payload_encrypted)
      : null,
    keyId: r.key_id,
    attempts: r.attempts,
    notAfter: r.not_after,
    lockToken: r.lock_token,
  }));
}
