import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/client";
import type {
  ApiAppointment,
  ApiProfessional,
  ApiService,
  AppointmentStatus,
} from "../../api/types";
import { Alert, Field } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import {
  MAX_DAYS_AHEAD,
  addDays,
  isLocalDate,
  localDateOf,
  localTimeOf,
  todayIn,
} from "../../lib/agenda";
import { formatCents } from "../../lib/money";
import { formatDateTime } from "../../lib/time";
import { SlotsField } from "./SlotsField";
import { useSlots } from "./useSlots";

const REASON_MAX = 200;

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  SCHEDULED: "Agendado",
  CONFIRMED: "Confirmado",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado",
  NO_SHOW: "Não compareceu",
};

const isActive = (s: AppointmentStatus) =>
  s === "SCHEDULED" || s === "CONFIRMED";

/**
 * Um agendamento. Nome, duração, intervalo e preço vêm dos SNAPSHOTS da API (R3), nunca do serviço atual. Remarcar e
 * cancelar enviam a `version` que esta tela mostra; `409 STALE_VERSION` avisa a página (`onStale`), que recarrega.
 */
export function AppointmentCard({
  appointment: a,
  professionals,
  services,
  timeZone,
  shownDate,
  onChanged,
  onStale,
}: {
  appointment: ApiAppointment;
  professionals: ApiProfessional[];
  services: ApiService[];
  timeZone: string;
  /** Dia local da coluna em que o cartão aparece (mostra a data completa se o início for em outro dia). */
  shownDate: string;
  onChanged: (message: string) => void;
  onStale: () => void;
}) {
  const [mode, setMode] = useState<"reschedule" | "cancel" | null>(null);
  const label = `${a.customer.name}, ${formatDateTime(a.startsAt, timeZone)}`;
  const time = `${localTimeOf(a.startsAt, timeZone)}–${localTimeOf(a.endsAt, timeZone)}`;
  const sameDay = localDateOf(a.startsAt, timeZone) === shownDate;
  const staleAndClose = () => {
    setMode(null);
    onStale();
  };

  return (
    <li className={`appt appt-${a.status.toLowerCase()}`}>
      <article aria-label={`Agendamento de ${label}`}>
        <div className="appt-head">
          <strong className="appt-time">
            {sameDay ? time : formatDateTime(a.startsAt, timeZone)}
          </strong>
          <span className={`badge badge-${a.status.toLowerCase()}`}>
            {STATUS_LABEL[a.status]}
          </span>
        </div>
        <div>{a.customer.name}</div>
        <div className="muted">
          {a.service.name} · {a.service.durationMinutes} min
          {a.service.bufferMinutes > 0 &&
            ` + ${a.service.bufferMinutes} min de intervalo`}
          {a.service.priceCents !== null &&
            ` · ${formatCents(a.service.priceCents)}`}
        </div>
        {a.status === "CANCELLED" && a.cancelReason && (
          <div className="muted">Motivo: {a.cancelReason}</div>
        )}
        {isActive(a.status) && mode === null && (
          <div className="row-actions">
            <button
              type="button"
              className="button"
              onClick={() => setMode("reschedule")}
              aria-label={`Remarcar ${label}`}
            >
              Remarcar
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => setMode("cancel")}
              aria-label={`Cancelar ${label}`}
            >
              Cancelar
            </button>
          </div>
        )}
        {mode === "reschedule" && (
          <RescheduleForm
            appointment={a}
            professionals={professionals}
            service={services.find((x) => x.id === a.serviceId)}
            timeZone={timeZone}
            onClose={() => setMode(null)}
            onDone={(m) => {
              setMode(null);
              onChanged(m);
            }}
            onStale={staleAndClose}
          />
        )}
        {mode === "cancel" && (
          <CancelForm
            appointment={a}
            onClose={() => setMode(null)}
            onDone={(m) => {
              setMode(null);
              onChanged(m);
            }}
            onStale={staleAndClose}
          />
        )}
      </article>
    </li>
  );
}

