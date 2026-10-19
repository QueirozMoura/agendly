import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import {
  createServiceBody,
  listServicesQuery,
  serviceIdParam,
  updateServiceBody,
} from "./schemas.ts";
import {
  createService,
  getService,
  listServices,
  updateService,
} from "./service.ts";

export interface ServiceRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

// Criação em massa é abuso; o limite é por usuário (em memória, instância única como os demais).
const CREATE_PER_USER = { max: 120, timeWindow: "1 hour" };

export async function serviceRoutes(
  app: FastifyInstance,
  opts: ServiceRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });
  const createLimiter = app.createRateLimit({
    ...CREATE_PER_USER,
    keyGenerator: (r) => `service-create:user:${r.tenant?.userId}`,
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/services"))
      reply.header("cache-control", "no-store");
  });

  /** Id da URL: malformado = 404 (igual a inexistente e a "de outra empresa"). */
  const parseId = (raw: unknown): string => {
    const id = serviceIdParam.safeParse(raw);
    if (!id.success)
      throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
    return id.data;
  };
  const scopeOf = (request: { tenant?: { organizationId: string } }) => ({
    organizationId: (request.tenant as { organizationId: string })
      .organizationId,
  });

  app.get("/api/services", tenantRoute("services.read"), async (request) => {
    const q = listServicesQuery.parse(request.query);
    const services = await listServices(prisma, scopeOf(request), {
      ...(q.active === undefined ? {} : { active: q.active === "true" }),
    });
    return { services };
  });

  app.post(
    "/api/services",
    tenantRoute("services.create"),
    async (request, reply) => {
      const body = createServiceBody.parse(request.body);
      const r = await createLimiter(request);
      if (!r.isAllowed && (r.isExceeded || r.isBanned)) {
        reply.header("retry-after", String(r.ttlInSeconds));
        throw new AppError(
          "RATE_LIMITED",
          429,
          "Muitas tentativas. Tente novamente mais tarde.",
        );
      }
      const service = await createService(prisma, scopeOf(request), body);
      return reply.status(201).send({ service });
    },
  );

  app.get(
    "/api/services/:id",
    tenantRoute("services.read"),
    async (request) => {
      const id = parseId((request.params as { id?: unknown }).id);
      return { service: await getService(prisma, scopeOf(request), id) };
    },
  );

  // Editar e ativar/desativar. Serviços não são apagados (R-c): desativam-se.
  app.patch(
    "/api/services/:id",
    tenantRoute("services.update"),
    async (request) => {
      const id = parseId((request.params as { id?: unknown }).id);
      const body = updateServiceBody.parse(request.body);
      return {
        service: await updateService(prisma, scopeOf(request), id, body),
      };
    },
  );
}
