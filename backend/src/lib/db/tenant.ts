// forTenant(): REDUÇÃO DE RISCO, não garantia de isolamento (4.4). O isolamento é a soma de: este helper,
// FKs compostas, regras estáticas e testes que detectam violações. Limites verificados no spike (V7):
// só atua em operações de TOPO; NÃO cobre $queryRaw/$executeRaw, filtros/include/select aninhados nem
// escritas aninhadas — nesses casos a garantia vem da FK composta (organization_id, X_id).
import type { PrismaClient } from "./client.ts";

/** Modelos com `organization_id` (escopados por tenant). Conferido contra o schema por teste (4.4, item 1). */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  "Membership",
]);

/** Modelos globais (sem `organization_id`), classificados explicitamente. Modelo novo não classificado falha o teste. */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  "User",
  "Session",
  "Organization",
  "AuthToken",
  "EmailOutbox",
]);

/** Lista FECHADA: qualquer outra operação lança erro. */
export const SUPPORTED_OPERATIONS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "create",
  "createMany",
  "upsert",
] as const;

export type SupportedOperation = (typeof SUPPORTED_OPERATIONS)[number];

export class TenantScopeError extends Error {}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Aceita o organizationId do contexto; qualquer valor divergente (ou filtro complexo) é rejeitado. */
function withOrg(source: unknown, organizationId: string): Obj {
  const o: Obj = isObj(source) ? { ...source } : {};
  if ("organizationId" in o && o.organizationId !== organizationId) {
    throw new TenantScopeError("organizationId divergente do contexto");
  }
  // Chaves únicas compostas (ex.: userId_organizationId) também não podem apontar para outra empresa.
  for (const value of Object.values(o)) {
    if (
      isObj(value) &&
      "organizationId" in value &&
      value.organizationId !== organizationId
    ) {
      throw new TenantScopeError("organizationId divergente do contexto");
    }
  }
  if ("organization" in o)
    throw new TenantScopeError(
      "relação 'organization' não é permitida em escritas escopadas",
    );
  return { ...o, organizationId };
}

function noReassign(data: unknown, organizationId: string): unknown {
  if (!isObj(data)) return data;
  if ("organizationId" in data && data.organizationId !== organizationId) {
    throw new TenantScopeError(
      "não é permitido mover um registro para outra empresa",
    );
  }
  if ("organization" in data)
    throw new TenantScopeError(
      "relação 'organization' não é permitida em escritas escopadas",
    );
  return data;
}

/**
 * Argumentos que serão REALMENTE enviados ao Prisma para uma operação de topo. Função pura: a matriz de
 * testes (4.4, item 2) verifica este resultado para cada modelo escopado × operação.
 */
export function scopeOperationArgs(
  operation: string,
  args: unknown,
  organizationId: string,
): Obj {
  const a: Obj = isObj(args) ? args : {};
  switch (operation as SupportedOperation) {
    case "findMany":
    case "findFirst":
    case "findFirstOrThrow":
    case "findUnique":
    case "findUniqueOrThrow":
    case "count":
    case "aggregate":
    case "groupBy":
    case "deleteMany":
    case "delete":
      return { ...a, where: withOrg(a.where, organizationId) };
    case "update":
    case "updateMany":
      return {
        ...a,
        where: withOrg(a.where, organizationId),
        data: noReassign(a.data, organizationId),
      };
    case "create":
      return { ...a, data: withOrg(a.data, organizationId) };
    case "createMany": {
      const data = a.data;
      return {
        ...a,
        data: Array.isArray(data)
          ? data.map((d) => withOrg(d, organizationId))
          : withOrg(data, organizationId),
      };
    }
    case "upsert":
      return {
        ...a,
        where: withOrg(a.where, organizationId),
        create: withOrg(a.create, organizationId),
        update: noReassign(a.update, organizationId),
      };
    default:
      throw new TenantScopeError(
        `operação não suportada em cliente escopado: ${operation}`,
      );
  }
}

/**
 * Cliente restrito a UMA empresa. Só modelos escopados são acessíveis (os globais exigem o cliente sem escopo,
 * permitido apenas em auth/, organizations/, plugins/tenant e jobs/ — regra estática, 4.4 item 3). Dentro de
 * `$transaction` interativa o cliente entregue continua escopado.
 */
export function forTenant(prisma: PrismaClient, organizationId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODELS.has(model)) {
            throw new TenantScopeError(
              `modelo ${model} não é escopado por empresa`,
            );
          }
          return query(
            scopeOperationArgs(operation, args, organizationId) as never,
          );
        },
      },
    },
  });
}
