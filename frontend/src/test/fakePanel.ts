// Parte do backend FALSO da Etapa 12: serviços, profissionais (e vínculos), horário de trabalho e folgas. Reproduz os
// contratos das Etapas 7–10: validação (400 com `details`), 404 indistinguível, 409 de sobreposição e de conflito com
// agendamentos (R4: nada muda quando recusa), 204 nas remoções, e o `PUT` que substitui o conjunto completo de serviços.
import { http, HttpResponse } from "msw";
import type {
  ApiProfessional,
  ApiService,
  ApiTimeOff,
  ApiWorkingHours,
  ConflictDetails,
} from "../api/types";
import { error, unauthorized, type FakeState } from "./fakeBackend";

export interface PanelState {
  services: ApiService[];
  professionals: ApiProfessional[];
  workingHours: ApiWorkingHours[];
  timeOff: ApiTimeOff[];
  /** Quando definido, criar/alterar folga e alterar/remover expediente são RECUSADOS com 409 e esta lista (R4). */
  conflicts: ConflictDetails | null;
  seq: number;
}

export const makePanel = (over: Partial<PanelState> = {}): PanelState => ({
  services: [],
  professionals: [],
  workingHours: [],
  timeOff: [],
  conflicts: null,
  seq: 0,
  ...over,
});

