// Único módulo que importa date-fns-tz (regra da seção 2). Evidência: docs/STAGE-3-VALIDATIONS.md, V1.
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

export class TimeZoneError extends Error {}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Converte um horário local ("2026-10-19T09:00:00", sem offset) da empresa para UTC.
 * - Fuso inválido ou horário inexistente (lacuna do horário de verão) => TimeZoneError. A date-fns-tz
 *   não avisa: devolve silenciosamente um instante uma hora antes, que corresponde a outro horário local.
 * - Horário ambíguo (repetido na volta do horário de verão) => primeira ocorrência (a de maior offset).
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  if (!isValidTimeZone(timeZone))
    throw new TimeZoneError(`Fuso inválido: ${timeZone}`);
  const utc = fromZonedTime(local, timeZone);
  if (Number.isNaN(utc.getTime()))
    throw new TimeZoneError(`Horário local inválido: ${local}`);
  if (formatInTimeZone(utc, timeZone, LOCAL_FORMAT) !== local) {
    throw new TimeZoneError(
      `Horário local inexistente em ${timeZone}: ${local}`,
    );
  }
  return utc;
}

export function utcToZonedLocal(utc: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone))
    throw new TimeZoneError(`Fuso inválido: ${timeZone}`);
  return formatInTimeZone(utc, timeZone, LOCAL_FORMAT);
}

/**
 * Nome IANA canônico ("America/Sao_Paulo") ou undefined. Exige o formato Área/Local (ou "UTC"): rejeita
 * deslocamentos fixos ("+03:00") e abreviações legadas ("EST"), que o Intl aceitaria mas não são fusos de
 * calendário com horário de verão. A caixa é normalizada (o Intl é insensível a maiúsculas).
 */
export function canonicalTimeZone(input: string): string | undefined {
  if (!/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/i.test(input)) return undefined;
  if (!isValidTimeZone(input)) return undefined;
  return new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions()
    .timeZone;
}
