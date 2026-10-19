import { encryptPayload } from "../../lib/crypto.ts";
import type { TxClient } from "../../lib/db/client.ts";
import type { Keyring } from "../../lib/email/keyring.ts";
import { newId } from "../../lib/ids.ts";
import type { Clock } from "../../lib/time/clock.ts";
import {
  payloadSchemas,
  type EmailPayloads,
  type EmailTemplateName,
} from "./templates.ts";

export interface OutboxContext {
  keyring: Keyring;
  clock: Clock;
}

/**
 * Enfileira DENTRO da transação do chamador (outbox transacional, 3.6 regra 1): se a transação sofrer
 * rollback, a mensagem some junto com o token/usuário. A requisição HTTP nunca chama o provedor.
 * O id da linha é o AAD da cifragem: um payload copiado para outra linha não decifra.
 */
export async function enqueueEmail<T extends EmailTemplateName>(
  tx: TxClient,
  ctx: OutboxContext,
  input: { to: string; template: T; payload: EmailPayloads[T]; ttlMs: number },
): Promise<string> {
  payloadSchemas[input.template].parse(input.payload);
  const now = ctx.clock.now();
  const id = newId();
  const keyId = ctx.keyring.currentId;
  const key = ctx.keyring.get(keyId) as Buffer; // existência garantida na criação do keyring
  await tx.emailOutbox.create({
    data: {
      id,
      toEmail: input.to,
      template: input.template,
      payloadEncrypted: Uint8Array.from(
        encryptPayload(key, JSON.stringify(input.payload), id),
      ),
      keyId,
      nextAttemptAt: now,
      notAfter: new Date(now.getTime() + input.ttlMs),
      createdAt: now,
    },
  });
  return id;
}
