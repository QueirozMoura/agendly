import type { PrismaClient } from "../../lib/db/client.ts";
import { classifyDbError } from "../../lib/db/errors.ts";
import { lockOrganization } from "../../lib/db/locks/index.ts";
import { AppError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import type { UpdateOrganizationInput } from "./schemas.ts";

export interface OrganizationView {
  name: string;
  slug: string;
  timezone: string;
  status: string;
  publishedAt: Date | null;
  publicMinNoticeMinutes: number;
  publicMaxAdvanceDays: number;
  publicMaxActiveBookingsPerPhone: number;
  createdAt: Date;
  role: string;
}

type OrgRow = Omit<OrganizationView, "role">;

const ORG_SELECT = {
  name: true,
  slug: true,
  timezone: true,
  status: true,
  publishedAt: true,
  publicMinNoticeMinutes: true,
  publicMaxAdvanceDays: true,
  publicMaxActiveBookingsPerPhone: true,
  createdAt: true,
} as const;

const slugTaken = () =>
  new AppError(
    "SLUG_UNAVAILABLE",
    409,
    "Este endereço já está em uso. Escolha outro.",
  );

/** O id interno nunca sai da API: o cliente identifica a empresa pelo slug. */
const view = (org: OrgRow, role: string): OrganizationView => ({
  ...org,
  role,
});

export interface OrgDeps {
  prisma: PrismaClient;
}

/**
 * Cria a empresa, a membership OWNER e define a empresa ativa da sessão em UMA transação: ou os três acontecem
 * ou nenhum. A regra "e-mail verificado" é conferida pelo chamador com o estado atual do usuário.
 */
export async function createOrganization(
  deps: OrgDeps,
  input: {
    userId: string;
    sessionId: string;
    name: string;
    slug: string;
    timezone: string;
  },
): Promise<OrganizationView> {
  try {
    return await deps.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          id: newId(),
          name: input.name,
          slug: input.slug,
          timezone: input.timezone,
        },
        select: { id: true, ...ORG_SELECT },
      });
      await tx.membership.create({
        data: { userId: input.userId, organizationId: org.id, role: "OWNER" },
      });
      await tx.session.update({
        where: { id: input.sessionId },
        data: { activeOrganizationId: org.id },
      });
      const { id: _internal, ...rest } = org;
      void _internal;
      return view(rest, "OWNER");
    });
  } catch (err) {
    if (classifyDbError(err) === "unique_violation") throw slugTaken();
    throw err;
  }
}

/** Empresas do PRÓPRIO usuário (filtradas por `user_id` da sessão; nunca por parâmetro do cliente). */
export async function listOrganizations(
  deps: OrgDeps,
  userId: string,
): Promise<OrganizationView[]> {
  const rows = await deps.prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, organization: { select: ORG_SELECT } },
  });
  return rows.map((r) => view(r.organization, r.role));
}

export async function getOrganization(
  deps: OrgDeps,
  tenant: { organizationId: string; role: string },
): Promise<OrganizationView> {
  const org = await deps.prisma.organization.findUnique({
    where: { id: tenant.organizationId },
    select: ORG_SELECT,
  });
  if (!org) throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");
  return view(org, tenant.role);
}

/**
 * Atualiza só campos permitidos da empresa ativa. Trava a linha da empresa (6.5) para validar a regra entre
 * campos (antecedência mínima < máxima) sobre valores que ninguém mais altera ao mesmo tempo.
 */
export async function updateOrganization(
  deps: OrgDeps,
  tenant: { organizationId: string; role: string },
  patch: UpdateOrganizationInput,
): Promise<OrganizationView> {
  try {
    return await deps.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, tenant.organizationId);
      const current = await tx.organization.findUnique({
        where: { id: tenant.organizationId },
        select: ORG_SELECT,
      });
      if (!current)
        throw new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

      const minNotice =
        patch.publicMinNoticeMinutes ?? current.publicMinNoticeMinutes;
      const maxAdvance =
        patch.publicMaxAdvanceDays ?? current.publicMaxAdvanceDays;
      if (minNotice >= maxAdvance * 24 * 60) {
        throw new AppError("VALIDATION_ERROR", 400, "Dados inválidos.", [
          {
            path: "publicMinNoticeMinutes",
            message:
              "A antecedência mínima deve ser menor que a antecedência máxima.",
          },
        ]);
      }

      const updated = await tx.organization.update({
        where: { id: tenant.organizationId },
        data: patch,
        select: ORG_SELECT,
      });
      return view(updated, tenant.role);
    });
  } catch (err) {
    if (classifyDbError(err) === "unique_violation") throw slugTaken();
    throw err;
  }
}

/**
 * Troca a empresa ativa da sessão (4.1). A membership do destino é validada pelo servidor; empresa inexistente
 * ou de outro usuário dá a MESMA resposta 404 (sem enumeração). Devolve o papel para o chamador aplicar `can()`.
 */
export async function findOwnMembershipBySlug(
  deps: OrgDeps,
  userId: string,
  slug: string,
): Promise<
  { organizationId: string; role: string; organization: OrgRow } | undefined
> {
  const m = await deps.prisma.membership.findFirst({
    where: { userId, organization: { slug } },
    select: {
      organizationId: true,
      role: true,
      organization: { select: ORG_SELECT },
    },
  });
  return m ?? undefined;
}

export async function setActiveOrganization(
  deps: OrgDeps,
  sessionId: string,
  organizationId: string,
): Promise<void> {
  await deps.prisma.session.update({
    where: { id: sessionId },
    data: { activeOrganizationId: organizationId },
  });
}

export { view as organizationView };
