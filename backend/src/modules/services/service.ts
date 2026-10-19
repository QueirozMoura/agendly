import type { PrismaClient } from "../../lib/db/client.ts";
import { forTenant } from "../../lib/db/tenant.ts";
import { AppError } from "../../lib/errors.ts";

export interface ServiceView {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  durationMinutes: true,
  bufferMinutes: true,
  priceCents: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

/** Contexto já resolvido pelo tenantPlugin (vem da sessão, nunca do cliente). */
export interface ServiceScope {
  organizationId: string;
}

// Todo acesso passa por forTenant(): o organizationId do contexto é injetado em toda operação e um valor
// divergente é rejeitado. O id vindo da URL só seleciona DENTRO da empresa ativa: de outra empresa = 404.

export async function createService(
  prisma: PrismaClient,
  scope: ServiceScope,
  input: {
    name: string;
    durationMinutes: number;
    bufferMinutes: number;
    priceCents: number | null;
  },
): Promise<ServiceView> {
  return forTenant(prisma, scope.organizationId).service.create({
    data: { organizationId: scope.organizationId, ...input },
    select: SELECT,
  });
}

export async function listServices(
  prisma: PrismaClient,
  scope: ServiceScope,
  filter: { active?: boolean },
): Promise<ServiceView[]> {
  return forTenant(prisma, scope.organizationId).service.findMany({
    where: filter.active === undefined ? {} : { active: filter.active },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: SELECT,
  });
}

export async function getService(
  prisma: PrismaClient,
  scope: ServiceScope,
  id: string,
): Promise<ServiceView> {
  const service = await forTenant(
    prisma,
    scope.organizationId,
  ).service.findUnique({
    where: { id },
    select: SELECT,
  });
  if (!service) throw notFound();
  return service;
}

export async function updateService(
  prisma: PrismaClient,
  scope: ServiceScope,
  id: string,
  patch: {
    name?: string | undefined;
    durationMinutes?: number | undefined;
    bufferMinutes?: number | undefined;
    priceCents?: number | null | undefined;
    active?: boolean | undefined;
  },
): Promise<ServiceView> {
  // Só os campos enviados entram no UPDATE (campos diferentes editados ao mesmo tempo não se sobrescrevem).
  const data = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  try {
    return await forTenant(prisma, scope.organizationId).service.update({
      where: { id },
      data,
      select: SELECT,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") throw notFound(); // inexistente OU de outra empresa
    throw err;
  }
}
