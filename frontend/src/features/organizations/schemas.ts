import { z } from "zod";
import "../auth/schemas"; // configura as mensagens de validação em pt-BR

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
// Mesmo formato do banco/servidor (minúsculas, números e hífens, sem hífen no início/fim/repetido). A lista de
// endereços reservados e a unicidade só o servidor conhece.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const organizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome da empresa.")
    .max(100, "Nome muito longo."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(SLUG_MIN, `O endereço deve ter pelo menos ${SLUG_MIN} caracteres.`)
    .max(SLUG_MAX, `O endereço deve ter no máximo ${SLUG_MAX} caracteres.`)
    .regex(
      SLUG_PATTERN,
      "Use apenas letras minúsculas, números e hífens (sem hífen no início, no fim ou repetido).",
    ),
  timezone: z.string().min(1, "Escolha o fuso horário."),
});

/** Sugere o endereço a partir do nome: sem acentos, minúsculas, hífens no lugar de qualquer outro símbolo. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Fusos IANA no formato Área/Local (o servidor recusa deslocamentos fixos e abreviações). */
export function timeZoneOptions(): string[] {
  const supported = (): string[] => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  };
  const list = supported().filter((z) => z.includes("/"));
  if (!list.includes(DEFAULT_TIMEZONE)) list.unshift(DEFAULT_TIMEZONE);
  return list;
}