const NOW = "2031-03-01T12:00:00.000Z";
export const makeService = (
  id: string,
  name: string,
  over: Partial<ApiService> = {},
): ApiService => ({
  id,
  name,
  durationMinutes: 30,
  bufferMinutes: 0,
  priceCents: null,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
export const makeProfessional = (
  id: string,
  name: string,
  over: Partial<ApiProfessional> = {},
): ApiProfessional => ({
  id,
  name,
  active: true,
  serviceIds: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
export const makeHours = (
  id: string,
  professionalId: string,
  weekday: number,
  startTime: string,
  endTime: string,
): ApiWorkingHours => ({
  id,
  professionalId,
  weekday,
  startTime,
  endTime,
  createdAt: NOW,
  updatedAt: NOW,
});
export const makeTimeOff = (
  id: string,
  professionalId: string,
  startsAt: string,
  endsAt: string,
  reason: string | null = null,
): ApiTimeOff => ({
  id,
  professionalId,
  startsAt,
  endsAt,
  reason,
  createdAt: NOW,
  updatedAt: NOW,
});

const validation = (path: string, message: string) =>
  error(400, "VALIDATION_ERROR", "Dados inválidos.", {
    details: [{ path, message }],
  });
const notFound = () => error(404, "NOT_FOUND", "Recurso não encontrado.");
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export type Ctx = {
  body: Record<string, unknown>;
  request: Request;
  params: Record<string, string>;
  url: URL;
};

/** Rota com a regra de tenant do backend: CSRF (415), registro da chamada, 401, 403 sem empresa e `X-Active-Org`. */
export function tenantRoute(state: FakeState) {
  return (
    method: "get" | "post" | "patch" | "put" | "delete",
    path: string,
    fn: (ctx: Ctx) => Response | Promise<Response>,
  ) =>
    http[method](`*${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      let body: Record<string, unknown> = {};
      if (request.method !== "GET") {
        const type = request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (type !== "application/json")
          return error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "O tipo de conteúdo deve ser application/json.",
          );
        body = (await request.json()) as Record<string, unknown>;
      }
      state.calls.push({
        method: request.method,
        path: url.pathname,
        body,
        headers: request.headers,
        search: url.search,
      });
      if (!state.user) return unauthorized();
      if (!state.activeSlug)
        return error(
          403,
          "NO_ACTIVE_ORGANIZATION",
          "Selecione uma empresa para continuar.",
        );
      const asserted = request.headers.get("x-active-org");
      if (asserted !== null && asserted !== state.activeSlug)
        return error(
          409,
          "ACTIVE_ORG_CHANGED",
          "A empresa ativa mudou em outra aba. Recarregue a página.",
        );
      return fn({
        body,
        request,
        params: params as Record<string, string>,
        url,
      });
    });
}

export function panelBackend(state: FakeState) {
  const panel = state.panel;
  const nextId = (prefix: string) => `${prefix}-${++panel.seq}`;

  const route = tenantRoute(state);

  const conflict = (code: string) =>
    error(409, code, "Conflito com agendamentos ativos.", {
      details: panel.conflicts,
    });
  const isInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v);

  return [
    // ── serviços ──
    route("get", "/api/services", () =>
      HttpResponse.json({ services: panel.services }),
    ),
    route("post", "/api/services", ({ body }) => {
      if (typeof body.name !== "string" || body.name.trim() === "")
        return validation("name", "Informe o nome do serviço.");
      if (!isInt(body.durationMinutes) || body.durationMinutes < 1)
        return validation(
          "durationMinutes",
          "A duração deve ser de pelo menos 1 minuto.",
        );
      if (
        body.bufferMinutes !== undefined &&
        (!isInt(body.bufferMinutes) || body.bufferMinutes < 0)
      )
        return validation(
          "bufferMinutes",
          "O intervalo de preparação não pode ser negativo.",
        );
      const service = makeService(nextId("svc"), body.name.trim(), {
        durationMinutes: body.durationMinutes,
        bufferMinutes: (body.bufferMinutes as number | undefined) ?? 0,
        priceCents: (body.priceCents as number | null | undefined) ?? null,
      });
      panel.services.push(service);
      return HttpResponse.json({ service }, { status: 201 });
    }),
    route("patch", "/api/services/:id", ({ body, params }) => {
      const service = panel.services.find((s) => s.id === params.id);
      if (!service) return notFound();
      if (Object.keys(body).length === 0)
        return validation("_", "Informe ao menos um campo para alterar.");
      if (
        "durationMinutes" in body &&
        (!isInt(body.durationMinutes) || body.durationMinutes < 1)
      )
        return validation(
          "durationMinutes",
          "A duração deve ser de pelo menos 1 minuto.",
        );
      Object.assign(service, body);
      return HttpResponse.json({ service });
    }),

    // ── profissionais ──
    route("get", "/api/professionals", () =>
      HttpResponse.json({ professionals: panel.professionals }),
    ),
    route("post", "/api/professionals", ({ body }) => {
      if (typeof body.name !== "string" || body.name.trim() === "")
        return validation("name", "Informe o nome do profissional.");
      const professional = makeProfessional(nextId("pro"), body.name.trim());
      panel.professionals.push(professional);
      return HttpResponse.json({ professional }, { status: 201 });
    }),
    route("get", "/api/professionals/:id", ({ params }) => {
      const professional = panel.professionals.find((p) => p.id === params.id);
      return professional ? HttpResponse.json({ professional }) : notFound();
    }),
    route("patch", "/api/professionals/:id", ({ body, params }) => {
      const professional = panel.professionals.find((p) => p.id === params.id);
      if (!professional) return notFound();
      Object.assign(professional, body);
      return HttpResponse.json({ professional });
    }),
    route("put", "/api/professionals/:id/services", ({ body, params }) => {
      const professional = panel.professionals.find((p) => p.id === params.id);
      if (!professional) return notFound();
      const ids = body.serviceIds as string[];
      // serviço inexistente (ou de outra empresa) ⇒ 404 e NADA é aplicado
      if (
        !Array.isArray(ids) ||
        ids.some((id) => !panel.services.some((s) => s.id === id))
      )
        return notFound();
      professional.serviceIds = [...new Set(ids)].sort();
      return HttpResponse.json({ professional });
    }),

    // ── horário de trabalho ──
    route("get", "/api/working-hours", ({ url }) => {
      const id = url.searchParams.get("professionalId") ?? "";
      if (!panel.professionals.some((p) => p.id === id)) return notFound();
      const list = panel.workingHours
        .filter((w) => w.professionalId === id)
        .sort(
          (a, b) =>
            a.weekday - b.weekday ||
            minutes(a.startTime) - minutes(b.startTime),
        );
      return HttpResponse.json({ workingHours: list });
    }),
    route("post", "/api/working-hours", ({ body }) => {
      if (!panel.professionals.some((p) => p.id === body.professionalId))
        return notFound();
      const { weekday, startTime, endTime } = body as {
        weekday: number;
        startTime: string;
        endTime: string;
      };
      if (minutes(startTime) >= minutes(endTime))
        return validation("endTime", "O início deve ser anterior ao fim.");
      const clash = panel.workingHours.some(
        (w) =>
          w.professionalId === body.professionalId &&
          w.weekday === weekday &&
          minutes(w.startTime) < minutes(endTime) &&
          minutes(startTime) < minutes(w.endTime),
      );
      if (clash)
        return error(
          409,
          "WORKING_HOURS_OVERLAP",
          "O intervalo se sobrepõe a outro do mesmo dia.",
        );
      const created = makeHours(
        nextId("wh"),
        body.professionalId as string,
        weekday,
        startTime,
        endTime,
      );
      panel.workingHours.push(created);
      return HttpResponse.json({ workingHours: created }, { status: 201 });
    }),
    route("patch", "/api/working-hours/:id", ({ body, params }) => {
      const current = panel.workingHours.find((w) => w.id === params.id);
      if (!current) return notFound();
      const next = { ...current, ...body } as ApiWorkingHours;
      if (minutes(next.startTime) >= minutes(next.endTime))
        return validation("endTime", "O início deve ser anterior ao fim.");
      const clash = panel.workingHours.some(
        (w) =>
          w.id !== current.id &&
          w.professionalId === current.professionalId &&
          w.weekday === next.weekday &&
          minutes(w.startTime) < minutes(next.endTime) &&
          minutes(next.startTime) < minutes(w.endTime),
      );
      if (clash)
        return error(
          409,
          "WORKING_HOURS_OVERLAP",
          "O intervalo se sobrepõe a outro do mesmo dia.",
        );
      if (panel.conflicts)
        return conflict("WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS");
      Object.assign(current, body);
      return HttpResponse.json({ workingHours: current });
    }),
    route("delete", "/api/working-hours/:id", ({ params }) => {
      const index = panel.workingHours.findIndex((w) => w.id === params.id);
      if (index < 0) return notFound();
      if (panel.conflicts)
        return conflict("WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS");
      panel.workingHours.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),

    // ── folgas ──
    route("get", "/api/time-off", ({ url }) => {
      const id = url.searchParams.get("professionalId") ?? "";
      if (!panel.professionals.some((p) => p.id === id)) return notFound();
      const list = panel.timeOff
        .filter((o) => o.professionalId === id)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return HttpResponse.json({ timeOff: list });
    }),
    route("post", "/api/time-off", ({ body }) => {
      if (!panel.professionals.some((p) => p.id === body.professionalId))
        return notFound();
      if (new Date(body.endsAt as string) <= new Date(body.startsAt as string))
        return validation("endsAt", "O fim deve ser posterior ao início.");
      if (panel.conflicts)
        return conflict("TIMEOFF_CONFLICTS_WITH_APPOINTMENTS");
      const created = makeTimeOff(
        nextId("off"),
        body.professionalId as string,
        body.startsAt as string,
        body.endsAt as string,
        (body.reason as string | null) ?? null,
      );
      panel.timeOff.push(created);
      return HttpResponse.json({ timeOff: created }, { status: 201 });
    }),
    route("patch", "/api/time-off/:id", ({ body, params }) => {
      const current = panel.timeOff.find((o) => o.id === params.id);
      if (!current) return notFound();
      if (panel.conflicts)
        return conflict("TIMEOFF_CONFLICTS_WITH_APPOINTMENTS");
      Object.assign(current, body);
      return HttpResponse.json({ timeOff: current });
    }),
    route("delete", "/api/time-off/:id", ({ params }) => {
      const index = panel.timeOff.findIndex((o) => o.id === params.id);
      if (index < 0) return notFound();
      panel.timeOff.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
