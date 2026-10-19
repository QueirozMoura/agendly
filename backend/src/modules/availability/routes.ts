import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import {
  createTimeOffBody,
  createWorkingHoursBody,
  entryIdParam,
  listByProfessionalQuery,
  updateTimeOffBody,
  updateWorkingHoursBody,
} from "./schemas.ts";
import {
  createTimeOff,
  createWorkingHours,
  deleteTimeOff,
  deleteWorkingHours,
  listTimeOff,
  listWorkingHours,
  updateTimeOff,
  updateWorkingHours,
} from "./service.ts";

export interface AvailabilityRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

// Rotas planas (`/api/working-hours`, `/api/time-off`): o profissional vai no corpo/na query e é conferido na empresa
// da sessão; o único parâmetro de caminho é o `:id` da própria linha. Leitura: `availability.read`; escrita:
// `availability.write`.
export async function availabilityRoutes(
  app: FastifyInstance,
  opts: AvailabilityRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });

  app.addHook("onSend", async (request, reply) => {
    if (
      request.url.startsWith("/api/working-hours") ||
      request.url.startsWith("/api/time-off")
    )
      reply.header("cache-control", "no-store");
  });

  const parseId = (raw: unknown): string => {
    const id = entryIdParam.safeParse(raw);
    if (!id.success)
      throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
    return id.data;
  };
  const idOf = (request: { params: unknown }) =>
    parseId((request.params as { id?: unknown }).id);
  const scopeOf = (request: { tenant?: { organizationId: string } }) => ({
    organizationId: (request.tenant as { organizationId: string })
      .organizationId,
  });

  // ── WorkingHours ──
  app.get(
    "/api/working-hours",
    tenantRoute("availability.read"),
    async (request) => {
      const q = listByProfessionalQuery.parse(request.query);
      return {
        workingHours: await listWorkingHours(
          prisma,
          scopeOf(request),
          q.professionalId,
        ),
      };
    },
  );

  app.post(
    "/api/working-hours",
    tenantRoute("availability.write"),
    async (request, reply) => {
      const body = createWorkingHoursBody.parse(request.body);
      return reply.status(201).send({
        workingHours: await createWorkingHours(prisma, scopeOf(request), body),
      });
    },
  );

  app.patch(
    "/api/working-hours/:id",
    tenantRoute("availability.write"),
    async (request) => {
      const id = idOf(request);
      const body = updateWorkingHoursBody.parse(request.body);
      return {
        workingHours: await updateWorkingHours(
          prisma,
          scopeOf(request),
          id,
          body,
        ),
      };
    },
  );

  app.delete(
    "/api/working-hours/:id",
    tenantRoute("availability.write"),
    async (request, reply) => {
      await deleteWorkingHours(prisma, scopeOf(request), idOf(request));
      return reply.status(204).send();
    },
  );

  // ── TimeOff ──
  app.get(
    "/api/time-off",
    tenantRoute("availability.read"),
    async (request) => {
      const q = listByProfessionalQuery.parse(request.query);
      return {
        timeOff: await listTimeOff(prisma, scopeOf(request), q.professionalId),
      };
    },
  );

  app.post(
    "/api/time-off",
    tenantRoute("availability.write"),
    async (request, reply) => {
      const body = createTimeOffBody.parse(request.body);
      return reply.status(201).send({
        timeOff: await createTimeOff(prisma, scopeOf(request), body),
      });
    },
  );

  app.patch(
    "/api/time-off/:id",
    tenantRoute("availability.write"),
    async (request) => {
      const id = idOf(request);
      const body = updateTimeOffBody.parse(request.body);
      return {
        timeOff: await updateTimeOff(prisma, scopeOf(request), id, body),
      };
    },
  );

  app.delete(
    "/api/time-off/:id",
    tenantRoute("availability.write"),
    async (request, reply) => {
      await deleteTimeOff(prisma, scopeOf(request), idOf(request));
      return reply.status(204).send();
    },
  );
}
