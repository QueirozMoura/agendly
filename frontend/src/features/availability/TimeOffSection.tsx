import { useState, type FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import type { ApiTimeOff } from "../../api/types";
import { ConfirmRemove } from "../../components/ConfirmRemove";
import { ConflictList } from "../../components/ConflictList";
import { Alert, Field, Loading } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import { useResource } from "../../hooks/useResource";
import {
  formatDateTime,
  utcIsoToZonedLocal,
  zonedLocalToUtcIso,
} from "../../lib/time";

const REASON_MAX = 200;

/** Folgas e ausências (instantes). Mostradas e digitadas na timezone da empresa; enviadas em UTC. */
export function TimeOffSection({
  professionalId,
  timeZone,
}: {
  professionalId: string;
  timeZone: string;
}) {
  const api = useApi();
  const { resource, reload } = useResource(
    async (signal) =>
      (
        await api.request<{ timeOff: ApiTimeOff[] }>(
          "GET",
          `/api/time-off?professionalId=${professionalId}`,
          { signal },
        )
      ).timeOff,
    [api, professionalId],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const remove = useAction();

  async function removeOff(o: ApiTimeOff) {
    setNotice(null);
    const res = await remove.run(() =>
      api.request("DELETE", `/api/time-off/${o.id}`),
    );
    if (res.ok) {
      setNotice("Folga removida.");
      reload();
    }
  }

  return (
    <section className="panel" aria-label="Folgas">
      <h2>Folgas e ausências</h2>
      <p className="muted">
        Horários na hora local da empresa ({timeZone}). Uma folga que cobrir
        agendamentos ativos é recusada, com a lista deles; nenhum agendamento é
        cancelado automaticamente.
      </p>
      {notice && <Alert kind="success">{notice}</Alert>}
      {remove.error && <Alert kind="error">{remove.error}</Alert>}

      {resource.status === "loading" && <Loading />}
      {resource.status === "error" && (
        <>
          <Alert kind="error">{resource.message}</Alert>
          <button type="button" className="button" onClick={reload}>
            Tentar novamente
          </button>
        </>
      )}
      {resource.status === "ready" && (
        <>
          {resource.data.length === 0 ? (
            <p>Nenhuma folga cadastrada.</p>
          ) : (
            <ul className="rows" aria-label="Folgas cadastradas">
              {resource.data.map((o) =>
                editingId === o.id ? (
                  <li key={o.id}>
                    <TimeOffForm
                      initial={o}
                      professionalId={professionalId}
                      timeZone={timeZone}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        setNotice("Folga atualizada.");
                        reload();
                      }}
                    />
                  </li>
                ) : (
                  <li key={o.id}>
                    <div>
                      <strong>
                        {formatDateTime(o.startsAt, timeZone)} até{" "}
                        {formatDateTime(o.endsAt, timeZone)}
                      </strong>
                      {o.reason && <div className="muted">{o.reason}</div>}
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          setNotice(null);
                          setEditingId(o.id);
                        }}
                        aria-label={`Editar folga de ${formatDateTime(o.startsAt, timeZone)}`}
                      >
                        Editar
                      </button>
                      <ConfirmRemove
                        label={`folga de ${formatDateTime(o.startsAt, timeZone)}`}
                        disabled={remove.pending}
                        onConfirm={() => void removeOff(o)}
                      />
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}
          {editingId === null && (
            <TimeOffForm
              professionalId={professionalId}
              timeZone={timeZone}
              onSaved={() => {
                setNotice("Folga adicionada.");
                reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function TimeOffForm({
  professionalId,
  timeZone,
  initial,
  onSaved,
  onCancel,
}: {
  professionalId: string;
  timeZone: string;
  initial?: ApiTimeOff;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const [start, setStart] = useState(
    initial ? utcIsoToZonedLocal(initial.startsAt, timeZone) : "",
  );
  const [end, setEnd] = useState(
    initial ? utcIsoToZonedLocal(initial.endsAt, timeZone) : "",
  );
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const title = initial ? "Editar folga" : "Adicionar folga";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const startsAt = zonedLocalToUtcIso(start, timeZone);
    const endsAt = zonedLocalToUtcIso(end, timeZone);
    if (!start) next.startsAt = "Informe o início.";
    else if (!startsAt)
      next.startsAt =
        "Esse horário não existe nesse dia (mudança de horário de verão).";
    if (!end) next.endsAt = "Informe o fim.";
    else if (!endsAt)
      next.endsAt =
        "Esse horário não existe nesse dia (mudança de horário de verão).";
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
      next.endsAt = "O fim deve ser posterior ao início.";
    if (reason.trim().length > REASON_MAX) next.reason = "Motivo muito longo.";
    setErrors(next);
    if (Object.keys(next).length > 0 || !startsAt || !endsAt) return;
    const body = {
      startsAt,
      endsAt,
      reason: reason.trim() === "" ? null : reason.trim(),
    };
    const res = await action.run(() =>
      initial
        ? api.request("PATCH", `/api/time-off/${initial.id}`, { body })
        : api.request("POST", "/api/time-off", {
            body: { professionalId, ...body },
          }),
    );
    if (res.ok) {
      if (!initial) {
        // Criada: limpa o formulário para a próxima folga (a lista já mostra a que foi salva).
        setStart("");
        setEnd("");
        setReason("");
      }
      onSaved();
    }
  }
  const all = { ...action.fieldErrors, ...errors };

  return (
    <form
      className="inline-form stacked"
      onSubmit={submit}
      noValidate
      aria-label={title}
    >
      {action.error && <Alert kind="error">{action.error}</Alert>}
      {action.conflict && (
        <ConflictList
          conflict={action.conflict}
          timeZone={timeZone}
          what="A folga"
        />
      )}
      <Field
        id={`${initial?.id ?? "new"}-off-start`}
        label="Início"
        type="datetime-local"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        error={all.startsAt}
      />
      <Field
        id={`${initial?.id ?? "new"}-off-end`}
        label="Fim"
        type="datetime-local"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        error={all.endsAt}
      />
      <Field
        id={`${initial?.id ?? "new"}-off-reason`}
        label="Motivo (opcional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={all.reason}
      />
      <div className="form-actions">
        <button
          type="submit"
          className="button"
          disabled={action.pending}
          aria-busy={action.pending}
        >
          {action.pending
            ? "Salvando…"
            : initial
              ? "Salvar folga"
              : "Adicionar folga"}
        </button>
        {onCancel && (
          <button
            type="button"
            className="button"
            onClick={onCancel}
            disabled={action.pending}
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
