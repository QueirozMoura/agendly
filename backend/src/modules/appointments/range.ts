// computeAppointmentRange (6.1, V8 opção 1): ÚNICA função que calcula a faixa de um agendamento. Criar, remarcar e
// reativar a usam; o banco (CHECK `appointments_range_coherent`) rejeita qualquer valor que não bata com ela.
const MS_PER_MINUTE = 60_000;

export interface AppointmentRange {
  startsAt: Date;
  /** `starts_at + duração`: usada por relatórios e por TimeOff/WorkingHours (R3). */
  endsAt: Date;
  /** `ends_at + buffer`: usada pela exclusão e pela disponibilidade entre agendamentos. */
  blockedUntil: Date;
}

export function computeAppointmentRange(
  startsAt: Date,
  durationMinutes: number,
  bufferMinutes: number,
): AppointmentRange {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1)
    throw new RangeError("durationMinutes deve ser um inteiro >= 1");
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0)
    throw new RangeError("bufferMinutes deve ser um inteiro >= 0");
  const endsAt = new Date(startsAt.getTime() + durationMinutes * MS_PER_MINUTE);
  return {
    startsAt: new Date(startsAt),
    endsAt,
    blockedUntil: new Date(endsAt.getTime() + bufferMinutes * MS_PER_MINUTE),
  };
}
