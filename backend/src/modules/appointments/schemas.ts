import { z } from "zod";
import { normalizePhone } from "../../lib/phone.ts";
import { APPOINTMENT_STATUSES } from "./transitions.ts";

export const APPOINTMENT_LIMITS = {
  nameMax: 100, // teto de sanidade
  emailMax: 254,
  notesMax: 1000,
  reasonMax: 200,
  /** Limite de sanidade técnica contra erro de digitação (R7, 6.6): o painel não aceita datas além disto. */
  maxDaysAhead: 730,
  listMaxSpanDays: 93,
  listMax: 500,
} as const;

const uuid = (what: string) => z.uuid(`Identificador de ${what} inválido.`);

const instant = z.iso
  .datetime({ offset: true, message: "Informe data e hora ISO 8601 com fuso." })
  .transform((v) => new Date(v));

const phone = z
  .string("Informe o telefone.")
  .trim()
  .transform((v, ctx) => {
    const e164 = normalizePhone(v);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "Telefone inválido." });
      return z.NEVER;
    }
    return e164;
  });

const customerName = z
  .string("Informe o nome do cliente.")
  .trim()
  .min(1, "Informe o nome do cliente.")
  .max(APPOINTMENT_LIMITS.nameMax, "Nome muito longo.");

const optionalEmail = z
  .email("E-mail inválido.")
  .max(APPOINTMENT_LIMITS.emailMax, "E-mail muito longo.")
  .transform((v) => v.trim().toLowerCase())
  .nullish()
  .transform((v) => v ?? null);

const optionalNotes = z
  .string("Informe as observações como texto.")
  .trim()
  .max(APPOINTMENT_LIMITS.notesMax, "Observações muito longas.")
  .transform((v) => (v === "" ? null : v))
  .nullish()
  .transform((v) => v ?? null);

/** Cliente novo (ou existente pelo telefone: então os dados guardados NÃO são sobrescritos). */
export const newCustomerBody = z.strictObject({
  name: customerName,
  phone,
  email: optionalEmail,
  notes: optionalNotes,
});

// .strict(): `organizationId`, `id`, `status`, `source`, `endsAt`... => 400. `customerId` XOR `customer`.
export const createAppointmentBody = z
  .strictObject({
    professionalId: uuid("profissional"),
    serviceId: uuid("serviço"),
    startsAt: instant,
    customerId: uuid("cliente").optional(),
    customer: newCustomerBody.optional(),
  })
  .refine((b) => (b.customerId === undefined) !== (b.customer === undefined), {
    message: "Informe customerId ou customer (apenas um).",
    path: ["customer"],
  });

const version = z
  .number("Informe a versão do agendamento.")
  .int("Informe a versão do agendamento.")
  .min(1, "Informe a versão do agendamento.");

export const rescheduleBody = z.strictObject({
  startsAt: instant,
  professionalId: uuid("profissional").optional(),
  version,
});

export const cancelBody = z.strictObject({
  version,
  reason: z
    .string("Informe o motivo como texto.")
    .trim()
    .max(APPOINTMENT_LIMITS.reasonMax, "Motivo muito longo.")
    .transform((v) => (v === "" ? null : v))
    .nullish()
    .transform((v) => v ?? null),
});

export const versionBody = z.strictObject({ version });

export const listAppointmentsQuery = z
  .strictObject({
    from: instant,
    to: instant,
    professionalId: uuid("profissional").optional(),
    customerId: uuid("cliente").optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
  })
  .refine((q) => q.to.getTime() > q.from.getTime(), {
    message: "O fim deve ser posterior ao início.",
    path: ["to"],
  })
  .refine(
    (q) =>
      q.to.getTime() - q.from.getTime() <=
      APPOINTMENT_LIMITS.listMaxSpanDays * 86_400_000,
    {
      message: `O período não pode passar de ${APPOINTMENT_LIMITS.listMaxSpanDays} dias.`,
      path: ["to"],
    },
  );

export const idempotencyKeyHeader = z.uuid("Idempotency-Key deve ser um UUID.");

/** UUID no caminho. Malformado = inexistente (404), sem diferenciar do "não é seu". */
export const appointmentIdParam = z.uuid();
