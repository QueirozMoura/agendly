import { z } from "zod";

// Tetos de SANIDADE técnica (não são regra de produto; o plano só exige duração >= 1 e buffer >= 0).
// Os pisos repetem os CHECKs do banco (services_duration_positive / _buffer_non_negative / _price_non_negative).
export const SERVICE_LIMITS = {
  nameMax: 100,
  durationMax: 24 * 60, // um atendimento não passa de um dia
  bufferMax: 24 * 60,
  priceMaxCents: 100_000_000, // R$ 1.000.000,00
} as const;

const name = z
  .string()
  .trim()
  .min(1, "Informe o nome do serviço.")
  .max(SERVICE_LIMITS.nameMax, "Nome muito longo.");
const durationMinutes = z
  .number("Informe um número.")
  .int("Informe um número inteiro de minutos.")
  .min(1, "A duração deve ser de pelo menos 1 minuto.")
  .max(
    SERVICE_LIMITS.durationMax,
    `A duração deve ser de no máximo ${SERVICE_LIMITS.durationMax} minutos.`,
  );
const bufferMinutes = z
  .number("Informe um número.")
  .int("Informe um número inteiro de minutos.")
  .min(0, "O intervalo de preparação não pode ser negativo.")
  .max(
    SERVICE_LIMITS.bufferMax,
    `O intervalo deve ser de no máximo ${SERVICE_LIMITS.bufferMax} minutos.`,
  );
const priceCents = z
  .number("Informe um número.")
  .int("Informe o preço em centavos (número inteiro).")
  .min(0, "O preço não pode ser negativo.")
  .max(SERVICE_LIMITS.priceMaxCents, "Preço acima do limite.");

// .strict(): `organizationId`, `id`, `active` (na criação), datas etc. são rejeitados com 400.
export const createServiceBody = z.strictObject({
  name,
  durationMinutes,
  bufferMinutes: bufferMinutes.default(0),
  priceCents: priceCents.nullable().default(null),
});

export const updateServiceBody = z
  .strictObject({
    name: name.optional(),
    durationMinutes: durationMinutes.optional(),
    bufferMinutes: bufferMinutes.optional(),
    priceCents: priceCents.nullable().optional(), // null remove o preço
    active: z.boolean("Informe verdadeiro ou falso.").optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );

export const listServicesQuery = z.strictObject({
  active: z.enum(["true", "false"]).optional(),
});

/** UUID do serviço no caminho. Malformado = inexistente (404), sem diferenciar do "não é seu". */
export const serviceIdParam = z.uuid();
