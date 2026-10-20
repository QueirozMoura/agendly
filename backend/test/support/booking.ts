// Helpers da Etapa 10: empresa com profissional, serviço, vínculo e expediente prontos para agendar.
// Relógio dos testes (TestClock): 2031-03-01T12:00:00Z = sábado 09:00 em America/Sao_Paulo (UTC-3, sem horário de verão).
import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { AuthTestApp } from "./auth-app.ts";
import { api, type TestUser } from "./orgs.ts";

/** ISO local de São Paulo: `at("2031-03-03", "10:00")` ⇒ segunda-feira 10:00 (UTC-3). */
export const at = (day: string, hhmm: string) => `${day}T${hhmm}:00-03:00`;
export const MONDAY = "2031-03-03";
export const TUESDAY = "2031-03-04";

export interface Bookable {
  professionalId: string;
  serviceId: string;
}

export interface MakeOptions {
  name?: string;
  durationMinutes?: number;
  bufferMinutes?: number;
  priceCents?: number;
  /** Expediente de segunda a sexta (1–5); padrão 08:00–18:00. */
  hours?: [string, string][];
  weekdays?: number[];
}

export async function makeProfessional(
  t: AuthTestApp,
  user: TestUser,
  serviceId: string | undefined,
  o: { name?: string; hours?: [string, string][]; weekdays?: number[] } = {},
): Promise<string> {
  const p = await api(t, "POST", "/api/professionals", user, {
    name: o.name ?? "Carla",
  });
  const professionalId = p.json().professional.id as string;
  if (serviceId)
    await api(t, "PUT", `/api/professionals/${professionalId}/services`, user, {
      serviceIds: [serviceId],
    });
  for (const weekday of o.weekdays ?? [1, 2, 3, 4, 5])
    for (const [startTime, endTime] of o.hours ?? [["08:00", "18:00"]]) {
      const w = await api(t, "POST", "/api/working-hours", user, {
        professionalId,
        weekday,
        startTime,
        endTime,
      });
      if (w.statusCode !== 201) throw new Error(`expediente: ${w.body}`);
    }
  return professionalId;
}

export async function makeService(
  t: AuthTestApp,
  user: TestUser,
  o: MakeOptions = {},
): Promise<string> {
  const res = await api(t, "POST", "/api/services", user, {
    name: o.name ?? "Corte",
    durationMinutes: o.durationMinutes ?? 30,
    bufferMinutes: o.bufferMinutes ?? 0,
    ...(o.priceCents === undefined ? {} : { priceCents: o.priceCents }),
  });
  if (res.statusCode !== 201) throw new Error(`serviço: ${res.body}`);
  return res.json().service.id as string;
}

export async function makeBookable(
  t: AuthTestApp,
  user: TestUser,
  o: MakeOptions = {},
): Promise<Bookable> {
  const serviceId = await makeService(t, user, o);
  const professionalId = await makeProfessional(t, user, serviceId, o);
  return { professionalId, serviceId };
}

export interface BookInput {
  professionalId: string;
  serviceId: string;
  startsAt: string;
  customerId?: string;
  customer?: Record<string, unknown>;
}

export const newCustomer = (n = 1, over: Record<string, unknown> = {}) => ({
  name: `Cliente ${n}`,
  phone: `(11) 98888-${String(1000 + n).padStart(4, "0")}`,
  ...over,
});

export function book(
  t: AuthTestApp,
  user: TestUser,
  input: BookInput,
  key: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  const body = {
    ...input,
    ...(input.customerId || input.customer ? {} : { customer: newCustomer() }),
  };
  return api(t, "POST", "/api/appointments", user, body, {
    "idempotency-key": key,
  });
}

export async function bookOk(
  t: AuthTestApp,
  user: TestUser,
  input: BookInput,
): Promise<AppointmentJson> {
  const res = await book(t, user, input);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().appointment as AppointmentJson;
}

export interface AppointmentJson {
  id: string;
  professionalId: string;
  serviceId: string;
  customer: { id: string; name: string };
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  status: string;
  service: {
    name: string;
    durationMinutes: number;
    bufferMinutes: number;
    priceCents: number | null;
  };
  source: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
}

export const post = (
  t: AuthTestApp,
  user: TestUser | undefined,
  url: string,
  body: unknown,
) => api(t, "POST", url, user, body);
