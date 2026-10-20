// Parte do backend FALSO da Etapa 13: agendamentos e horários livres. Reproduz os contratos reais das Etapas 9–10:
// `Idempotency-Key` (UUID) obrigatória na criação, replay com `Idempotent-Replay`, `IDEMPOTENCY_KEY_REUSED`, corpo
// `.strict()` (qualquer `organizationId` ⇒ 400), 422 `STARTS_AT_IN_PAST`, 409 `SLOT_UNAVAILABLE`/`STALE_VERSION`/
// `INVALID_STATUS_TRANSITION`, `version` incrementada a cada mudança e listagem por `[from, to)` com teto de 93 dias.
import { HttpResponse } from "msw";
import type { ApiAppointment, AppointmentStatus } from "../api/types";
import { error, type FakeState } from "./fakeBackend";
import { tenantRoute } from "./fakePanel";

export interface AgendaState {
  appointments: ApiAppointment[];
  /** Horários livres devolvidos por `professionalId|serviceId|AAAA-MM-DD` (instantes ISO em UTC). */
  slots: Record<string, string[]>;
  /** Instantes (`professionalId|startsAt`) já ocupados: criar/remarcar neles ⇒ 409 SLOT_UNAVAILABLE e somem dos slots. */
  taken: Set<string>;
  idempotency: Map<
    string,
    { hash: string; status: number; body: { appointment: ApiAppointment } }
  >;
  seq: number;
}

export const makeAgenda = (over: Partial<AgendaState> = {}): AgendaState => ({
  appointments: [],
  slots: {},
  taken: new Set(),
  idempotency: new Map(),
  seq: 0,
  ...over,
});

