import type { PrismaClient, TxClient } from "../../lib/db/client.ts";
import { lockProfessional } from "../../lib/db/locks/index.ts";
import { forTenant } from "../../lib/db/tenant.ts";
import { AppError } from "../../lib/errors.ts";

export interface ProfessionalView {
  id: string;
  name: string;
  active: boolean;
  serviceIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

export interface ProfessionalScope {
  organizationId: string;
}

// Todo acesso passa por forTenant(): o organizationId do contexto é injetado em cada operação e um valor divergente
// é rejeitado. O banco repete a regra com FKs compostas (organization_id, profissional/serviço).

type Row = {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

async function withServiceIds(
  db: ReturnType<typeof forTenant>,
  rows: Row[],
): Promise<ProfessionalView[]> {
  if (rows.length === 0) return [];
  const links = await db.professionalService.findMany({
    where: { professionalId: { in: rows.map((r) => r.id) } },
    select: { professionalId: true, serviceId: true },
    orderBy: { serviceId: "asc" },
  });
  const byProfessional = new Map<string, string[]>();
  for (const l of links)
    byProfessional.set(l.professionalId, [
      ...(byProfessional.get(l.professionalId) ?? []),
      l.serviceId,
    ]);
  return rows.map((r) => ({
    ...r,
    serviceIds: byProfessional.get(r.id) ?? [],
  }));
}

export async function createProfessional(
  prisma: PrismaClient,
  scope: ProfessionalScope,
  input: { name: string },
): Promise<ProfessionalView> {
  const db = forTenant(prisma, scope.organizationId);
  const row = await db.professional.create({
    data: { organizationId: scope.organizationId, name: input.name },
    select: SELECT,
  });
  return { ...row, serviceIds: [] };
}

export async function listProfessionals(
  prisma: PrismaClient,
  scope: ProfessionalScope,
  filter: { active?: boolean },
): Promise<ProfessionalView[]> {
  const db = forTenant(prisma, scope.organizationId);
  const rows = await db.professional.findMany({
    where: filter.active === undefined ? {} : { active: filter.active },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: SELECT,
  });
  return withServiceIds(db, rows);
}

export async function getProfessional(
  prisma: PrismaClient,
  scope: ProfessionalScope,
  id: string,
): Promise<ProfessionalView> {
  const db = forTenant(prisma, scope.organizationId);
  const row = await db.professional.findUnique({
    where: { id },
    select: SELECT,
  });
  if (!row) throw notFound();
  return (await withServiceIds(db, [row]))[0] as ProfessionalView;
}

/** Editar/desativar: N2 (trava do profissional) → escrita (6.5). Profissionais não são apagados (R-c). */
export async function updateProfessional(
  prisma: PrismaClient,
  scope: ProfessionalScope,
  id: string,
  patch: { name?: string | undefined; active?: boolean | undefined },
): Promise<ProfessionalView> {
  const data = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  await forTenant(prisma, scope.organizationId).$transaction(async (tx) => {
    if (
      !(await lockProfessional(
        tx as unknown as TxClient,
        scope.organizationId,
        id,
      ))
    )
      throw notFound();
    await tx.professional.update({ where: { id }, data });
  });
  return getProfessional(prisma, scope, id);
}

/**
 * Define o conjunto COMPLETO de serviços do profissional, de forma atômica e serializada (N2 → N4):
 * 1. trava o profissional (404 se não existir NESTA empresa);
 * 2. confere que TODOS os serviços existem NESTA empresa (algum alheio/inexistente => 404 e nada muda);
 * 3. remove os vínculos que saíram e cria os novos (`skipDuplicates`).
 * Sem a trava, dois PUTs simultâneos poderiam deixar a união dos dois conjuntos.
 */
export async function setProfessionalServices(
  prisma: PrismaClient,
  scope: ProfessionalScope,
  id: string,
  serviceIds: string[],
): Promise<ProfessionalView> {
  const wanted = [...new Set(serviceIds)];
  await forTenant(prisma, scope.organizationId).$transaction(async (tx) => {
    if (
      !(await lockProfessional(
        tx as unknown as TxClient,
        scope.organizationId,
        id,
      ))
    )
      throw notFound();

    if (wanted.length > 0) {
      const found = await tx.service.findMany({
        where: { id: { in: wanted } },
        select: { id: true },
      });
      if (found.length !== wanted.length) throw notFound(); // serviço alheio ou inexistente
    }
    await tx.professionalService.deleteMany({
      where: {
        professionalId: id,
        ...(wanted.length > 0 ? { serviceId: { notIn: wanted } } : {}),
      },
    });
    if (wanted.length > 0) {
      await tx.professionalService.createMany({
        data: wanted.map((serviceId) => ({
          organizationId: scope.organizationId,
          professionalId: id,
          serviceId,
        })),
        skipDuplicates: true,
      });
    }
  });
  return getProfessional(prisma, scope, id);
}
