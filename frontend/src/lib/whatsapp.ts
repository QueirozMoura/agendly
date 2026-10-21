import type { ApiAppointment, AppointmentStatus } from "../api/types";
import { utcIsoToZonedLocal } from "./time";
import { normalizePhone } from "./phone";

export function canPrepareWhatsApp(
  appointment: Pick<ApiAppointment, "startsAt" | "status">,
  now: number = Date.now(),
): boolean {
  return (
    (appointment.status === "SCHEDULED" ||
      appointment.status === "CONFIRMED") &&
    new Date(appointment.startsAt).getTime() > now
  );
}

/** Identidade dos dados exibidos: inclui versão, cliente, snapshots e datas, sem depender da ordem das chaves HTTP. */
export function appointmentConfirmationKey(a: ApiAppointment): string {
  return JSON.stringify([
    a.id,
    a.version,
    a.updatedAt,
    a.status,
    a.startsAt,
    a.endsAt,
    a.blockedUntil,
    a.professionalId,
    a.serviceId,
    a.customer.id,
    a.customer.name,
    a.service.name,
    a.service.durationMinutes,
    a.service.bufferMinutes,
    a.service.priceCents,
    a.source,
    a.cancelledAt,
    a.cancelReason,
    a.createdAt,
  ]);
}

export interface ConfirmationMessageInput {
  customerName?: string;
  organizationName?: string;
  serviceName?: string;
  startsAt: string;
  timeZone: string;
  status: AppointmentStatus;
}

// Mantém nomes em uma linha para não confundi-los com os campos da mensagem.
const text = (value: string | undefined) => value?.replace(/\s+/g, " ").trim();

/** Só formata conteúdo. Não envia, não persiste e não altera o status do agendamento. */
export function buildConfirmationMessage(
  input: ConfirmationMessageInput,
): string | null {
  if (input.status !== "SCHEDULED" && input.status !== "CONFIRMED") return null;
  let local: string;
  try {
    local = utcIsoToZonedLocal(input.startsAt, input.timeZone);
  } catch {
    return null;
  }
  if (!local) return null;
  const [date = "", time = ""] = local.split("T");
  const [year, month, day] = date.split("-");
  const customer = text(input.customerName);
  const organization = text(input.organizationName);
  const service = text(input.serviceName);
  return [
    customer ? `Olá, ${customer}! 👋` : "Olá! 👋",
    "",
    `Seu agendamento${organization ? ` na ${organization}` : ""} está ${input.status === "CONFIRMED" ? "confirmado" : "marcado"}!`,
    "",
    `📅 Data: ${day}/${month}/${year}`,
    `🕒 Horário: ${time}`,
    ...(service ? [`📋 Serviço: ${service}`] : []),
    "",
    "Aguardamos você!",
  ].join("\n");
}

export function buildWhatsAppLink(
  phone: unknown,
  message: string,
): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized || !message.trim()) return null;
  return `https://wa.me/${normalized.slice(1)}?text=${encodeURIComponent(message)}`;
}
