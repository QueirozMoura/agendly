// Datas LOCAIS da empresa ("AAAA-MM-DD") para a agenda. A conversão de/para UTC é toda de `lib/time.ts`; aqui só há
// aritmética de calendário sobre o texto da data (sem `Date` local do navegador, cujo fuso não é o da empresa).
import { utcIsoToZonedLocal, zonedLocalToUtcIso } from "./time";

export type AgendaView = "day" | "week";

/** Limite do servidor para uma listagem (`listMaxSpanDays`); a agenda nunca pede mais que 8 dias. */
export const LIST_MAX_SPAN_DAYS = 93;
/** Limite de sanidade do servidor para a data de um agendamento (`maxDaysAhead`). */
export const MAX_DAYS_AHEAD = 730;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return (
    check.getUTCFullYear() === y &&
    check.getUTCMonth() === mo - 1 &&
    check.getUTCDate() === d
  );
}

export function addDays(date: string, days: number): string {
  const m = DATE.exec(date) as RegExpExecArray;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 0 = domingo ... 6 = sábado (igual ao `weekday` do expediente). */
export function weekdayOf(date: string): number {
  const m = DATE.exec(date) as RegExpExecArray;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay();
}

/** A semana da agenda começa na segunda-feira. */
export function weekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function visibleDays(view: AgendaView, date: string): string[] {
  if (view === "day") return [date];
  const start = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Dia local da empresa em que o instante cai. */
export function localDateOf(iso: string, tz: string): string {
  return utcIsoToZonedLocal(iso, tz).slice(0, 10);
}

/** "HH:mm" local da empresa. */
export function localTimeOf(iso: string, tz: string): string {
  return utcIsoToZonedLocal(iso, tz).slice(11, 16);
}

export function todayIn(tz: string, now: number = Date.now()): string {
  return localDateOf(new Date(now).toISOString(), tz);
}

/** Início do dia local em UTC. Se a meia-noite não existe (horário de verão), usa o primeiro horário existente. */
export function startOfDayUtc(date: string, tz: string): string {
  for (const hour of ["00", "01", "02"]) {
    const iso = zonedLocalToUtcIso(`${date}T${hour}:00`, tz);
    if (iso) return iso;
  }
  return new Date(`${date}T00:00:00Z`).toISOString();
}

/** Intervalo `[from, to)` em UTC que cobre os dias exibidos, para `GET /api/appointments`. */
export function rangeUtc(
  view: AgendaView,
  date: string,
  tz: string,
): { from: string; to: string } {
  const days = visibleDays(view, date);
  return {
    from: startOfDayUtc(days[0] as string, tz),
    to: startOfDayUtc(addDays(days[days.length - 1] as string, 1), tz),
  };
}

const LONG = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC",
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
/** "terça-feira, 04/03/2031" a partir de "2031-03-04" (data de calendário pura: formatada em UTC de propósito). */
export function formatLocalDate(date: string): string {
  return LONG.format(new Date(`${date}T00:00:00Z`));
}

export function formatDayHeading(date: string): string {
  return formatLocalDate(date).replaceAll(",", "");
}
