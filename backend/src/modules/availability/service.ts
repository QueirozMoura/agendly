// WorkingHours e TimeOff (6.5): "N2 profissional → N4". Toda escrita trava o profissional DONO da linha (ordem fixa,
// uma só neste módulo), confere regras sob a trava e só então escreve. As linhas-filha chegam por id; como o
// profissional dono só é conhecido lendo a linha, a leitura inicial é SEM lock e a linha é relida sob a trava
// (padrão "leitura sem lock → N2 → N4 relê" de 6.5). Nenhuma verificação contra agendamentos: eles ainda não existem
// (entra na Etapa 10).
import type { PrismaClient, TxClient } from "../../lib/db/client.ts";
import {
  enterLeafWrite,
  lockProfessionals,
  runLocked,
} from "../../lib/db/locks/index.ts";
import { forTenant } from "../../lib/db/tenant.ts";
import { AppError } from "../../lib/errors.ts";
import { ACTIVE_STATUSES } from "../appointments/transitions.ts";
import { APPOINTMENT_LIMITS } from "../appointments/schemas.ts";
import { localMinuteToUtc } from "../../lib/time/zone.ts";
import { fitsWorkingHours } from "./fit.ts";
import { AVAILABILITY_LIMITS, timeOffRangeIssue } from "./schemas.ts";
import { computeSlots, type WorkingInterval } from "./slots.ts";

export interface AvailabilityScope {
  organizationId: string;
  /** Fuso da empresa ativa (imutável), do contexto validado da sessão: converte o expediente local em instantes. */
  timezone: string;
  /** Relógio injetável: só agendamentos ATIVOS e AINDA NÃO TERMINADOS (`ends_at > now`) conflitam (R4). */
  now: () => Date;
}

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

const invalid = (path: string, message: string) =>
  new AppError("VALIDATION_ERROR", 400, "Dados inválidos.", [
    { path, message },
  ]);

type Db = ReturnType<typeof forTenant>;
const asTx = (tx: unknown) => tx as TxClient;

/** Agendamento afetado por uma alteração de folga/expediente (R4): vai na lista do 409, nada é cancelado. */
export interface ConflictingAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  customer: { id: string; name: string };
  serviceName: string;
}

type Row = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  customerId: string;
  serviceNameSnapshot: string;
};

async function describeConflicts(
  tx: Pick<Db, "customer">,
  rows: Row[],
): Promise<ConflictingAppointment[]> {
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await tx.customer.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name] as const),
  );
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    customer: { id: r.customerId, name: names.get(r.customerId) ?? "" },
    serviceName: r.serviceNameSnapshot,
  }));
}

const CONFLICT_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  customerId: true,
  serviceNameSnapshot: true,
} as const;

/**
 * Relatório de conflitos (R4): `conflicts` traz os primeiros `CONFLICT_LIST_LIMIT` por início, `totalCount` é o total REAL
 * de agendamentos afetados e `truncated` diz se a lista é parcial. Uma lista parcial nunca se apresenta como completa.
 * Não há paginação: resolver os da lista (cancelar/remarcar) e repetir a alteração revela os restantes.
 */
export interface ConflictReport {
  conflicts: ConflictingAppointment[];
  totalCount: number;
  truncated: boolean;
}

const report = (
  conflicts: ConflictingAppointment[],
  totalCount: number,
): ConflictReport => ({
  conflicts,
  totalCount,
  truncated: totalCount > conflicts.length,
});

/**
 * R4, TimeOff: agendamentos ATIVOS, não terminados, cuja faixa de ATENDIMENTO `[starts_at, ends_at)` (nunca
 * `blocked_until`, R3) intersecta a folga. Lidos sem lock: consistentes porque todo escritor de agendamento ativo trava N2.
 */
async function timeOffConflicts(
  tx: Pick<Db, "appointment" | "customer">,
  scope: AvailabilityScope,
  professionalId: string,
  range: { startsAt: Date; endsAt: Date },
): Promise<ConflictReport> {
  const now = scope.now();
  const where = {
    professionalId,
    status: { in: [...ACTIVE_STATUSES] },
    startsAt: { lt: range.endsAt },
    endsAt: { gt: range.startsAt > now ? range.startsAt : now },
  };
  // O total sai de um COUNT no banco (índice parcial dos ativos); só o limite explícito de linhas é carregado.
  const totalCount = await tx.appointment.count({ where });
  const rows = await tx.appointment.findMany({
    where,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: AVAILABILITY_LIMITS.conflictListMax,
    select: CONFLICT_SELECT,
  });
  return report(await describeConflicts(tx, rows), totalCount);
}

