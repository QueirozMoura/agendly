import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import {
  createProfessionalBody,
  listProfessionalsQuery,
  professionalIdParam,
  setServicesBody,
  updateProfessionalBody,
} from "./schemas.ts";
import {
  createProfessional,
  getProfessional,
  listProfessionals,
  setProfessionalServices,
  updateProfessional,
} from "./service.ts";

export interface ProfessionalRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

const CREATE_PER_USER = { max: 120, timeWindow: "1 hour" }; // em memória, instância única

export async function professionalRoutes(
  app: FastifyInstance,
  opts: ProfessionalRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });
  const createLimiter = app.createRateLimit({
    ...CREATE_PER_USER,
    keyGenerator: (r) => `professional-create:user:${r.tenant?.userId}`,
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/professionals"))
      reply.header("cache-control", "no-store");
  });

  const parseId = (raw: unknown): string => {
    const id = professionalIdParam.safeParse(raw);
    if (!id.success)
      throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
    return id.data;
  };
  const scopeOf = (request: { tenant?: { organizationId: string } }) => ({
    organizationId: (request.tenant as { organizationId: string })
      .organizationId,
  });

  app.get(
    "/api/professionals",
    tenantRoute("professionals.read"),
    async (request) => {
      const q = listProfessionalsQuery.parse(request.query);
      return {
        professionals: await listProfessionals(prisma, scopeOf(request), {
          ...(q.active === undefined ? {} : { active: q.active === "true" }),
        }),
      };
    },
  );

  app.post(
    "/api/professionals",
    tenantRoute("professionals.create"),
    async (request, reply) => {
      const body = createProfessionalBody.parse(request.body);
      const r = await createLimiter(request);
      if (!r.isAllowed && (r.isExceeded || r.isBanned)) {
        reply.header("retry-after", String(r.ttlInSeconds));
        throw new AppError(
          "RATE_LIMITED",
          429,
          "Muitas tentativas. Tente novamente mais tarde.",
        );
      }
      return reply.status(201).send({
        professional: await createProfessional(prisma, scopeOf(request), body),
      });
    },
  );

  app.get(
    "/api/professionals/:id",
    tenantRoute("professionals.read"),
    async (request) => {
      const id = parseId((request.params as { id?: unknown }).id);
      return {
        professional: await getProfessional(prisma, scopeOf(request), id),
      };
    },
  );

  // Editar e ativar/desativar. Profissionais não são apagados (R-c).
  app.patch(
    "/api/professionals/:id",
    tenantRoute("professionals.update"),
    async (request) => {
      const id = parseId((request.params as { id?: unknown }).id);
      const body = updateProfessionalBody.parse(request.body);
      return {
        professional: await updateProfessional(
          prisma,
          scopeOf(request),
          id,
          body,
        ),
      };
    },
  );

  // Vínculo com serviços: define o conjunto completo, de forma atômica.
  app.put(
    "/api/professionals/:id/services",
    tenantRoute("professionals.link_service"),
    async (request) => {
      const id = parseId((request.params as { id?: unknown }).id);
      const body = setServicesBody.parse(request.body);
      return {
        professional: await setProfessionalServices(
          prisma,
          scopeOf(request),
          id,
          body.serviceIds,
        ),
      };
    },
  );
}
