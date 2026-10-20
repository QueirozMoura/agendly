import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/client";
import type {
  ApiAppointment,
  ApiProfessional,
  ApiService,
} from "../../api/types";
import { Alert, Field } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import {
  MAX_DAYS_AHEAD,
  addDays,
  isLocalDate,
  todayIn,
} from "../../lib/agenda";
import { SlotsField } from "./SlotsField";
import { useSlots } from "./useSlots";

const SLOT_LOST = new Set(["SLOT_UNAVAILABLE", "PROFESSIONAL_UNAVAILABLE"]);

/**
 * Novo agendamento (`POST /api/appointments`). Idempotência (6.4): cada submissão LÓGICA tem sua `Idempotency-Key`
 * (`crypto.randomUUID()`); repetir o MESMO conteúdo (retry depois de erro de rede, por exemplo) reaproveita a chave, e
 * qualquer mudança no conteúdo gera uma chave nova. O servidor só registra sucessos, então reaproveitar a chave após
 * uma falha é seguro. A empresa nunca vai no corpo nem na query: vem do `X-Active-Org` (ApiContext) e da sessão.
 */
export function NewAppointmentForm({
  professionals,
  services,
  timeZone,
  defaultDate,
  onCreated,
  onCancel,
}: {
  professionals: ApiProfessional[];
  services: ApiService[];
  timeZone: string;
  defaultDate: string;
  onCreated: (appointment: ApiAppointment) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const today = todayIn(timeZone);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(defaultDate < today ? today : defaultDate);
  const [slot, setSlot] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [slotLost, setSlotLost] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);

  const professional = professionals.find((p) => p.id === professionalId);
  const serviceOptions = services.filter(
    (s) => s.active && professional?.serviceIds.includes(s.id),
  );
  const slots = useSlots(professionalId, serviceId, date, timeZone);

  // Um horário escolhido que deixou de ser oferecido (nova consulta) nunca é enviado nem trocado em silêncio.
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
    const next: Record<string, string> = {};
    if (name.trim() === "")
      next["customer.name"] = "Informe o nome do cliente.";
    if (phone.trim() === "") next["customer.phone"] = "Informe o telefone.";
    if (professionalId === "") next.professionalId = "Escolha o profissional.";
    if (serviceId === "") next.serviceId = "Escolha o serviço.";
    if (!isLocalDate(date)) next.date = "Informe a data.";
    else if (date < today)
      next.date = "Não é possível agendar em uma data passada.";
    else if (date > addDays(today, MAX_DAYS_AHEAD))
      next.date = "A data está distante demais.";
    if (slot === "") next.startsAt = "Escolha um horário.";
    else if (new Date(slot).getTime() <= Date.now()) {
      // R7: revalida imediatamente antes de enviar (o relógio andou desde que o horário foi oferecido).
      next.startsAt = "Esse horário já passou. Escolha outro horário.";
      setSlot("");
      slots.reload();
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body = {
      professionalId,
      serviceId,
      startsAt: slot,
      customer: {
        name: name.trim(),
        phone: phone.trim(),
        ...(email.trim() === "" ? {} : { email: email.trim() }),
      },
    };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    const key = attempt.current.key;

    setSlotLost(false);
    inFlight.current = true;
    let failure: unknown;
    try {
      const res = await action.run(async () => {
        try {
          return await api.request<{ appointment: ApiAppointment }>(
            "POST",
            "/api/appointments",
            { body, headers: { "Idempotency-Key": key } },
          );
        } catch (err) {
          failure = err;
          throw err;
        }
      });
      if (res.ok) {
        attempt.current = null;
        setName("");
        setPhone("");
        setEmail("");
        setSlot("");
        onCreated(res.value.appointment);
        return;
      }
    } finally {
      inFlight.current = false;
    }
    if (
      failure instanceof ApiError &&
      (SLOT_LOST.has(failure.code) || failure.code === "STARTS_AT_IN_PAST")
    ) {
      // Mantém os dados de contato; só o horário é descartado e a lista é consultada de novo.
      if (SLOT_LOST.has(failure.code)) setSlotLost(true);
      setSlot("");
      slots.reload();
    }
  }

  const all = { ...action.fieldErrors, ...errors };

  return (
    <form
      className="inline-form stacked"
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-label="Novo agendamento"
    >
      <h2>Novo agendamento</h2>
      {slotLost && (
        <Alert kind="error">
          O horário escolhido não está mais disponível. Seus dados foram
          mantidos: escolha outro horário abaixo.
        </Alert>
      )}
      {action.error && !slotLost && <Alert kind="error">{action.error}</Alert>}
      <Field
        id="ag-name"
        label="Nome do cliente"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={all["customer.name"]}
        autoComplete="off"
      />
      <Field
        id="ag-phone"
        label="Telefone"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        error={all["customer.phone"]}
        hint="Com DDD, por exemplo (11) 98765-4321."
        autoComplete="off"
      />
      <Field
        id="ag-email"
        label="E-mail (opcional)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={all["customer.email"]}
        autoComplete="off"
      />
      <div className="field">
        <label htmlFor="ag-professional">Profissional</label>
        <select
          id="ag-professional"
          value={professionalId}
          onChange={(e) => {
            setProfessionalId(e.target.value);
            setServiceId("");
            setSlot("");
          }}
        >
          <option value="">Escolha…</option>
          {professionals
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        {all.professionalId && (
          <p className="field-error">{all.professionalId}</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="ag-service">Serviço</label>
        <select
          id="ag-service"
          value={serviceId}
          disabled={professionalId === ""}
          onChange={(e) => {
            setServiceId(e.target.value);
            setSlot("");
          }}
        >
          <option value="">Escolha…</option>
          {serviceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {all.serviceId && <p className="field-error">{all.serviceId}</p>}
      </div>
      <Field
        id="ag-date"
        label="Data"
        type="date"
        value={date}
        min={today}
        max={addDays(today, MAX_DAYS_AHEAD)}
        onChange={(e) => {
          setDate(e.target.value);
          setSlot("");
        }}
        error={all.date}
      />
      <SlotsField
        name="ag-slot"
        resource={slots.resource}
        enabled={slots.enabled}
        value={slot}
        onChange={(s) => {
          setSlot(s);
          setSlotLost(false);
        }}
        onRetry={slots.reload}
        timeZone={timeZone}
        error={all.startsAt}
      />
      <div className="form-actions">
        <button
          type="submit"
          className="button primary-inline"
          disabled={action.pending}
          aria-busy={action.pending}
        >
          {action.pending ? "Agendando…" : "Agendar"}
        </button>
        <button
          type="button"
          className="button"
          onClick={onCancel}
          disabled={action.pending}
        >
          Fechar
        </button>
      </div>
    </form>
  );
}