/**
 * R4, WorkingHours: agendamentos ativos e não terminados que CABEM no expediente atual e deixariam de caber no novo.
 * (Um agendamento que já não cabia antes não é culpa desta alteração e não a bloqueia.)
 */
async function workingHoursConflicts(
  tx: Pick<Db, "appointment" | "customer">,
  scope: AvailabilityScope,
  professionalId: string,
  before: readonly WorkingInterval[],
  after: readonly WorkingInterval[],
): Promise<ConflictReport> {
  // O teste "cabia antes e não cabe depois" depende do fuso e dos intervalos e não vira SQL: carrega só os campos mínimos
  // dos agendamentos ativos e futuros DESTE profissional (limitados na prática pela agenda dele) e filtra na aplicação.
  const rows = await tx.appointment.findMany({
    where: {
      professionalId,
      status: { in: [...ACTIVE_STATUSES] },
      endsAt: { gt: scope.now() },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: CONFLICT_SELECT,
  });
  const broken = rows.filter(
    (r) =>
      fitsWorkingHours(r, scope.timezone, before) &&
      !fitsWorkingHours(r, scope.timezone, after),
  );
  return report(
    await describeConflicts(
      tx,
      broken.slice(0, AVAILABILITY_LIMITS.conflictListMax),
    ),
    broken.length,
  );
}

const HOURS_SELECT = {
  id: true,
  weekday: true,
  startMinute: true,
  endMinute: true,
} as const;

function rejectConflicts(
  code: string,
  message: string,
  conflicts: ConflictReport,
): never {
  throw new AppError(code, 409, message, conflicts);
}

// ───────────────────────────── WorkingHours ─────────────────────────────

export interface WorkingHoursView {
  id: string;
  professionalId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  createdAt: Date;
  updatedAt: Date;
}

const WH_SELECT = {
  id: true,
  professionalId: true,
  weekday: true,
  startMinute: true,
  endMinute: true,
  createdAt: true,
  updatedAt: true,
} as const;

type WhRow = {
  id: string;
  professionalId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  createdAt: Date;
  updatedAt: Date;
};

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const whView = (r: WhRow): WorkingHoursView => ({
  id: r.id,
  professionalId: r.professionalId,
  weekday: r.weekday,
  startTime: hhmm(r.startMinute),
  endTime: hhmm(r.endMinute),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const whConflict = () =>
  new AppError(
    "WORKING_HOURS_OVERLAP",
    409,
    "O intervalo se sobrepõe a outro do mesmo dia.",
  );

/** Sobreposição de intervalos semiabertos [início, fim): encostar é permitido. */
async function assertNoOverlap(
  db: Pick<Db, "workingHours">,
  professionalId: string,
  weekday: number,
  startMinute: number,
  endMinute: number,
  ignoreId?: string,
): Promise<void> {
  const clash = await db.workingHours.findFirst({
    where: {
      professionalId,
      weekday,
      startMinute: { lt: endMinute },
      endMinute: { gt: startMinute },
      ...(ignoreId ? { id: { not: ignoreId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw whConflict();
}

async function assertProfessionalExists(
  db: Db,
  professionalId: string,
): Promise<void> {
  const found = await db.professional.findUnique({
    where: { id: professionalId },
    select: { id: true },
  });
  if (!found) throw notFound();
}

export async function listWorkingHours(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  professionalId: string,
): Promise<WorkingHoursView[]> {
  const db = forTenant(prisma, scope.organizationId);
  await assertProfessionalExists(db, professionalId);
  const rows = await db.workingHours.findMany({
    where: { professionalId },
    orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
    select: WH_SELECT,
  });
  return rows.map(whView);
}

export async function createWorkingHours(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  input: {
    professionalId: string;
    weekday: number;
    startTime: number;
    endTime: number;
  },
): Promise<WorkingHoursView> {
  const { professionalId } = input;
  const row = await runLocked(
    forTenant(prisma, scope.organizationId),
    async (tx) => {
      if (
        !(await lockProfessionals(asTx(tx), scope.organizationId, [
          professionalId,
        ]))
      )
        throw notFound();
      await assertNoOverlap(
        tx,
        professionalId,
        input.weekday,
        input.startTime,
        input.endTime,
      );
      enterLeafWrite(tx, professionalId);
      return tx.workingHours.create({
        data: {
          organizationId: scope.organizationId,
          professionalId,
          weekday: input.weekday,
          startMinute: input.startTime,
          endMinute: input.endTime,
        },
        select: WH_SELECT,
      });
    },
  );
  return whView(row);
}

/** Dono da linha, lido SEM lock (a linha é relida sob a trava do profissional). */
async function workingHoursOwner(db: Db, id: string): Promise<string> {
  const row = await db.workingHours.findUnique({
    where: { id },
    select: { professionalId: true },
  });
  if (!row) throw notFound();
  return row.professionalId;
}

export async function updateWorkingHours(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  id: string,
  patch: {
    weekday?: number | undefined;
    startTime?: number | undefined;
    endTime?: number | undefined;
  },
): Promise<WorkingHoursView> {
  const db = forTenant(prisma, scope.organizationId);
  const professionalId = await workingHoursOwner(db, id);
  const row = await runLocked(db, async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), scope.organizationId, [
        professionalId,
      ]))
    )
      throw notFound();
    const current = await tx.workingHours.findUnique({
      where: { id },
      select: WH_SELECT,
    });
    if (!current || current.professionalId !== professionalId) throw notFound(); // removido (ou movido) entre a leitura e a trava
    const next = {
      weekday: patch.weekday ?? current.weekday,
      startMinute: patch.startTime ?? current.startMinute,
      endMinute: patch.endTime ?? current.endMinute,
    };
    if (next.startMinute >= next.endMinute)
      throw invalid("endTime", "O início deve ser anterior ao fim.");
    await assertNoOverlap(
      tx,
      professionalId,
      next.weekday,
      next.startMinute,
      next.endMinute,
      id,
    );
    const before = await tx.workingHours.findMany({
      where: { professionalId },
      select: HOURS_SELECT,
    });
    const after = before.map((h) => (h.id === id ? { ...h, ...next } : h));
    const conflicts = await workingHoursConflicts(
      tx,
      scope,
      professionalId,
      before,
      after,
    );
    if (conflicts.totalCount > 0)
      rejectConflicts(
        "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
        "A alteração deixaria agendamentos ativos fora do expediente.",
        conflicts,
      );
    enterLeafWrite(tx, professionalId);
    return tx.workingHours.update({
      where: { id },
      data: next,
      select: WH_SELECT,
    });
  });
  return whView(row);
}

export async function deleteWorkingHours(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  id: string,
): Promise<void> {
  const db = forTenant(prisma, scope.organizationId);
  const professionalId = await workingHoursOwner(db, id);
  await runLocked(db, async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), scope.organizationId, [
        professionalId,
      ]))
    )
      throw notFound();
    const before = await tx.workingHours.findMany({
      where: { professionalId },
      select: HOURS_SELECT,
    });
    const conflicts = await workingHoursConflicts(
      tx,
      scope,
      professionalId,
      before,
      before.filter((h) => h.id !== id),
    );
    if (conflicts.totalCount > 0)
      rejectConflicts(
        "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
        "A remoção deixaria agendamentos ativos fora do expediente.",
        conflicts,
      );
    enterLeafWrite(tx, professionalId);
    const { count } = await tx.workingHours.deleteMany({
      where: { id, professionalId },
    });
    if (count !== 1) throw notFound(); // removido por outra requisição entre a leitura e a trava
  });
}

