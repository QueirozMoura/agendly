import type { AppointmentStatusName } from "./transitions.ts";

export interface AppointmentView {
  id: string;
  professionalId: string;
  serviceId: string;
  customer: { id: string; name: string };
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  status: AppointmentStatusName;
  /** Valores COPIADOS do serviço na criação: editar o serviço depois não os altera (6.3). */
  service: {
    name: string;
    durationMinutes: number;
    bufferMinutes: number;
    priceCents: number | null;
  };
  source: "PANEL" | "PUBLIC";
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const APPOINTMENT_SELECT = {
  id: true,
  professionalId: true,
  serviceId: true,
  customerId: true,
  startsAt: true,
  endsAt: true,
  blockedUntil: true,
  status: true,
  serviceNameSnapshot: true,
  durationMinutesSnapshot: true,
  bufferMinutesSnapshot: true,
  priceCentsSnapshot: true,
  source: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AppointmentRow = {
  id: string;
  professionalId: string;
  serviceId: string;
  customerId: string;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  status: AppointmentStatusName;
  serviceNameSnapshot: string;
  durationMinutesSnapshot: number;
  bufferMinutesSnapshot: number;
  priceCentsSnapshot: number | null;
  source: "PANEL" | "PUBLIC";
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export function toView(
  row: AppointmentRow,
  customerName: string,
): AppointmentView {
  return {
    id: row.id,
    professionalId: row.professionalId,
    serviceId: row.serviceId,
    customer: { id: row.customerId, name: customerName },
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    blockedUntil: row.blockedUntil,
    status: row.status,
    service: {
      name: row.serviceNameSnapshot,
      durationMinutes: row.durationMinutesSnapshot,
      bufferMinutes: row.bufferMinutesSnapshot,
      priceCents: row.priceCentsSnapshot,
    },
    source: row.source,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
