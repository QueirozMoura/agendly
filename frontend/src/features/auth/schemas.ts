// Validação de CONVENIÊNCIA no cliente (seção 1): melhora a UX, não protege nada. O servidor valida tudo de novo e a
// lista de senhas comuns só existe lá.
import { z } from "zod";

z.config(z.locales.ptBR());

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("E-mail inválido.").max(254, "E-mail muito longo."));

const newPassword = z
  .string()
  .min(PASSWORD_MIN, `A senha deve ter pelo menos ${PASSWORD_MIN} caracteres.`)
  .max(PASSWORD_MAX, `A senha deve ter no máximo ${PASSWORD_MAX} caracteres.`);

export const loginSchema = z.object({
  email,
  password: z
    .string()
    .min(1, "Informe a senha.")
    .max(PASSWORD_MAX, "Senha inválida."),
});

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe seu nome.")
    .max(100, "Nome muito longo."),
  email,
  password: newPassword,
});

export const forgotSchema = z.object({ email });

export const resetSchema = z
  .object({ newPassword, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, {
    message: "As senhas não conferem.",
    path: ["confirm"],
  });
