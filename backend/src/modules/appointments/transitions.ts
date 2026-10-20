// Transições de status (5): função ÚNICA e testada. Cancelar nunca faz DELETE. Ativos (bloqueiam horário): SCHEDULED e
// CONFIRMED. COMPLETED e NO_SHOW são terminais (decisão da Etapa 10, sujeita a aprovação). Reativar só sai de CANCELLED.
export const APPOINTMENT_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type AppointmentStatusName = (typeof APPOINTMENT_STATUSES)[number];

export const ACTIVE_STATUSES: readonly AppointmentStatusName[] = [
  "SCHEDULED",
  "CONFIRMED",
];

export type StatusAction =
  "confirm" | "complete" | "no_show" | "cancel" | "reactivate";

const TRANSITIONS: Record<
  StatusAction,
  { from: readonly AppointmentStatusName[]; to: AppointmentStatusName }
> = {
  confirm: { from: ["SCHEDULED"], to: "CONFIRMED" },
  complete: { from: ["SCHEDULED", "CONFIRMED"], to: "COMPLETED" },
  no_show: { from: ["SCHEDULED", "CONFIRMED"], to: "NO_SHOW" },
  cancel: { from: ["SCHEDULED", "CONFIRMED"], to: "CANCELLED" },
  reactivate: { from: ["CANCELLED"], to: "SCHEDULED" },
};

/** Status resultante da ação, ou `undefined` se a transição é inválida a partir de `from`. */
export function nextStatus(
  from: AppointmentStatusName,
  action: StatusAction,
): AppointmentStatusName | undefined {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : undefined;
}

export const isActive = (status: AppointmentStatusName): boolean =>
  ACTIVE_STATUSES.includes(status);

export function allowedFrom(
  action: StatusAction,
): readonly AppointmentStatusName[] {
  return TRANSITIONS[action].from;
}

/**
 * Concluir e marcar não comparecimento só depois do FIM do atendimento (`ends_at <= now`, decisão da Etapa 10 a aprovar):
 * são terminais e LIBERAM a faixa na exclusão, então permiti-los antes do fim liberaria, de forma irreversível, um horário
 * futuro ou em andamento para outro agendamento. Cancelar e confirmar não têm essa restrição.
 */
export const requiresFinished = (action: StatusAction): boolean =>
  action === "complete" || action === "no_show";
