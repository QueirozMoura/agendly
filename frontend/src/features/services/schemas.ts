// Validação de conveniência (os limites repetem os do backend; o servidor valida de novo).
import { z } from "zod";
import "../auth/schemas"; // mensagens de validação em pt-BR
import { parseReaisToCents } from "../../lib/money";

export const SERVICE_LIMITS = {
  nameMax: 100,
  durationMax: 1440,
  bufferMax: 1440,
  priceMaxCents: 100_000_000,
} as const;

const wholeNumber = (
  label: string,
  min: number,
  max: number,
  minMessage: string,
) =>
  z
    .string()
    .trim()
    .min(1, `Informe ${label}.`)
    .refine((v) => /^\d+$/.test(v), "Informe um número inteiro de minutos.")
    .transform(Number)
    .refine((n) => n >= min, minMessage)
    .refine((n) => n <= max, `No máximo ${max} minutos.`);

export const serviceFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome do serviço.")
    .max(SERVICE_LIMITS.nameMax, "Nome muito longo."),
  durationMinutes: wholeNumber(
    "a duração",
    1,
    SERVICE_LIMITS.durationMax,
    "A duração deve ser de pelo menos 1 minuto.",
  ),
  bufferMinutes: z
    .string()
    .trim()
    .transform((v) => (v === "" ? "0" : v))
    .pipe(
      wholeNumber(
        "o intervalo",
        0,
        SERVICE_LIMITS.bufferMax,
        "O intervalo não pode ser negativo.",
      ),
    ),
  price: z.string().transform((v, ctx) => {
    const cents = parseReaisToCents(v);
    if (cents === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Informe o preço em reais, como 50,00.",
      });
      return z.NEVER;
    }
    if (cents !== null && cents > SERVICE_LIMITS.priceMaxCents) {
      ctx.addIssue({ code: "custom", message: "Preço acima do limite." });
      return z.NEVER;
    }
    return cents;
  }),
});
