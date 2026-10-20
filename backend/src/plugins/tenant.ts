import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "../lib/db/client.ts";
import { AppError } from "../lib/errors.ts";
import { makeAuthenticate } from "../modules/auth/authenticate.ts";
import { can } from "../modules/auth/permissions.ts";

export interface TenantContext {
  organizationId: string;
  organizationSlug: string;
  /** Fuso IANA da empresa (imutável, R9): lido da empresa ativa validada, nunca do cliente. */
  organizationTimezone: string;
  userId: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

const ACTIVE_ORG_HEADER = "x-active-org";

/**
 * tenantPlugin (4.1). A empresa é derivada NO SERVIDOR: sessão validada → `active_organization_id` → membership
 * do usuário. `organizationId` nunca é lido de body, query, path ou header para conceder acesso; o cabeçalho
 * `X-Active-Org` (slug) é só uma asserção de consistência entre abas e nunca concede nada.
 */
export function createTenantGuard(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; secureCookies: boolean },
) {
  const { prisma } = deps;
  const authenticate = makeAuthenticate(app, deps);

  async function resolveTenant(request: FastifyRequest): Promise<void> {
    const auth = request.auth as NonNullable<FastifyRequest["auth"]>;
    const organizationId = auth.activeOrganizationId;
    if (!organizationId) {
      throw new AppError(
        "NO_ACTIVE_ORGANIZATION",
        403,
        "Selecione uma empresa para continuar.",
      );
    }

    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: auth.user.id, organizationId },
      },
      relationLoadStrategy: "join",
      select: {
        role: true,
        organization: {
          select: { slug: true, status: true, timezone: true },
        },
      },
    });
    if (!membership || membership.organization.status !== "ACTIVE") {
      // Membership perdida: 403 e a sessão perde a empresa ativa (4.1).
      await prisma.session.updateMany({
        where: { id: auth.sessionId, activeOrganizationId: organizationId },
        data: { activeOrganizationId: null },
      });
      throw new AppError(
        "ORGANIZATION_ACCESS_REVOKED",
        403,
        "Você não tem mais acesso a esta empresa.",
      );
    }

    // Asserção de consistência entre abas: se divergir, nada é executado (4.1).
    const asserted = request.headers[ACTIVE_ORG_HEADER];
    if (asserted !== undefined && asserted !== membership.organization.slug) {
      throw new AppError(
        "ACTIVE_ORG_CHANGED",
        409,
        "A empresa ativa mudou em outra aba. Recarregue a página.",
      );
    }

    request.tenant = {
      organizationId,
      organizationSlug: membership.organization.slug,
      organizationTimezone: membership.organization.timezone,
      userId: auth.user.id,
      role: membership.role,
    };
  }

  function authorize(action: string) {
    return async (request: FastifyRequest): Promise<void> => {
      if (!can(request.tenant?.role, action)) {
        throw new AppError(
          "FORBIDDEN",
          403,
          "Você não tem permissão para esta ação.",
        );
      }
    };
  }

  /**
   * Opções de rota para rotas escopadas por empresa: classificação (`access: "tenant"`), ação exigida e a
   * cadeia 401 (sessão) → 403/409 (contexto de empresa) → 403 (permissão). Toda rota `tenant` DEVE usar isto.
   */
  return function tenantRoute(action: string) {
    return {
      config: { access: "tenant", action } as const,
      preHandler: [authenticate, resolveTenant, authorize(action)] as ((
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<void>)[],
    };
  };
}
