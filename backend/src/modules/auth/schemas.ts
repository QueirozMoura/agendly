import { z } from "zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isCommonPassword,
} from "./password.ts";

z.config(z.locales.ptBR());

// Normaliza antes de validar: o banco só aceita e-mails em minúsculas (CHECK users_email_lowercase).
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "E-mail inválido." }).max(254, "E-mail muito longo."));

export const registerBody = z.strictObject({
  email,
  name: z
    .string()
    .trim()
    .min(1, "Informe seu nome.")
    .max(100, "Nome muito longo."),
  password: z
    .string()
    .min(
      PASSWORD_MIN_LENGTH,
      `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
    )
    .max(
      PASSWORD_MAX_LENGTH,
      `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
    )
    .refine(
      (p) => !isCommonPassword(p),
      "Essa senha é muito comum. Escolha outra.",
    ),
});

// No login a política de senha não se aplica (contas antigas, mensagem uniforme); só limita o tamanho.
export const loginBody = z.strictObject({
  email,
  password: z
    .string()
    .min(1, "Informe a senha.")
    .max(PASSWORD_MAX_LENGTH, "Senha inválida."),
});
