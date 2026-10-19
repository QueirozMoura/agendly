// computeSlots (6.2): função PURA que calcula os inícios de atendimento possíveis de um profissional num dia local.
// Sem banco, sem relógio global (o `Clock` é injetado) e sem date-fns-tz (as conversões de fuso ficam em lib/time).
//
// Não verifica o item 1 de 6.2 (profissional e serviço ativos e vinculados): isso é decidido por quem monta as
// entradas. Os itens 2–5 são avaliados aqui; os agendamentos recebidos devem ser apenas os ATIVOS do profissional.
import type { Clock } from "../../lib/time/clock.ts";
import {
  isValidLocalDate,
  localMinuteToUtc,
  localWeekday,
} from "../../lib/time/zone.ts";

/** Grade de início de atendimento (D5): múltiplos de 15 minutos no horário local. */
export const SLOT_GRID_MINUTES = 15;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export interface WorkingInterval {
  /** 0 = domingo ... 6 = sábado. */
  weekday: number;
  /** Minutos desde 00:00 local; `endMinute` até 1440. */
  startMinute: number;
  endMinute: number;
}

export interface SlotInputs {
  /** Fuso IANA da empresa. */
  timeZone: string;
  /** Dia local "YYYY-MM-DD". */
  date: string;
  durationMinutes: number;
  bufferMinutes: number;
  /** Expediente do profissional (qualquer dia da semana; só o dia de `date` é usado). */
  workingHours: readonly WorkingInterval[];
  timeOff: readonly { startsAt: Date; endsAt: Date }[];
  /** Agendamentos ATIVOS do profissional: ocupam `[startsAt, blockedUntil)` (duração + buffer). */
  appointments: readonly { startsAt: Date; blockedUntil: Date }[];
  /** Antecedência mínima (6.7); 0 = apenas "futuro". */
  minNoticeMinutes?: number;
  /** Antecedência máxima em dias (6.7); ausente = sem limite. */
  maxAdvanceDays?: number;
}

const intersects = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
) => aStart < bEnd && bStart < aEnd;

/** Inícios válidos (UTC) para o serviço no dia local `date`, em ordem crescente e sem repetições. */
export function computeSlots(input: SlotInputs, clock: Clock): Date[] {
  const {
    timeZone,
    date,
    durationMinutes,
    bufferMinutes,
    minNoticeMinutes = 0,
  } = input;
  if (!isValidLocalDate(date))
    throw new RangeError(`Dia local inválido: ${date}`);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1)
    throw new RangeError("durationMinutes deve ser um inteiro >= 1");
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0)
    throw new RangeError("bufferMinutes deve ser um inteiro >= 0");
  if (!Number.isFinite(minNoticeMinutes) || minNoticeMinutes < 0)
    throw new RangeError("minNoticeMinutes deve ser >= 0");

  const now = clock.now().getTime();
  // R7: nunca no passado nem "agora"; a antecedência mínima só aperta essa fronteira.
  const earliest = Math.max(now + 1, now + minNoticeMinutes * MS_PER_MINUTE);
  const latest =
    input.maxAdvanceDays === undefined
      ? Number.POSITIVE_INFINITY
      : now + input.maxAdvanceDays * MS_PER_DAY;

  const durationMs = durationMinutes * MS_PER_MINUTE;
  const blockedMs = (durationMinutes + bufferMinutes) * MS_PER_MINUTE;
  const stepMs = SLOT_GRID_MINUTES * MS_PER_MINUTE;
  const weekday = localWeekday(date);

  const { timeOff: timeOffInput, appointments } = input;
  const timeOff = timeOffInput.map(
    (o) => [o.startsAt.getTime(), o.endsAt.getTime()] as const,
  );
  const busy = appointments.map(
    (a) => [a.startsAt.getTime(), a.blockedUntil.getTime()] as const,
  );

  const starts = new Set<number>();
  for (const interval of input.workingHours) {
    if (interval.weekday !== weekday) continue;
    // Os limites do expediente são convertidos para instantes: numa troca de horário de verão o expediente local
    // tem duração real diferente, e a grade de 15 min (em UTC a partir do início) continua alinhada ao relógio local.
    const open = localMinuteToUtc(
      date,
      interval.startMinute,
      timeZone,
    ).getTime();
    const close = localMinuteToUtc(
      date,
      interval.endMinute,
      timeZone,
    ).getTime();
    // 3: [t, t+d) cabe inteiro no intervalo (o buffer pode ultrapassar o fim do expediente: R3).
    for (let t = open; t + durationMs <= close; t += stepMs) {
      if (t < earliest || t > latest) continue; // 2
      const end = t + durationMs;
      if (timeOff.some(([a, b]) => intersects(t, end, a, b))) continue; // 4
      const blockedEnd = t + blockedMs;
      if (busy.some(([a, b]) => intersects(t, blockedEnd, a, b))) continue; // 5
      starts.add(t);
    }
  }
  return [...starts].sort((a, b) => a - b).map((ms) => new Date(ms));
}
