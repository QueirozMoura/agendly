// Classifica erros do banco pelo SQLSTATE. No Prisma 7 com driver adapter o SQLSTATE vem em
// error.meta.driverAdapterError.cause.originalCode, tanto em operações do ORM (P2039, P2002...)
// quanto em $queryRaw/$executeRaw (P2010). Evidência: docs/STAGE-3-VALIDATIONS.md, V6.

export type DbErrorKind =
  | "unique_violation" // 23505
  | "foreign_key_violation" // 23503 e 23001 (ON DELETE/UPDATE RESTRICT)
  | "exclusion_violation" // 23P01
  | "check_violation" // 23514
  | "deadlock" // 40P01
  | "serialization_failure" // 40001
  | "lock_timeout" // 55P03
  | "transaction_timeout"; // P2028 de EXPIRAÇÃO ou de espera por conexão (não os demais P2028)

const BY_SQLSTATE: Record<string, DbErrorKind> = {
  "23505": "unique_violation",
  "23503": "foreign_key_violation",
  "23001": "foreign_key_violation", // restrict_violation: FK com ação RESTRICT (a que o schema usa)
  "23P01": "exclusion_violation",
  "23514": "check_violation",
  "40P01": "deadlock",
  "40001": "serialization_failure",
  "55P03": "lock_timeout",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function sqlState(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const meta = err.meta;
  const adapterError = isRecord(meta) ? meta.driverAdapterError : undefined;
  const cause = isRecord(adapterError) ? adapterError.cause : undefined;
  if (isRecord(cause)) {
    const code = cause.originalCode ?? cause.code;
    if (typeof code === "string") return code;
  }
  // Erro cru do driver pg (fora do Prisma).
  return typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code)
    ? err.code
    : undefined;
}

// Alguns erros do ORM chegam só com o código do Prisma, sem SQLSTATE (ex.: P2003 em delete com FK).
const BY_PRISMA_CODE: Record<string, DbErrorKind> = {
  P2002: "unique_violation",
  P2003: "foreign_key_violation",
};

/**
 * P2028 é uma família de erros de transação interativa. Só duas formas são "tente de novo" (a transação sofreu rollback e
 * nada foi gravado), verificadas na versão instalada (Prisma 7.10.1, ver STAGE-9-VALIDATIONS.md):
 * - expirou: `meta` traz `timeout` e `timeTaken` numéricos ("A query/commit cannot be executed on an expired transaction");
 * - não obteve conexão em `maxWait`: "Unable to start a transaction in the given time." (`meta` vazio).
 * As demais ("Transaction already closed", "Transaction not found", "Internal Consistency Error") indicam falha de
 * programação ou do motor e continuam sendo erro interno.
 */
function isTransactionTimeout(err: unknown): boolean {
  if (!isRecord(err) || err.code !== "P2028") return false;
  const meta = err.meta;
  if (
    isRecord(meta) &&
    typeof meta.timeout === "number" &&
    typeof meta.timeTaken === "number"
  )
    return true;
  return (
    typeof err.message === "string" &&
    err.message.includes("Unable to start a transaction in the given time")
  );
}

export function classifyDbError(err: unknown): DbErrorKind | undefined {
  const state = sqlState(err);
  if (state && BY_SQLSTATE[state]) return BY_SQLSTATE[state];
  if (isTransactionTimeout(err)) return "transaction_timeout";
  return isRecord(err) && typeof err.code === "string"
    ? BY_PRISMA_CODE[err.code]
    : undefined;
}
