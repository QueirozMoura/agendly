import { z } from "zod";

export const PROFESSIONAL_LIMITS = {
  nameMax: 100, // teto de sanidade
  maxServicesPerProfessional: 200, // teto de sanidade
} as const;

const name = z
  .string()
  .trim()
  .min(1, "Informe o nome do profissional.")
  .max(PROFESSIONAL_LIMITS.nameMax, "Nome muito longo.");

// .strict(): `organizationId`, `id`, `userId` (profissionais não têm conta, D2), `active` na criação etc. => 400.
export const createProfessionalBody = z.strictObject({ name });

export const updateProfessionalBody = z
  .strictObject({
    name: name.optional(),
    active: z.boolean("Informe verdadeiro ou falso.").optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );

export const listProfessionalsQuery = z.strictObject({
  active: z.enum(["true", "false"]).optional(),
});

/** Conjunto COMPLETO de serviços do profissional (substitui o anterior). Vazio desvincula tudo. */
export const setServicesBody = z.strictObject({
  serviceIds: z
    .array(z.uuid("Identificador de serviço inválido."))
    .max(PROFESSIONAL_LIMITS.maxServicesPerProfessional, "Serviços demais."),
});

/** UUID no caminho. Malformado = inexistente (404), sem diferenciar do "não é seu". */
export const professionalIdParam = z.uuid();