// ─────────────────────────────── TimeOff ───────────────────────────────

export interface TimeOffView {
  id: string;
  professionalId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const TO_SELECT = {
  id: true,
  professionalId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listTimeOff(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  professionalId: string,
): Promise<TimeOffView[]> {
  const db = forTenant(prisma, scope.organizationId);
  await assertProfessionalExists(db, professionalId);
  return db.timeOff.findMany({
    where: { professionalId },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: TO_SELECT,
  });
}

export async function createTimeOff(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  input: {
    professionalId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
  },
): Promise<TimeOffView> {
  const issue = timeOffRangeIssue(input.startsAt, input.endsAt);
  if (issue) throw invalid("endsAt", issue);
  const { professionalId } = input;
  return runLocked(forTenant(prisma, scope.organizationId), async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), scope.organizationId, [
        professionalId,
      ]))
    )
      throw notFound();
    const total = await tx.timeOff.count({ where: { professionalId } });
    if (total >= AVAILABILITY_LIMITS.timeOffMaxPerProfessional)
      throw new AppError(
        "TIME_OFF_LIMIT_REACHED",
        422,
        "Limite de folgas do profissional atingido.",
      );
    const conflicts = await timeOffConflicts(tx, scope, professionalId, input);
    if (conflicts.totalCount > 0)
      rejectConflicts(
        "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
        "A folga conflita com agendamentos ativos.",
        conflicts,
      );
    enterLeafWrite(tx, professionalId);
    return tx.timeOff.create({
      data: {
        organizationId: scope.organizationId,
        professionalId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
      },
      select: TO_SELECT,
    });
  });
}

