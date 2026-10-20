import { z } from "zod";
import { normalizePhone } from "../../lib/phone.ts";
import { APPOINTMENT_LIMITS } from "../appointments/schemas.ts";

export const customerIdParam = z.uuid();

// .strict(): `organizationId` e `id` => 400. Trocar o telefone pode colidir com outro cliente (409).
export const updateCustomerBody = z
  .strictObject({
    name: z
      .string("Informe o nome do cliente.")
      .trim()
      .min(1, "Informe o nome do cliente.")
      .max(APPOINTMENT_LIMITS.nameMax, "Nome muito longo.")
      .optional(),
    phone: z
      .string("Informe o telefone.")
      .trim()
      .transform((v, ctx) => {
        const e164 = normalizePhone(v);
        if (!e164) {
          ctx.addIssue({ code: "custom", message: "Telefone inválido." });
          return z.NEVER;
        }
        return e164;
      })
      .optional(),
    email: z
      .email("E-mail inválido.")
      .max(APPOINTMENT_LIMITS.emailMax, "E-mail muito longo.")
      .transform((v) => v.trim().toLowerCase())
      .nullable()
      .optional(),
    notes: z
      .string("Informe as observações como texto.")
      .trim()
      .max(APPOINTMENT_LIMITS.notesMax, "Observações muito longas.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    "Informe ao menos um campo para alterar.",
  );
