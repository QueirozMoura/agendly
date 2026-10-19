import { z } from "zod";
import { canonicalTimeZone } from "../../lib/time/zone.ts";
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN, isReservedSlug } from "./slug.ts";

const name = z
  .string()
  .trim()
  .min(1, "Informe o nome da empresa.")
  .max(100, "Nome muito longo.");

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(SLUG_MIN, `O endereço deve ter pelo menos ${SLUG_MIN} caracteres.`)
  .max(SLUG_MAX, `O endereço deve ter no máximo ${SLUG_MAX} caracteres.`)
  .regex(
    SLUG_PATTERN,
    "Use apenas letras minúsculas, números e hífens (sem hífen no início, no fim ou repetido).",
  )
  .refine(
    (s) => !isReservedSlug(s),
    "Este endereço é reservado. Escolha outro.",
  );

// Fuso IANA no formato Área/Local (ou UTC); o nome canônico é o que se grava. Imutável depois (R9).
const timezone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const canonical = canonicalTimeZone(v);
    if (!canonical) {
      ctx.addIssue({
        code: "custom",
        message:
          "Fuso horário inválido. Use um nome IANA, como America/Sao_Paulo.",
      });
      return z.NEVER;
    }
    return canonical;
  });

// Limites iniciais da página pública (R6, 6.7). Os tetos são limites de sanidade técnica (não são regra de produto)
// e os pisos repetem o CHECK do banco (organizations_public_limits_valid).
const publicMinNoticeMinutes = z
  .number()
  .int("Informe um número inteiro.")
  .min(0)
  .max(7 * 24 * 60);
const publicMaxAdvanceDays = z
  .number()
  .int("Informe um número inteiro.")
  .min(1)
  .max(365);
const publicMaxActiveBookingsPerPhone = z
  .number()
  .int("Informe um número inteiro.")
  .min(1)
  .max(20);

// .strict(): `organizationId`, `timezone`, `status`, `publishedAt`, `role`... são rejeitados com 400.
export const createOrganizationBody = z.strictObject({ name, slug, timezone });

export const updateOrganizationBody = z
  .strictObject({
    name: name.optional(),
    slug: slug.optional(),
    publicMinNoticeMinutes: publicMinNoticeMinutes.optional(),
    publicMaxAdvanceDays: publicMaxAdvanceDays.optional(),
    publicMaxActiveBookingsPerPhone: publicMaxActiveBookingsPerPhone.optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );

export const switchOrganizationBody = z.strictObject({
  slug: z.string().trim().toLowerCase().min(1).max(SLUG_MAX),
});

/** Rotas de leitura não aceitam parâmetros de consulta (nem `organizationId`). */
export const emptyQuery = z.strictObject({});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationBody>;
