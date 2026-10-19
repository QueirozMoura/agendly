// Transação interativa com os timeouts de 6.5. `lock_timeout` curto: estourar (55P03) ou ser vítima de deadlock
// (40P01) vira 503 TEMPORARILY_BUSY no tratador de erros, e a transação inteira sofre rollback (nada é gravado).
import type { TxClient } from "../client.ts";

/**
 * Espera máxima por UMA espera de lock. `lock_timeout` reinicia a cada espera, e com várias transações enfileiradas na
 * mesma linha o Postgres faz a 2ª da fila esperar primeiro o *tuple lock* e depois a transação dona da linha; no pior
 * caso uma requisição aguarda ~2× este valor antes do 55P03 (medido: 6,0 s com 3 s). Por isso o prazo da transação
 * (abaixo) precisa ficar bem acima de 2× `LOCK_TIMEOUT_MS`.
 */
export const LOCK_TIMEOUT_MS = 2000;

/**
 * Prazo para obter conexão do pool e duração máxima da transação interativa: acima do pior caso de espera (2× o
 * `lock_timeout` + trabalho) e muito abaixo das 24 h de 6.4. Menor que o `query_timeout` do cliente (10 s).
 */
export const TRANSACTION_OPTIONS = { maxWait: 2000, timeout: 8000 } as const;

type Tx = Pick<TxClient, "$queryRaw">;

interface Interactive<T extends Tx> {
  $transaction<R>(
    fn: (tx: T) => Promise<R>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<R>;
}

/**
 * Executa `fn` numa transação interativa com `SET LOCAL lock_timeout` (vale só nesta transação) e os prazos de
 * `TRANSACTION_OPTIONS`. Dentro de `fn` só se usa o `tx` recebido, nunca o cliente global (R-b).
 */
export function runLocked<T extends Tx, R>(
  db: Interactive<T>,
  fn: (tx: T) => Promise<R>,
  lockTimeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<R> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(lockTimeoutMs)}, true)`;
    return fn(tx);
  }, TRANSACTION_OPTIONS);
}
