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
import { AVAILABILITY_LIMITS, timeOffRangeIssue } from "./schemas.ts";

export interface AvailabilityScope {
  organizationId: string;
}

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

const invalid = (path: string, message: string) =>
  new AppError("VALIDATION_ERROR", 400, "Dados inválidos.", [
    { path, message },
  ]);

type Db = ReturnType<typeof forTenant>;
const asTx = (tx: unknown) => tx as TxClient;

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
