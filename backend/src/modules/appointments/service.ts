// Agendamentos do painel (Etapa 10). Hierarquia de locks de 6.5, nesta ordem e sempre via lib/db/locks:
//   N1 cliente → N2 profissional(is) (ordenados) → N3 idempotência → N4 escrita (linha do agendamento).
// Criar:        N1 → N2 → N3 → N4 (INSERT).
// Remarcar/reativar: leitura sem lock → N2 {origem, destino} → N4 (relê com lock e confere profissional e `version`).
// Cancelar/confirmar/concluir/não compareceu: somente N4, por `version` (não ocupam horário, não travam o profissional).
// A exclusão `appointments_no_overlap` do banco é a última linha de defesa: 23P01 vira 409 SLOT_UNAVAILABLE. Nada aqui
// depende de uma checagem prévia de sobreposição na aplicação.
import type { PrismaClient, TxClient } from "../../lib/db/client.ts";
import { classifyDbError } from "../../lib/db/errors.ts";
import {
  claimIdempotencyKey,
  ensureAndLockCustomerByPhone,
  enterLeafWrite,
  lockAppointment,
  lockCustomerById,
  lockProfessionals,
  runLocked,
} from "../../lib/db/locks/index.ts";
import { forTenant } from "../../lib/db/tenant.ts";
import { AppError } from "../../lib/errors.ts";
import type { Clock } from "../../lib/time/clock.ts";
import { utcToZonedLocal } from "../../lib/time/zone.ts";
import { fitsWorkingHours } from "../availability/fit.ts";
import { APPOINTMENT_LIMITS } from "./schemas.ts";
import { requestHash } from "./idempotency.ts";
import { computeAppointmentRange } from "./range.ts";
import {
  isActive,
  nextStatus,
  requiresFinished,
  type AppointmentStatusName,
  type StatusAction,
} from "./transitions.ts";
import {
  APPOINTMENT_SELECT,
  toView,
  type AppointmentRow,
  type AppointmentView,
} from "./view.ts";

export interface AppointmentDeps {
  prisma: PrismaClient;
  clock: Clock;
}

export interface AppointmentScope {
  organizationId: string;
  userId: string;
  /** Fuso da empresa ativa (imutável), vindo do contexto validado da sessão. */
  timezone: string;
}

export const IDEMPOTENCY_SCOPE = "appointments.create";
export const CREATE_ROUTE = "/api/appointments";
const MS_PER_DAY = 86_400_000;

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
const invalid = (path: string, message: string) =>
  new AppError("VALIDATION_ERROR", 400, "Dados inválidos.", [
    { path, message },
  ]);
const slotUnavailable = () =>
  new AppError(
    "SLOT_UNAVAILABLE",
    409,
    "Este horário não está mais disponível.",
  );
const professionalUnavailable = () =>
  new AppError(
    "PROFESSIONAL_UNAVAILABLE",
    409,
    "O profissional não está disponível neste horário.",
  );
const serviceNotAvailable = () =>
  new AppError(
    "SERVICE_NOT_AVAILABLE",
    422,
    "O serviço não está disponível para este profissional.",
  );
const staleVersion = () =>
  new AppError(
    "STALE_VERSION",
    409,
    "O agendamento foi alterado. Recarregue e tente novamente.",
  );
const invalidTransition = () =>
  new AppError(
    "INVALID_STATUS_TRANSITION",
    409,
    "Esta ação não é permitida para o status atual do agendamento.",
  );

type Db = ReturnType<typeof forTenant>;
const asTx = (tx: unknown) => tx as TxClient;

/** Início em múltiplos de 15 minutos do relógio local da empresa, sem segundos (D5). */
function assertGrid(startsAt: Date, timeZone: string): void {
  const local = utcToZonedLocal(startsAt, timeZone); // yyyy-MM-ddTHH:mm:ss
  const minute = Number(local.slice(14, 16));
  const second = local.slice(17, 19);
  if (
    startsAt.getUTCMilliseconds() !== 0 ||
    second !== "00" ||
    minute % 15 !== 0
  )
    throw invalid("startsAt", "O horário deve ser múltiplo de 15 minutos.");
}

/**
 * Regras de horário SOB A TRAVA N2 do profissional (6.5, passo 2): futuro (R7, `Clock` injetado), limite de sanidade,
 * `[start, end)` dentro do expediente e fora de folgas. O buffer não entra aqui (R3). Todo escritor de WorkingHours,
 * TimeOff e agendamentos trava o mesmo profissional, então estas leituras sem lock são consistentes.
 */
