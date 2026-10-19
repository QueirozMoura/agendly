import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../lib/db/client.ts";
import { AppError } from "../../lib/errors.ts";
import { createTenantGuard } from "../../plugins/tenant.ts";
import { makeAuthenticate } from "../auth/authenticate.ts";
import { can } from "../auth/permissions.ts";
import {
  createOrganizationBody,
  emptyQuery,
  switchOrganizationBody,
  updateOrganizationBody,
} from "./schemas.ts";
import {
  createOrganization,
  findOwnMembershipBySlug,
  getOrganization,
  listOrganizations,
  organizationView,
  setActiveOrganization,
  updateOrganization,
} from "./service.ts";

export interface OrganizationRoutesOptions {
  prisma: PrismaClient;
  secureCookies: boolean;
}

// Criação de empresas é rara; o limite evita criação em massa (por usuário e por IP). Em memória (instância única).
const CREATE_PER_USER = { max: 5, timeWindow: "1 hour" };
const CREATE_PER_IP = { max: 20, timeWindow: "1 hour" };

/** Rotas sem escopo de empresa: autenticadas, mas operam sobre as empresas do PRÓPRIO usuário (da sessão). */
const USER_SCOPED = { access: "auth" } as const;

export async function organizationRoutes(
  app: FastifyInstance,
  opts: OrganizationRoutesOptions,
): Promise<void> {
  const { prisma, secureCookies } = opts;
  const deps = { prisma };
  const authenticate = makeAuthenticate(app, { prisma, secureCookies });
  const tenantRoute = createTenantGuard(app, { prisma, secureCookies });

  const createLimiters = [
    app.createRateLimit({
      ...CREATE_PER_IP,
      keyGenerator: (r) => `org-create:ip:${r.ip}`,
    }),
    app.createRateLimit({
      ...CREATE_PER_USER,
      keyGenerator: (r) => `org-create:user:${r.auth?.user.id}`,
    }),
  ];

  app.addHook("onSend", async (request, reply) => {
    if (
      request.url.startsWith("/api/organization") ||
      request.url.startsWith("/api/session/")
    ) {
      reply.header("cache-control", "no-store");
    }
  });

  // --- Criar empresa (exige e-mail verificado: R10) ---
  app.post(
    "/api/organizations",
    { preHandler: authenticate, config: USER_SCOPED },
    async (request, reply) => {
      const body = createOrganizationBody.parse(request.body);
      const { user, sessionId } = request.auth as NonNullable<
        typeof request.auth
      >;
      if (!user.emailVerifiedAt) {
        throw new AppError(
          "EMAIL_NOT_VERIFIED",
          403,
          "Confirme seu e-mail antes de criar uma empresa.",
        );
      }
      for (const limiter of createLimiters) {
        const r = await limiter(request);
        if (!r.isAllowed && (r.isExceeded || r.isBanned)) {
          reply.header("retry-after", String(r.ttlInSeconds));
          throw new AppError(
            "RATE_LIMITED",
            429,
            "Muitas tentativas. Tente novamente mais tarde.",
          );
        }
      }
      const org = await createOrganization(deps, {
        userId: user.id,
        sessionId,
        ...body,
      });
      return reply.status(201).send({ organization: org });
    },
  );

  // --- Listar as empresas do próprio usuário ---
  app.get(
    "/api/organizations",
    { preHandler: authenticate, config: USER_SCOPED },
    async (request) => {
      emptyQuery.parse(request.query);
      const { user, activeOrganizationId } = request.auth as NonNullable<
        typeof request.auth
      >;
      const organizations = await listOrganizations(deps, user.id);
      // A empresa ativa é informada pelo slug (o id interno não sai da API).
      let activeSlug: string | null = null;
      if (activeOrganizationId) {
        const active = await prisma.organization.findUnique({
          where: { id: activeOrganizationId },
          select: { slug: true },
        });
        const own = organizations.find((o) => o.slug === active?.slug);
        activeSlug = own ? own.slug : null;
      }
      return { organizations, activeSlug };
    },
  );

  // --- Trocar a empresa ativa da sessão (4.1): valida a membership do destino ---
  app.post(
    "/api/session/active-organization",
    { preHandler: authenticate, config: USER_SCOPED },
    async (request) => {
      const body = switchOrganizationBody.parse(request.body);
      const { user, sessionId } = request.auth as NonNullable<
        typeof request.auth
      >;
      const target = await findOwnMembershipBySlug(deps, user.id, body.slug);
      // Inexistente e "de outro usuário" são indistinguíveis: 404 genérico.
      if (!target)
        throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
      if (!can(target.role, "session.switch_org")) {
        throw new AppError(
          "FORBIDDEN",
          403,
          "Você não tem permissão para esta ação.",
        );
      }
      await setActiveOrganization(deps, sessionId, target.organizationId);
      return {
        organization: organizationView(target.organization, target.role),
      };
    },
  );

  // --- Empresa ativa: consultar e alterar configurações (escopo: tenant) ---
  app.get("/api/organization", tenantRoute("org.view"), async (request) => {
    emptyQuery.parse(request.query);
    const tenant = request.tenant as NonNullable<typeof request.tenant>;
    return { organization: await getOrganization(deps, tenant) };
  });

  app.patch(
    "/api/organization",
    tenantRoute("org.settings.update"),
    async (request) => {
      const body = updateOrganizationBody.parse(request.body);
      const tenant = request.tenant as NonNullable<typeof request.tenant>;
      return { organization: await updateOrganization(deps, tenant, body) };
    },
  );
}
