import { useCallback, useState } from "react";
import { ApiError, messageOf } from "../api/client";
import type { ConflictDetails } from "../api/types";
import { fieldErrorsFromApi, type FieldErrors } from "../components/forms";

const CONFLICT_CODES = new Set([
  "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
  "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
]);

/** `details` do 409 de R4 quando o formato é o esperado; `null` caso contrário (nunca confia em formato desconhecido). */
export function conflictDetails(err: unknown): ConflictDetails | null {
  if (
    !(err instanceof ApiError) ||
    err.status !== 409 ||
    !CONFLICT_CODES.has(err.code)
  )
    return null;
  const d = err.details as Partial<ConflictDetails> | undefined;
  if (!d || !Array.isArray(d.conflicts) || typeof d.totalCount !== "number")
    return null;
  return {
    conflicts: d.conflicts,
    totalCount: d.totalCount,
    truncated: d.truncated === true,
  };
}

/**
 * Executa uma ação de escrita (criar/editar/remover) e guarda o resultado para a tela: `pending`, mensagem de erro,
 * erros por campo (400) e a lista de conflitos (409 de R4). Erros já tratados centralmente (401...) não geram mensagem.
 * Devolve `{ ok: true, value }` ou `{ ok: false }`.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const reset = useCallback(() => {
    setError(null);
    setConflict(null);
    setFieldErrors({});
  }, []);

  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      reset();
      setPending(true);
      try {
        const value = await fn();
        return { ok: true, value };
      } catch (err) {
        const found = conflictDetails(err);
        const fields = fieldErrorsFromApi(err);
        if (found) setConflict(found);
        else if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else if (!(err instanceof ApiError && err.handled))
          setError(messageOf(err));
        return { ok: false };
      } finally {
        setPending(false);
      }
    },
    [reset],
  );

  return { pending, error, conflict, fieldErrors, run, reset, setFieldErrors };
}
