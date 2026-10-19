import { z } from "zod";
import type { EmailMessage } from "../../lib/email/sender.ts";

export type EmailTemplateName =
  "VERIFY_EMAIL" | "RESET_PASSWORD" | "PASSWORD_CHANGED" | "ACCOUNT_EXISTS";

// Formato do payload cifrado de cada template. Validado depois de decifrar: payload fora do formato é
// tratado como corrompido.
export const payloadSchemas = {
  VERIFY_EMAIL: z.strictObject({ name: z.string(), token: z.string().min(1) }),
  RESET_PASSWORD: z.strictObject({ token: z.string().min(1) }),
  PASSWORD_CHANGED: z.strictObject({}),
  ACCOUNT_EXISTS: z.strictObject({}),
} satisfies Record<EmailTemplateName, z.ZodType>;

export type EmailPayloads = {
  [K in EmailTemplateName]: z.infer<(typeof payloadSchemas)[K]>;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(
  subject: string,
  paragraphs: string[],
  link?: { url: string; label: string },
): Omit<EmailMessage, "to"> {
  const text = [
    ...paragraphs,
    ...(link ? [`${link.label}: ${link.url}`] : []),
    "— Equipe Agendly",
  ].join("\n\n");
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(link
      ? [
          `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`,
        ]
      : []),
    "<p>— Equipe Agendly</p>",
  ].join("\n");
  return { subject, text, html };
}

/** Os links usam o fragmento (#token=…): o token não vai em query string nem em logs de servidor (3.4). */
export function renderEmail(
  template: EmailTemplateName,
  payload: unknown,
  baseUrl: string,
): Omit<EmailMessage, "to"> {
  switch (template) {
    case "VERIFY_EMAIL": {
      const p = payloadSchemas.VERIFY_EMAIL.parse(payload);
      return layout(
        "Confirme seu e-mail no Agendly",
        [
          `Olá, ${p.name}!`,
          "Confirme seu e-mail para começar a usar o Agendly. O link vale por 1 hora.",
        ],
        {
          url: `${baseUrl}/verificar-email#token=${p.token}`,
          label: "Confirmar e-mail",
        },
      );
    }
    case "RESET_PASSWORD": {
      const p = payloadSchemas.RESET_PASSWORD.parse(payload);
      return layout(
        "Redefinição de senha no Agendly",
        [
          "Recebemos um pedido para redefinir sua senha. O link vale por 1 hora e só pode ser usado uma vez.",
          "Se não foi você, ignore este e-mail: sua senha continua a mesma.",
        ],
        {
          url: `${baseUrl}/redefinir-senha#token=${p.token}`,
          label: "Redefinir senha",
        },
      );
    }
    case "PASSWORD_CHANGED":
      payloadSchemas.PASSWORD_CHANGED.parse(payload);
      return layout(
        "Sua senha foi alterada",
        [
          "A senha da sua conta no Agendly acabou de ser alterada e todas as sessões foram encerradas.",
          "Se não foi você, redefina a senha imediatamente.",
        ],
        { url: `${baseUrl}/recuperar-senha`, label: "Recuperar conta" },
      );
    case "ACCOUNT_EXISTS":
      payloadSchemas.ACCOUNT_EXISTS.parse(payload);
      return layout(
        "Você já tem uma conta no Agendly",
        [
          "Alguém tentou criar uma conta com este e-mail, mas ele já está cadastrado. Nada foi alterado.",
          "Se foi você, entre na sua conta ou recupere a senha.",
        ],
        { url: `${baseUrl}/entrar`, label: "Entrar" },
      );
  }
}