async function assertBookable(
  tx: Pick<Db, "workingHours" | "timeOff">,
  p: {
    now: Date;
    timeZone: string;
    startsAt: Date;
    endsAt: Date;
    professionalId: string;
  },
): Promise<void> {
  if (p.startsAt.getTime() <= p.now.getTime())
    throw new AppError(
      "STARTS_AT_IN_PAST",
      422,
      "Não é possível agendar no passado.",
    );
  if (
    p.startsAt.getTime() >
    p.now.getTime() + APPOINTMENT_LIMITS.maxDaysAhead * MS_PER_DAY
  )
    throw new AppError(
      "STARTS_AT_TOO_FAR",
      422,
      "A data está distante demais.",
    );
  const hours = await tx.workingHours.findMany({
    where: { professionalId: p.professionalId },
    select: { weekday: true, startMinute: true, endMinute: true },
  });
  if (!fitsWorkingHours(p, p.timeZone, hours)) throw professionalUnavailable();
  const off = await tx.timeOff.findFirst({
    where: {
      professionalId: p.professionalId,
      startsAt: { lt: p.endsAt },
      endsAt: { gt: p.startsAt },
    },
    select: { id: true },
  });
  if (off) throw professionalUnavailable();
}

function mapExclusion(err: unknown): never {
  if (classifyDbError(err) === "exclusion_violation") throw slotUnavailable();
  throw err;
}

async function customerNames(
  db: Pick<Db, "customer">,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.customer.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function viewOf(
  db: Pick<Db, "customer">,
  row: AppointmentRow,
): Promise<AppointmentView> {
  const names = await customerNames(db, [row.customerId]);
  return toView(row, names.get(row.customerId) ?? "");
}

export interface CreateAppointmentInput {
  professionalId: string;
  serviceId: string;
  startsAt: Date;
  customerId?: string | undefined;
  customer?:
    | {
        name: string;
        phone: string;
        email: string | null;
        notes: string | null;
      }
    | undefined;
}

export interface CreateResult {
  status: number;
  body: unknown;
  replay: boolean;
}

export async function createAppointment(
  deps: AppointmentDeps,
  scope: AppointmentScope,
  input: CreateAppointmentInput,
  idempotencyKey: string,
): Promise<CreateResult> {
  const { organizationId } = scope;
  assertGrid(input.startsAt, scope.timezone);
  const hash = requestHash({
    method: "POST",
    route: CREATE_ROUTE,
    body: {
      professionalId: input.professionalId,
      serviceId: input.serviceId,
      startsAt: input.startsAt,
      customerId: input.customerId ?? null,
      customer: input.customer ?? null,
    },
  });

  return runLocked(forTenant(deps.prisma, organizationId), async (tx) => {
    // N1 — cliente (no máximo um por transação)
    let customerId: string;
    if (input.customerId !== undefined) {
      if (!(await lockCustomerById(asTx(tx), organizationId, input.customerId)))
        throw notFound();
      customerId = input.customerId;
    } else {
      const c = input.customer as NonNullable<typeof input.customer>;
      customerId = await ensureAndLockCustomerByPhone(
        asTx(tx),
        organizationId,
        {
          name: c.name,
          phoneE164: c.phone,
          email: c.email,
          notes: c.notes,
        },
      );
    }
    // N2 — profissional
    if (
      !(await lockProfessionals(asTx(tx), organizationId, [
        input.professionalId,
      ]))
    )
      throw notFound();
    // N3 — idempotência (6.4): só sucessos são registrados; o registro nasce no mesmo commit do agendamento
    const claim = await claimIdempotencyKey(
      asTx(tx),
      organizationId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      hash,
    );
    if (claim.kind === "existing") {
      if (claim.requestHash !== hash || claim.responseStatus === null)
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          409,
          "Esta chave de idempotência já foi usada em outro pedido.",
        );
      return {
        status: claim.responseStatus,
        body: claim.responseBody,
        replay: true,
      };
    }

    const service = await tx.service.findUnique({
      where: { id: input.serviceId },
      select: {
        id: true,
        name: true,
        active: true,
        durationMinutes: true,
        bufferMinutes: true,
        priceCents: true,
      },
    });
    if (!service) throw notFound();
    const professional = await tx.professional.findUnique({
      where: { id: input.professionalId },
      select: { active: true },
    });
    if (!professional) throw notFound();
    if (!professional.active) throw professionalUnavailable();
    const link = await tx.professionalService.findUnique({
      where: {
        professionalId_serviceId: {
          professionalId: input.professionalId,
          serviceId: input.serviceId,
        },
      },
      select: { serviceId: true },
    });
    if (!service.active || !link) throw serviceNotAvailable();

    const range = computeAppointmentRange(
      input.startsAt,
      service.durationMinutes,
      service.bufferMinutes,
    );
    await assertBookable(tx, {
      now: deps.clock.now(),
      timeZone: scope.timezone,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      professionalId: input.professionalId,
    });

    // N4 — escrita
    enterLeafWrite(tx, input.professionalId);
    let row: AppointmentRow;
    try {
      row = (await tx.appointment.create({
        data: {
          organizationId,
          professionalId: input.professionalId,
          serviceId: input.serviceId,
          customerId,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          blockedUntil: range.blockedUntil,
          status: "SCHEDULED",
          serviceNameSnapshot: service.name,
          durationMinutesSnapshot: service.durationMinutes,
          bufferMinutesSnapshot: service.bufferMinutes,
          priceCentsSnapshot: service.priceCents,
          source: "PANEL",
          createdByUserId: scope.userId,
        },
        select: APPOINTMENT_SELECT,
      })) as AppointmentRow;
    } catch (err) {
      mapExclusion(err);
    }
    const body = JSON.parse(
      JSON.stringify({ appointment: await viewOf(tx, row) }),
    ) as object;
    await tx.idempotencyRecord.updateMany({
      where: { scope: IDEMPOTENCY_SCOPE, key: idempotencyKey },
      data: { appointmentId: row.id, responseStatus: 201, responseBody: body },
    });
    return { status: 201, body, replay: false };
  });
}

