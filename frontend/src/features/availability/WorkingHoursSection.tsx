import { useState, type FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import type { ApiWorkingHours } from "../../api/types";
import { ConfirmRemove } from "../../components/ConfirmRemove";
import { ConflictList } from "../../components/ConflictList";
import { Alert, Loading } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import { useResource } from "../../hooks/useResource";
import { timeOptions, WEEKDAYS } from "../../lib/time";
import { useOrganizations } from "../organizations/OrganizationContext";

const START = timeOptions("start");
const END = timeOptions("end");

/** Horário de trabalho semanal em hora LOCAL da empresa: vários intervalos por dia, em passos de 15 minutos (6.2). */
export function WorkingHoursSection({
  professionalId,
}: {
  professionalId: string;
}) {
  const api = useApi();
  const { active } = useOrganizations();
  const timeZone = active?.timezone ?? "";
  const { resource, reload } = useResource(
    async (signal) =>
      (
        await api.request<{ workingHours: ApiWorkingHours[] }>(
          "GET",
          `/api/working-hours?professionalId=${professionalId}`,
          {
            signal,
          },
        )
      ).workingHours,
    [api, professionalId],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const remove = useAction();

  async function removeInterval(w: ApiWorkingHours) {
    setNotice(null);
    const res = await remove.run(() =>
      api.request("DELETE", `/api/working-hours/${w.id}`),
    );
    if (res.ok) {
      setNotice("Intervalo removido.");
      reload();
    }
  }

  return (
    <section className="panel" aria-label="Horário de trabalho">
      <h2>Horário de trabalho</h2>
      <p className="muted">
        Horários na hora local da empresa{timeZone ? ` (${timeZone})` : ""}.
        Alterações que deixariam agendamentos ativos fora do expediente são
        recusadas.
      </p>
      {notice && <Alert kind="success">{notice}</Alert>}
      {remove.error && <Alert kind="error">{remove.error}</Alert>}
      {remove.conflict && (
        <ConflictList
          conflict={remove.conflict}
          timeZone={timeZone || "UTC"}
          what="A remoção"
        />
      )}

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
          {resource.data.length === 0 && (
            <p className="empty">
              Nenhum horário cadastrado: o profissional não terá horários
              disponíveis.
            </p>
          )}
          <ul className="week" aria-label="Expediente por dia da semana">
            {WEEKDAYS.map((label, weekday) => {
              const intervals = resource.data.filter(
                (w) => w.weekday === weekday,
              );
              return (
                <li key={weekday}>
                  <strong>{label}</strong>
                  {intervals.length === 0 ? (
                    <span className="muted"> · sem expediente</span>
                  ) : (
                    <ul className="rows compact">
                      {intervals.map((w) =>
                        editingId === w.id ? (
                          <li key={w.id}>
                            <IntervalForm
                              initial={w}
                              onCancel={() => setEditingId(null)}
                              onSaved={() => {
                                setEditingId(null);
                                setNotice("Horário atualizado.");
                                reload();
                              }}
                              professionalId={professionalId}
                              timeZone={timeZone}
                            />
                          </li>
                        ) : (
                          <li key={w.id}>
                            <span>
                              {w.startTime} às {w.endTime}
                            </span>
                            <span className="row-actions">
                              <button
                                type="button"
                                className="button"
                                onClick={() => {
                                  setNotice(null);
                                  remove.reset();
                                  setEditingId(w.id);
                                }}
                                aria-label={`Editar ${label} ${w.startTime} às ${w.endTime}`}
                              >
                                Editar
                              </button>
                              <ConfirmRemove
                                label={`${label} ${w.startTime} às ${w.endTime}`}
                                disabled={remove.pending}
                                onConfirm={() => void removeInterval(w)}
                              />
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {editingId === null && (
            <IntervalForm
              professionalId={professionalId}
              timeZone={timeZone}
              onSaved={() => {
                setNotice("Horário adicionado.");
                reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function IntervalForm({
  professionalId,
  timeZone,
  initial,
  onSaved,
  onCancel,
}: {
  professionalId: string;
  timeZone: string;
  initial?: ApiWorkingHours;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const [weekday, setWeekday] = useState(String(initial?.weekday ?? 1));
  const [start, setStart] = useState(initial?.startTime ?? "09:00");
  const [end, setEnd] = useState(initial?.endTime ?? "18:00");
  const [localError, setLocalError] = useState<string | null>(null);
  const title = initial ? "Editar horário" : "Adicionar horário";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (start >= end)
      return setLocalError("O início deve ser anterior ao fim.");
    setLocalError(null);
    const body = { weekday: Number(weekday), startTime: start, endTime: end };
    const res = await action.run(() =>
      initial
        ? api.request("PATCH", `/api/working-hours/${initial.id}`, { body })
        : api.request("POST", "/api/working-hours", {
            body: { professionalId, ...body },
          }),
    );
    if (res.ok) onSaved();
  }

  return (
    <form
      className="inline-form"
      onSubmit={submit}
      noValidate
      aria-label={title}
    >
      {action.error && <Alert kind="error">{action.error}</Alert>}
      {localError && <Alert kind="error">{localError}</Alert>}
      {action.conflict && (
        <ConflictList
          conflict={action.conflict}
          timeZone={timeZone || "UTC"}
          what="A alteração do horário"
        />
      )}
      <label>
        Dia
        <select
          value={weekday}
          onChange={(e) => setWeekday(e.target.value)}
          aria-label={`${title}: dia da semana`}
        >
          {WEEKDAYS.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Início
        <select
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label={`${title}: início`}
        >
          {START.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        Fim
        <select
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-label={`${title}: fim`}
        >
          {END.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="button"
        disabled={action.pending}
        aria-busy={action.pending}
      >
        {action.pending
          ? "Salvando…"
          : initial
            ? "Salvar horário"
            : "Adicionar horário"}
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
    </form>
  );
}