async function timeOffOwner(db: Db, id: string): Promise<string> {
  const row = await db.timeOff.findUnique({
    where: { id },
    select: { professionalId: true },
  });
  if (!row) throw notFound();
  return row.professionalId;
}

export async function updateTimeOff(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  id: string,
  patch: {
    startsAt?: Date | undefined;
    endsAt?: Date | undefined;
    reason?: string | null | undefined;
  },
): Promise<TimeOffView> {
  const db = forTenant(prisma, scope.organizationId);
  const professionalId = await timeOffOwner(db, id);
  return runLocked(db, async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), scope.organizationId, [
        professionalId,
      ]))
    )
      throw notFound();
    const current = await tx.timeOff.findUnique({
      where: { id },
      select: TO_SELECT,
    });
    if (!current || current.professionalId !== professionalId) throw notFound();
    const startsAt = patch.startsAt ?? current.startsAt;
    const endsAt = patch.endsAt ?? current.endsAt;
    const issue = timeOffRangeIssue(startsAt, endsAt);
    if (issue) throw invalid("endsAt", issue);
    const conflicts = await timeOffConflicts(tx, scope, professionalId, {
      startsAt,
      endsAt,
    });
    if (conflicts.totalCount > 0)
      rejectConflicts(
        "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
        "A folga conflita com agendamentos ativos.",
        conflicts,
      );
    enterLeafWrite(tx, professionalId);
    return tx.timeOff.update({
      where: { id },
      data: {
        startsAt,
        endsAt,
        ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      },
      select: TO_SELECT,
    });
  });
}

export async function deleteTimeOff(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  id: string,
): Promise<void> {
  const db = forTenant(prisma, scope.organizationId);
  const professionalId = await timeOffOwner(db, id);
  await runLocked(db, async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), scope.organizationId, [
        professionalId,
      ]))
    )
      throw notFound();
    enterLeafWrite(tx, professionalId);
    const { count } = await tx.timeOff.deleteMany({
      where: { id, professionalId },
    });
    if (count !== 1) throw notFound();
  });
}

// ───────────────────────────── Slots (leitura) ─────────────────────────────

/**
 * Inícios disponíveis do profissional para o serviço no dia local `date` (6.2). Leitura SEM lock (R-e): é sugestão para
 * a UI, e um horário livre aqui pode dar 409 ao confirmar. Profissional ou serviço inativos, ou sem vínculo, não têm
 * slots. O painel não aplica antecedência mínima nem o limite por telefone (6.7), só "futuro" e o teto de sanidade.
 */
export async function listAvailableSlots(
  prisma: PrismaClient,
  scope: AvailabilityScope,
  q: { professionalId: string; serviceId: string; date: string },
): Promise<Date[]> {
  const db = forTenant(prisma, scope.organizationId);
  const professional = await db.professional.findUnique({
    where: { id: q.professionalId },
    select: { active: true },
  });
  const service = await db.service.findUnique({
    where: { id: q.serviceId },
    select: { active: true, durationMinutes: true, bufferMinutes: true },
  });
  if (!professional || !service) throw notFound();
  if (!professional.active || !service.active) return [];
  const link = await db.professionalService.findUnique({
    where: {
      professionalId_serviceId: {
        professionalId: q.professionalId,
        serviceId: q.serviceId,
      },
    },
    select: { serviceId: true },
  });
  if (!link) return [];

  const dayStart = localMinuteToUtc(q.date, 0, scope.timezone).getTime();
  const dayEnd = localMinuteToUtc(q.date, 1440, scope.timezone).getTime();
  const from = new Date(dayStart - 86_400_000);
  const to = new Date(dayEnd + 86_400_000);
  const [workingHours, timeOff, appointments] = await Promise.all([
    db.workingHours.findMany({
      where: { professionalId: q.professionalId },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    db.timeOff.findMany({
      where: {
        professionalId: q.professionalId,
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      select: { startsAt: true, endsAt: true },
    }),
    db.appointment.findMany({
      where: {
        professionalId: q.professionalId,
        status: { in: [...ACTIVE_STATUSES] },
        startsAt: { lt: to },
        blockedUntil: { gt: from },
      },
      select: { startsAt: true, blockedUntil: true },
    }),
  ]);
  return computeSlots(
    {
      timeZone: scope.timezone,
      date: q.date,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      workingHours,
      timeOff,
      appointments,
      maxAdvanceDays: APPOINTMENT_LIMITS.maxDaysAhead,
    },
    { now: scope.now },
  );
}
