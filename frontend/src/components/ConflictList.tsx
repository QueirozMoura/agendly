import type { ConflictDetails } from "../api/types";
import { formatDateTime } from "../lib/time";
import { Alert } from "./ui";

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: "Agendado",
  CONFIRMED: "Confirmado",
};

/**
 * R4: a alteração foi RECUSADA porque deixaria agendamentos ativos de fora (ou dentro de uma folga). Nada foi alterado
 * e nenhum agendamento foi cancelado. Mostra o total real e deixa claro quando a lista é parcial.
 */
export function ConflictList({
  conflict,
  timeZone,
  what,
}: {
  conflict: ConflictDetails;
  timeZone: string;
  /** O que se tentou fazer, em texto ("A folga", "A alteração do horário"...). */
  what: string;
}) {
  const { totalCount, conflicts, truncated } = conflict;
  const plural = totalCount === 1 ? "agendamento ativo" : "agendamentos ativos";
  return (
    <Alert kind="error">
      <p>
        <strong>
          {what} não foi salva: ela afeta {totalCount} {plural}.
        </strong>{" "}
        Nada foi alterado e nenhum agendamento foi cancelado. Cancele ou
        remarque
        {totalCount === 1 ? " esse agendamento" : " esses agendamentos"} e tente
        novamente.
      </p>
      <ul className="conflicts" aria-label="Agendamentos afetados">
        {conflicts.map((c) => (
          <li key={c.id}>
            <span>{formatDateTime(c.startsAt, timeZone)}</span> ·{" "}
            {c.customer.name} · {c.serviceName}{" "}
            <span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span>
          </li>
        ))}
      </ul>
      {truncated && (
        <p>
          Mostrando os {conflicts.length} primeiros de {totalCount}. Resolva
          estes e repita a alteração para ver os demais.
        </p>
      )}
    </Alert>
  );
}