const describeService = (s: {
  durationMinutes: number;
  bufferMinutes: number;
}) =>
  `${s.durationMinutes} min${s.bufferMinutes > 0 ? ` + ${s.bufferMinutes} min de intervalo` : ""}`;

/**
 * `GET /api/availability/slots` usa duração e intervalo ATUAIS do serviço; a remarcação usa os snapshots do agendamento
 * (R3). Os horários só são conservadores quando o snapshot não exige mais do que o serviço atual: duração menor ou igual
 * E duração + intervalo menores ou iguais. Fora disso um horário oferecido pode ser recusado (409/422).
 */
export function snapshotExceedsCurrent(
  a: ApiAppointment,
  current: ApiService | undefined,
): boolean {
  if (!current) return false;
  const snap = a.service;
  return (
    snap.durationMinutes > current.durationMinutes ||
    snap.durationMinutes + snap.bufferMinutes >
      current.durationMinutes + current.bufferMinutes
  );
}

function RescheduleForm({
  appointment: a,
  professionals,
  service,
  timeZone,
  onClose,
  onDone,
  onStale,
}: {
  appointment: ApiAppointment;
  professionals: ApiProfessional[];
  /** Serviço ATUAL (os horários são calculados com ele); o servidor valida a remarcação com os snapshots (R3). */
  service: ApiService | undefined;
  timeZone: string;
  onClose: () => void;
  onDone: (message: string) => void;
  onStale: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const today = todayIn(timeZone);
  const startDate = localDateOf(a.startsAt, timeZone);
  const [professionalId, setProfessionalId] = useState(a.professionalId);
  const [date, setDate] = useState(startDate < today ? today : startDate);
  const [slot, setSlot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [slotLost, setSlotLost] = useState(false);
  const inFlight = useRef(false);
  const slots = useSlots(professionalId, a.serviceId, date, timeZone);
  const options = professionals.filter(
    (p) =>
      p.id === a.professionalId ||
      (p.active && p.serviceIds.includes(a.serviceId)),
  );

  useEffect(() => {
    if (
      slot !== "" &&
      slots.resource.status === "ready" &&
      !slots.resource.data.includes(slot)
    )
      setSlot("");
  }, [slot, slots.resource]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    if (slot === "") return setError("Escolha o novo horário.");
    if (new Date(slot).getTime() <= Date.now()) {
      setSlot("");
      slots.reload();
      return setError("Esse horário já passou. Escolha outro horário.");
    }
    setSlotLost(false);
    inFlight.current = true;
    let failure: unknown;
    try {
      const res = await action.run(async () => {
        try {
          return await api.request(
            "POST",
            `/api/appointments/${encodeURIComponent(a.id)}/reschedule`,
            {
              body: {
                startsAt: slot,
                version: a.version,
                ...(professionalId === a.professionalId
                  ? {}
                  : { professionalId }),
              },
            },
          );
        } catch (err) {
          failure = err;
          throw err;
        }
      });
      if (res.ok) return onDone("Agendamento remarcado.");
    } finally {
      inFlight.current = false;
    }
    if (failure instanceof ApiError) {
      if (failure.status === 409 && failure.code === "STALE_VERSION")
        return onStale();
      if (
        failure.code === "SLOT_UNAVAILABLE" ||
        failure.code === "PROFESSIONAL_UNAVAILABLE"
      ) {
        setSlotLost(true);
        setSlot("");
        slots.reload();
      } else if (failure.code === "STARTS_AT_IN_PAST") {
        setSlot("");
        slots.reload();
      }
    }
  }

  const id = `rs-${a.id}`;
  return (
    <form
      className="inline-form stacked"
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-label={`Remarcar ${a.customer.name}`}
    >
      {service && !service.active && (
        <Alert kind="info">
          O serviço {a.service.name} está desativado, então a consulta não
          oferece horários. Reative o serviço para remarcar por aqui.
        </Alert>
      )}
      {snapshotExceedsCurrent(a, service) && service && (
        <Alert kind="info">
          Este agendamento mantém {describeService(a.service)}, mas os horários
          abaixo são calculados com o serviço atual ({describeService(service)}
          ). O servidor valida com os valores do agendamento e pode recusar um
          horário oferecido.
        </Alert>
      )}
      <p className="muted">
        Horários que se sobrepõem ao próprio agendamento atual não são listados.
      </p>
      {slotLost && (
        <Alert kind="error">
          O horário escolhido não está mais disponível. Escolha outro horário.
        </Alert>
      )}
      {action.error && !slotLost && <Alert kind="error">{action.error}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="field">
        <label htmlFor={`${id}-pro`}>Profissional</label>
        <select
          id={`${id}-pro`}
          value={professionalId}
          onChange={(e) => {
            setProfessionalId(e.target.value);
            setSlot("");
          }}
        >
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        id={`${id}-date`}
        label="Nova data"
        type="date"
        value={date}
        min={today}
        max={addDays(today, MAX_DAYS_AHEAD)}
        onChange={(e) => {
          setDate(e.target.value);
          setSlot("");
        }}
        error={
          isLocalDate(date) && date < today
            ? "Não é possível remarcar para uma data passada."
            : undefined
        }
      />
      <SlotsField
        name={`${id}-slot`}
        resource={slots.resource}
        enabled={slots.enabled}
        value={slot}
        onChange={(s) => {
          setSlot(s);
          setSlotLost(false);
        }}
        onRetry={slots.reload}
        timeZone={timeZone}
      />
      <div className="form-actions">
        <button
          type="submit"
          className="button primary-inline"
          disabled={action.pending}
          aria-busy={action.pending}
        >
          {action.pending ? "Remarcando…" : "Confirmar remarcação"}
        </button>
        <button
          type="button"
          className="button"
          onClick={onClose}
          disabled={action.pending}
        >
          Voltar
        </button>
      </div>
    </form>
  );
}

function CancelForm({
  appointment: a,
  onClose,
  onDone,
  onStale,
}: {
  appointment: ApiAppointment;
  onClose: () => void;
  onDone: (message: string) => void;
  onStale: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const [reason, setReason] = useState("");
  const inFlight = useRef(false);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    let failure: unknown;
    try {
      const res = await action.run(async () => {
        try {
          return await api.request(
            "POST",
            `/api/appointments/${encodeURIComponent(a.id)}/cancel`,
            {
              body: {
                version: a.version,
                reason: reason.trim() === "" ? null : reason.trim(),
              },
            },
          );
        } catch (err) {
          failure = err;
          throw err;
        }
      });
      if (res.ok) return onDone("Agendamento cancelado.");
    } finally {
      inFlight.current = false;
    }
    if (failure instanceof ApiError && failure.code === "STALE_VERSION")
      onStale();
  }

  const tooLong = reason.trim().length > REASON_MAX;
  return (
    <div
      className="confirm-cancel"
      role="group"
      aria-label={`Confirmar cancelamento de ${a.customer.name}`}
    >
      {action.error && <Alert kind="error">{action.error}</Alert>}
      <p>
        Cancelar este agendamento libera o horário. Ele continua no histórico
        como cancelado.
      </p>
      <Field
        id={`cancel-${a.id}-reason`}
        label="Motivo (opcional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={tooLong ? "Motivo muito longo." : action.fieldErrors.reason}
      />
      <div className="form-actions">
        <button
          type="button"
          className="button danger"
          disabled={action.pending || tooLong}
          aria-busy={action.pending}
          onClick={() => void confirm()}
        >
          {action.pending ? "Cancelando…" : "Confirmar cancelamento"}
        </button>
        <button
          type="button"
          className="button"
          onClick={onClose}
          disabled={action.pending}
        >
          Voltar
        </button>
      </div>
    </div>
  );
}
