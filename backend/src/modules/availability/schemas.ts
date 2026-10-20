import { z } from "zod";
import { isValidLocalDate } from "../../lib/time/zone.ts";
import { SLOT_GRID_MINUTES } from "./slots.ts";

export const AVAILABILITY_LIMITS = {
  reasonMax: 200, // teto de sanidade
  timeOffMaxDays: 366, // duração máxima de uma folga (sanidade)
  timeOffMaxPerProfessional: 1000, // sanidade
  /** Máximo de agendamentos detalhados em `details.conflicts` (R4); o total real vai em `totalCount`. */
  conflictListMax: 100,
  minYear: 2000,
  maxYear: 2100,
} as const;

const TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/** "HH:mm" (ou "24:00") em múltiplos de 15 min => minutos desde 00:00. */
const clockTime = z
  .string("Informe o horário no formato HH:mm.")
  .regex(TIME, "Informe o horário no formato HH:mm.")
  .transform((v) => {
    const [h, m] = v.split(":").map(Number) as [number, number];
    return h * 60 + m;
  })
  .refine(
    (minutes) => minutes % SLOT_GRID_MINUTES === 0,
    `O horário deve ser múltiplo de ${SLOT_GRID_MINUTES} minutos.`,
  );

const weekday = z
  .number("Informe o dia da semana (0 = domingo ... 6 = sábado).")
  .int("Informe o dia da semana (0 = domingo ... 6 = sábado).")
  .min(0, "Informe o dia da semana (0 = domingo ... 6 = sábado).")
  .max(6, "Informe o dia da semana (0 = domingo ... 6 = sábado).");

const professionalId = z.uuid("Identificador de profissional inválido.");

// .strict(): `organizationId`, `id` e demais campos desconhecidos => 400. O profissional de um intervalo não muda.
export const createWorkingHoursBody = z
  .strictObject({
    professionalId,
    weekday,
    startTime: clockTime,
    endTime: clockTime,
  })
  .refine((b) => b.startTime < b.endTime, {
    message: "O início deve ser anterior ao fim.",
    path: ["endTime"],
  });

export const updateWorkingHoursBody = z
  .strictObject({
    weekday: weekday.optional(),
    startTime: clockTime.optional(),
    endTime: clockTime.optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );

const instant = z.iso
  .datetime({ offset: true, message: "Informe data e hora ISO 8601 com fuso." })
  .transform((v) => new Date(v))
  .refine(
    (d) =>
      d.getUTCFullYear() >= AVAILABILITY_LIMITS.minYear &&
      d.getUTCFullYear() <= AVAILABILITY_LIMITS.maxYear,
    "Data fora do intervalo aceito.",
  );

const reason = z
  .string("Informe o motivo como texto.")
  .trim()
  .max(AVAILABILITY_LIMITS.reasonMax, "Motivo muito longo.")
  .transform((v) => (v === "" ? null : v));

export const createTimeOffBody = z.strictObject({
  professionalId,
  startsAt: instant,
  endsAt: instant,
  reason: reason.nullish().transform((v) => v ?? null),
});

export const updateTimeOffBody = z
  .strictObject({
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    reason: reason.nullable().optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );

/** Intervalo de folga coerente (ends > starts e duração máxima). Vale também para o resultado de um PATCH. */
export function timeOffRangeIssue(
  startsAt: Date,
  endsAt: Date,
): string | undefined {
  if (endsAt.getTime() <= startsAt.getTime())
    return "O fim deve ser posterior ao início.";
  if (
    endsAt.getTime() - startsAt.getTime() >
    AVAILABILITY_LIMITS.timeOffMaxDays * 86_400_000
  )
    return `A folga não pode passar de ${AVAILABILITY_LIMITS.timeOffMaxDays} dias.`;
  return undefined;
}

export const listByProfessionalQuery = z.strictObject({ professionalId });

/** UUID no caminho. Malformado = inexistente (404), sem diferenciar do "não é seu". */
export const entryIdParam = z.uuid();

/** Leitura de slots: dia LOCAL da empresa ("YYYY-MM-DD"). É sugestão para a UI: nunca trava (R-e, L15). */
export const slotsQuery = z.strictObject({
  professionalId,
  serviceId: z.uuid("Identificador de serviço inválido."),
  date: z
    .string("Informe o dia no formato AAAA-MM-DD.")
    .refine(isValidLocalDate, "Informe o dia no formato AAAA-MM-DD."),
});