const NOW = "2031-03-01T12:00:00.000Z";
export const makeAppointment = (
  id: string,
  professionalId: string,
  startsAt: string,
  over: Partial<ApiAppointment> = {},
): ApiAppointment => {
  const duration = over.service?.durationMinutes ?? 30;
  const buffer = over.service?.bufferMinutes ?? 0;
  const start = new Date(startsAt).getTime();
  return {
    id,
    professionalId,
    serviceId: "s1",
    customer: { id: `c-${id}`, name: `Cliente ${id}` },
    startsAt,
    endsAt: new Date(start + duration * 60_000).toISOString(),
    blockedUntil: new Date(start + (duration + buffer) * 60_000).toISOString(),
    status: "SCHEDULED",
    service: {
      name: "Corte",
      durationMinutes: duration,
      bufferMinutes: buffer,
      priceCents: null,
    },
    source: "PANEL",
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validation = (path: string, message: string) =>
  error(400, "VALIDATION_ERROR", "Dados inválidos.", {
    details: [{ path, message }],
  });
const notFound = () => error(404, "NOT_FOUND", "Recurso não encontrado.");
const slotUnavailable = () =>
  error(409, "SLOT_UNAVAILABLE", "Este horário não está mais disponível.");
const stale = () =>
  error(
    409,
    "STALE_VERSION",
    "O agendamento foi alterado. Recarregue e tente novamente.",
  );
const inPast = () =>
  error(422, "STARTS_AT_IN_PAST", "Não é possível agendar no passado.");
const DAY = 86_400_000;

export function agendaBackend(state: FakeState) {
  const agenda = state.agenda;
  const route = tenantRoute(state);
  const nextId = (prefix: string) => `${prefix}-${++agenda.seq}`;
  const active = (s: AppointmentStatus) =>
    s === "SCHEDULED" || s === "CONFIRMED";

  return [
    route("get", "/api/availability/slots", ({ url }) => {
      const q = url.searchParams;
      const professionalId = q.get("professionalId") ?? "";
      const serviceId = q.get("serviceId") ?? "";
      const date = q.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return validation("date", "Informe o dia no formato AAAA-MM-DD.");
      if (
        !state.panel.professionals.some((p) => p.id === professionalId) ||
        !state.panel.services.some((s) => s.id === serviceId)
      )
        return notFound();
      const slots = (
        agenda.slots[`${professionalId}|${serviceId}|${date}`] ?? []
      ).filter((s) => !agenda.taken.has(`${professionalId}|${s}`));
      return HttpResponse.json({ slots });
    }),

    route("get", "/api/appointments", ({ url }) => {
      const q = url.searchParams;
      const from = new Date(q.get("from") ?? "");
      const to = new Date(q.get("to") ?? "");
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        return validation("from", "Informe data e hora ISO 8601 com fuso.");
      if (to <= from)
        return validation("to", "O fim deve ser posterior ao início.");
      if (to.getTime() - from.getTime() > 93 * DAY)
        return validation("to", "O período não pode passar de 93 dias.");
      const list = agenda.appointments
        .filter(
          (a) =>
            new Date(a.startsAt) < to &&
            new Date(a.endsAt) > from &&
            (!q.get("professionalId") ||
              a.professionalId === q.get("professionalId")),
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return HttpResponse.json({ appointments: list });
    }),

    route("post", "/api/appointments", ({ body, request }) => {
      const key = request.headers.get("idempotency-key");
      if (!key || !UUID.test(key))
        return error(
          400,
          "IDEMPOTENCY_KEY_INVALID",
          "Informe o cabeçalho Idempotency-Key com um UUID.",
        );
      const allowed = ["professionalId", "serviceId", "startsAt", "customer"];
      const unknown = Object.keys(body).find((k) => !allowed.includes(k));
      if (unknown) return validation(unknown, "Campo não reconhecido.");
      const customer = body.customer as
        { name?: string; phone?: string; email?: string } | undefined;
      if (!customer?.name?.trim())
        return validation("customer.name", "Informe o nome do cliente.");
      if (!customer.phone || !/\d{8}/.test(customer.phone.replace(/\D/g, "")))
        return validation("customer.phone", "Telefone inválido.");
      const hash = JSON.stringify(body);
      const seen = agenda.idempotency.get(key);
      if (seen) {
        if (seen.hash !== hash)
          return error(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Esta chave de idempotência já foi usada em outro pedido.",
          );
        return HttpResponse.json(seen.body, {
          status: seen.status,
          headers: { "idempotent-replay": "true" },
        });
      }
      const service = state.panel.services.find((s) => s.id === body.serviceId);
      const professional = state.panel.professionals.find(
        (p) => p.id === body.professionalId,
      );
      if (!service || !professional) return notFound();
      const startsAt = new Date(body.startsAt as string).toISOString();
      if (new Date(startsAt).getTime() <= Date.now()) return inPast();
      if (agenda.taken.has(`${professional.id}|${startsAt}`))
        return slotUnavailable();
      const appointment = makeAppointment(
        nextId("ap"),
        professional.id,
        startsAt,
        {
          serviceId: service.id,
          customer: { id: nextId("cu"), name: customer.name.trim() },
          service: {
            name: service.name,
            durationMinutes: service.durationMinutes,
            bufferMinutes: service.bufferMinutes,
            priceCents: service.priceCents,
          },
        },
      );
      agenda.appointments.push(appointment);
      agenda.taken.add(`${professional.id}|${startsAt}`);
      const response = { appointment };
      agenda.idempotency.set(key, { hash, status: 201, body: response });
      return HttpResponse.json(response, { status: 201 });
    }),

    route("post", "/api/appointments/:id/reschedule", ({ body, params }) => {
      const allowed = ["startsAt", "professionalId", "version"];
      const unknown = Object.keys(body).find((k) => !allowed.includes(k));
      if (unknown) return validation(unknown, "Campo não reconhecido.");
      const current = agenda.appointments.find((a) => a.id === params.id);
      if (!current) return notFound();
      if (current.version !== body.version) return stale();
      if (!active(current.status))
        return error(
          409,
          "INVALID_STATUS_TRANSITION",
          "Esta ação não é permitida para o status atual do agendamento.",
        );
      const professionalId =
        (body.professionalId as string | undefined) ?? current.professionalId;
      const startsAt = new Date(body.startsAt as string).toISOString();
      if (new Date(startsAt).getTime() <= Date.now()) return inPast();
      if (agenda.taken.has(`${professionalId}|${startsAt}`))
        return slotUnavailable();
      // O servidor valida com os SNAPSHOTS do agendamento (R3): [início, início + duração + intervalo) não pode tocar
      // outro agendamento ativo do profissional (a exclusão do banco), mesmo que os slots (serviço atual) o oferecessem.
      const start = new Date(startsAt).getTime();
      const blockedEnd =
        start +
        (current.service.durationMinutes + current.service.bufferMinutes) *
          60_000;
      if (
        agenda.appointments.some(
          (o) =>
            o.id !== current.id &&
            o.professionalId === professionalId &&
            active(o.status) &&
            new Date(o.startsAt).getTime() < blockedEnd &&
            start < new Date(o.blockedUntil).getTime(),
        )
      )
        return slotUnavailable();
      agenda.taken.delete(`${current.professionalId}|${current.startsAt}`);
      agenda.taken.add(`${professionalId}|${startsAt}`);
      // Os snapshots (R3) não mudam: a duração vem do próprio agendamento.
      Object.assign(current, {
        professionalId,
        startsAt,
        endsAt: new Date(
          start + current.service.durationMinutes * 60_000,
        ).toISOString(),
        blockedUntil: new Date(blockedEnd).toISOString(),
        version: current.version + 1,
      });
      return HttpResponse.json({ appointment: current });
    }),

    route("post", "/api/appointments/:id/cancel", ({ body, params }) => {
      const allowed = ["version", "reason"];
      const unknown = Object.keys(body).find((k) => !allowed.includes(k));
      if (unknown) return validation(unknown, "Campo não reconhecido.");
      const current = agenda.appointments.find((a) => a.id === params.id);
      if (!current) return notFound();
      if (current.version !== body.version) return stale();
      if (!active(current.status))
        return error(
          409,
          "INVALID_STATUS_TRANSITION",
          "Esta ação não é permitida para o status atual do agendamento.",
        );
      agenda.taken.delete(`${current.professionalId}|${current.startsAt}`);
      Object.assign(current, {
        status: "CANCELLED",
        cancelledAt: new Date().toISOString(),
        cancelReason: (body.reason as string | null) ?? null,
        version: current.version + 1,
      });
      return HttpResponse.json({ appointment: current });
    }),
  ];
}
