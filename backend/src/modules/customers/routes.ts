import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import { customerIdParam, updateCustomerBody } from "./schemas.ts";
import { getCustomer, updateCustomer } from "./service.ts";

export interface CustomerRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

export async function customerRoutes(
  app: FastifyInstance,
  opts: CustomerRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/customers"))
      reply.header("cache-control", "no-store");
  });

  const idOf = (request: { params: unknown }): string => {
    const id = customerIdParam.safeParse(
      (request.params as { id?: unknown }).id,
    );
    if (!id.success)
      throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
    return id.data;
  };
  const scopeOf = (request: { tenant?: { organizationId: string } }) => ({
    organizationId: (request.tenant as { organizationId: string })
      .organizationId,
  });

  app.get(
    "/api/customers/:id",
    tenantRoute("customers.read"),
    async (request) => ({
      customer: await getCustomer(prisma, scopeOf(request), idOf(request)),
    }),
  );

  app.patch(
    "/api/customers/:id",
    tenantRoute("customers.write"),
    async (request) => {
      const id = idOf(request);
      const body = updateCustomerBody.parse(request.body);
      return {
        customer: await updateCustomer(prisma, scopeOf(request), id, body),
      };
    },
  );
}