export async function getAppointment(
  prisma: PrismaClient,
  scope: AppointmentScope,
  id: string,
): Promise<AppointmentView> {
  const db = forTenant(prisma, scope.organizationId);
  const row = await db.appointment.findUnique({
    where: { id },
    select: APPOINTMENT_SELECT,
  });
  if (!row) throw notFound();
  return viewOf(db, row as AppointmentRow);
}

export async function listAppointments(
  prisma: PrismaClient,
  scope: AppointmentScope,
  q: {
    from: Date;
    to: Date;
    professionalId?: string | undefined;
    customerId?: string | undefined;
    status?: AppointmentStatusName | undefined;
  },
): Promise<AppointmentView[]> {
  const db = forTenant(prisma, scope.organizationId);
  const rows = (await db.appointment.findMany({
    where: {
      startsAt: { lt: q.to },
      endsAt: { gt: q.from },
      ...(q.professionalId ? { professionalId: q.professionalId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.status ? { status: q.status } : {}),
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: APPOINTMENT_LIMITS.listMax,
    select: APPOINTMENT_SELECT,
  })) as AppointmentRow[];
  const names = await customerNames(
    db,
    rows.map((r) => r.customerId),
  );
  return rows.map((r) => toView(r, names.get(r.customerId) ?? ""));
}

type MoveRequest =
  | {
      kind: "reschedule";
      startsAt: Date;
      professionalId: string | undefined;
      version: number;
    }
  | { kind: "reactivate"; version: number };

/**
 * Remarcar (mesmo ou outro profissional) e reativar um cancelado: leitura sem lock → N2 {origem, destino} ordenados →
 * N4 (relê com lock e confere profissional e `version`: mudou ⇒ 409 STALE_VERSION). Revalida futuro, expediente, folga
 * e conflito. Mantém os snapshots originais (6.6). Não trava cliente nem idempotência.
 */
async function moveAppointment(
  deps: AppointmentDeps,
  scope: AppointmentScope,
  id: string,
  req: MoveRequest,
): Promise<AppointmentView> {
  const { organizationId } = scope;
  if (req.kind === "reschedule") assertGrid(req.startsAt, scope.timezone);
  const db = forTenant(deps.prisma, organizationId);
  const seen = await db.appointment.findUnique({
    where: { id },
    select: { professionalId: true },
  });
  if (!seen) throw notFound();
  const target =
    (req.kind === "reschedule" ? req.professionalId : undefined) ??
    seen.professionalId;

  return runLocked(db, async (tx) => {
    if (
      !(await lockProfessionals(asTx(tx), organizationId, [
        seen.professionalId,
        target,
      ]))
    )
      throw notFound();
    if (!(await lockAppointment(asTx(tx), organizationId, id)))
      throw notFound();
    const row = (await tx.appointment.findUnique({
      where: { id },
      select: APPOINTMENT_SELECT,
    })) as AppointmentRow | null;
    if (!row) throw notFound();
    if (
      row.professionalId !== seen.professionalId ||
      row.version !== req.version
    )
      throw staleVersion();

    if (
      req.kind === "reschedule"
        ? !isActive(row.status)
        : nextStatus(row.status, "reactivate") === undefined
    )
      throw invalidTransition();

    const professional = await tx.professional.findUnique({
      where: { id: target },
      select: { active: true },
    });
    if (!professional?.active) throw professionalUnavailable();
    const link = await tx.professionalService.findUnique({
      where: {
        professionalId_serviceId: {
          professionalId: target,
          serviceId: row.serviceId,
        },
      },
      select: { serviceId: true },
    });
    if (!link) throw serviceNotAvailable();

    const range = computeAppointmentRange(
      req.kind === "reschedule" ? req.startsAt : row.startsAt,
      row.durationMinutesSnapshot,
      row.bufferMinutesSnapshot,
    );
    await assertBookable(tx, {
      now: deps.clock.now(),
      timeZone: scope.timezone,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      professionalId: target,
    });

    enterLeafWrite(tx, target);
    let updated: AppointmentRow;
    try {
      updated = (await tx.appointment.update({
        where: { id },
        data: {
          professionalId: target,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          blockedUntil: range.blockedUntil,
          version: { increment: 1 },
          ...(req.kind === "reactivate"
            ? { status: "SCHEDULED", cancelledAt: null, cancelReason: null }
            : {}),
        },
        select: APPOINTMENT_SELECT,
      })) as AppointmentRow;
    } catch (err) {
      mapExclusion(err);
    }
    return viewOf(tx, updated);
  });
}

export const rescheduleAppointment = (
  deps: AppointmentDeps,
  scope: AppointmentScope,
  id: string,
  input: {
    startsAt: Date;
    professionalId?: string | undefined;
    version: number;
  },
) =>
  moveAppointment(deps, scope, id, {
    kind: "reschedule",
    startsAt: input.startsAt,
    professionalId: input.professionalId,
    version: input.version,
  });

export const reactivateAppointment = (
  deps: AppointmentDeps,
  scope: AppointmentScope,
  id: string,
  input: { version: number },
) =>
  moveAppointment(deps, scope, id, {
    kind: "reactivate",
    version: input.version,
  });

/**
 * Confirmar, concluir, não compareceu e cancelar: somente N4 (a linha do agendamento, por `version`). Não trava o
 * profissional porque não ocupa horário: só criar/remarcar/reativar tornam um agendamento ativo, e todos travam N2.
 * Pode haver falso positivo transitório na checagem de TimeOff/WorkingHours (vê como ativo algo cancelado há instantes),
 * nunca falso negativo (6.5).
 */
export async function changeStatus(
  deps: AppointmentDeps,
  scope: AppointmentScope,
  id: string,
  action: Exclude<StatusAction, "reactivate">,
  input: { version: number; reason?: string | null | undefined },
): Promise<AppointmentView> {
  const db = forTenant(deps.prisma, scope.organizationId);
  return runLocked(db, async (tx) => {
    const row = (await tx.appointment.findUnique({
      where: { id },
      select: APPOINTMENT_SELECT,
    })) as AppointmentRow | null;
    if (!row) throw notFound();
    const to = nextStatus(row.status, action);
    // Versão desatualizada vence a transição inválida: o cliente precisa recarregar de qualquer forma.
    if (row.version !== input.version) throw staleVersion();
    if (!to) throw invalidTransition();
    // Relógio injetado; `endsAt` vem da MESMA leitura que a `version` do UPDATE abaixo: se uma remarcação concorrente
    // mudar o horário, a versão muda e o UPDATE não casa (STALE_VERSION), então nunca se conclui o que deixou de ter terminado.
    if (
      requiresFinished(action) &&
      row.endsAt.getTime() > deps.clock.now().getTime()
    )
      throw new AppError(
        "APPOINTMENT_NOT_FINISHED",
        422,
        "O atendimento ainda não terminou.",
      );
    const { count } = await tx.appointment.updateMany({
      where: { id, version: input.version, status: row.status },
      data: {
        status: to,
        version: { increment: 1 },
        ...(action === "cancel"
          ? {
              cancelledAt: deps.clock.now(),
              cancelReason: input.reason ?? null,
            }
          : {}),
      },
    });
    if (count !== 1) {
      // Outra requisição mudou a linha entre a leitura e a escrita (ou a apagou, o que não existe): releia.
      const now = await tx.appointment.findUnique({
        where: { id },
        select: { version: true, status: true },
      });
      if (!now) throw notFound();
      throw now.version !== input.version
        ? staleVersion()
        : invalidTransition();
    }
    const fresh = (await tx.appointment.findUnique({
      where: { id },
      select: APPOINTMENT_SELECT,
    })) as AppointmentRow;
    return viewOf(tx, fresh);
  });
}
