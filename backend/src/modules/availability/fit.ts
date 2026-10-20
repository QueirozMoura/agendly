// "Cabe no expediente?" (6.2 item 3) para um intervalo já existente [startsAt, endsAt): usado pela criação/remarcação
// de agendamentos e pela rejeição de alterações de WorkingHours que deixariam agendamentos ativos de fora (R4).
// Mesma convenção de `computeSlots`: o intervalo precisa caber INTEIRO num único intervalo do dia local de `startsAt`.
import {
  localMinuteToUtc,
  localWeekday,
  utcToZonedLocal,
} from "../../lib/time/zone.ts";
import type { WorkingInterval } from "./slots.ts";

export function fitsWorkingHours(
  range: { startsAt: Date; endsAt: Date },
  timeZone: string,
  hours: readonly WorkingInterval[],
): boolean {
  const date = utcToZonedLocal(range.startsAt, timeZone).slice(0, 10);
  const weekday = localWeekday(date);
  const start = range.startsAt.getTime();
  const end = range.endsAt.getTime();
  return hours.some((h) => {
    if (h.weekday !== weekday) return false;
    const open = localMinuteToUtc(date, h.startMinute, timeZone).getTime();
    const close = localMinuteToUtc(date, h.endMinute, timeZone).getTime();
    return start >= open && end <= close;
  });
}
