import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import {
  appointmentIdParam,
  cancelBody,
  createAppointmentBody,
  idempotencyKeyHeader,
  listAppointmentsQuery,
  rescheduleBody,
  versionBody,
} from "./schemas.ts";
import {
  changeStatus,
  createAppointment,
  getAppointment,
  listAppointments,
  reactivateAppointment,
  rescheduleAppointment,
  type AppointmentDeps,
  type AppointmentScope,
} from "./service.ts";

export interface AppointmentRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

export async function appointmentRoutes(
  app: FastifyInstance,
  opts: AppointmentRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });
  const deps = (): AppointmentDeps => ({ prisma, clock: app.clock });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/appointments"))
      reply.header("cache-control", "no-store");
  });

  const parseId = (raw: unknown): string => {
    const id = appointmentIdParam.safeParse(raw);
    if (!id.success)
      throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
    return id.data;
  };
  const idOf = (request: { params: unknown }) =>
    parseId((request.params as { id?: unknown }).id);
  // A empresa, o usuário e o fuso vêm SOMENTE do contexto validado da sessão (nunca de body/query/header).
  const scopeOf = (request: {
    tenant?: {
      organizationId: string;
      userId: string;
      organizationTimezone: string;
    };
  }): AppointmentScope => {
    const t = request.tenant as NonNullable<typeof request.tenant>;
    return {
      organizationId: t.organizationId,
      userId: t.userId,
      timezone: t.organizationTimezone,
    };
  };

  // Criar. `Idempotency-Key` (UUID) é obrigatório (6.4). Replay: mesmo status/corpo e `Idempotent-Replay: true`.
  app.post(
    "/api/appointments",
    tenantRoute("appointments.create"),
    async (request, reply) => {
      const key = idempotencyKeyHeader.safeParse(
        request.headers["idempotency-key"],
      );
      if (!key.success)
        throw new AppError(
          "IDEMPOTENCY_KEY_INVALID",
          400,
          "Informe o cabeçalho Idempotency-Key com um UUID.",
        );
      const body = createAppointmentBody.parse(request.body);
      const result = await createAppointment(
        deps(),
        scopeOf(request),
        body,
        key.data,
      );
      if (result.replay) reply.header("idempotent-replay", "true");
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    "/api/appointments",
    tenantRoute("appointments.read"),
    async (request) => {
      const q = listAppointmentsQuery.parse(request.query);
      return {
        appointments: await listAppointments(prisma, scopeOf(request), q),
      };
    },
  );

  app.get(
    "/api/appointments/:id",
    tenantRoute("appointments.read"),
    async (request) => ({
      appointment: await getAppointment(
        prisma,
        scopeOf(request),
        idOf(request),
      ),
    }),
  );

  app.post(
    "/api/appointments/:id/reschedule",
    tenantRoute("appointments.reschedule"),
    async (request) => {
      const id = idOf(request);
      const body = rescheduleBody.parse(request.body);
      return {
        appointment: await rescheduleAppointment(
          deps(),
          scopeOf(request),
          id,
          body,
        ),
      };
    },
  );

  app.post(
    "/api/appointments/:id/reactivate",
    tenantRoute("appointments.set_status"),
    async (request) => {
      const id = idOf(request);
      const body = versionBody.parse(request.body);
      return {
        appointment: await reactivateAppointment(
          deps(),
          scopeOf(request),
          id,
          body,
        ),
      };
    },
  );

  app.post(
    "/api/appointments/:id/cancel",
    tenantRoute("appointments.cancel"),
    async (request) => {
      const id = idOf(request);
      const body = cancelBody.parse(request.body);
      return {
        appointment: await changeStatus(
          deps(),
          scopeOf(request),
          id,
          "cancel",
          body,
        ),
      };
    },
  );

  const statusRoutes = [
    ["confirm", "confirm", "appointments.confirm"],
    ["complete", "complete", "appointments.set_status"],
    ["no-show", "no_show", "appointments.set_status"],
  ] as const;
  for (const [path, action, permission] of statusRoutes) {
    app.post(
      `/api/appointments/:id/${path}`,
      tenantRoute(permission),
      async (request) => {
        const id = idOf(request);
        const body = versionBody.parse(request.body);
        return {
          appointment: await changeStatus(
            deps(),
            scopeOf(request),
            id,
            action,
            body,
          ),
        };
      },
    );
  }
}
