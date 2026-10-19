import { parseSchemaModels } from "./schema-model.ts";

/** Consultas sobre tabelas escopadas por empresa que NÃO citam organization_id e não estão na allowlist. */
export function sentinelViolations(
  queries: string[],
  allow: Array<{ pattern: RegExp; reason: string }>,
): string[] {
  const tenantTables = parseSchemaModels()
    .filter((m) => m.hasOrganizationId)
    .map((m) => m.dbName);
  return queries.filter((q) => {
    const touches = tenantTables.some((t) => new RegExp(`"${t}"`).test(q));
    if (!touches) return false;
    if (/organization_id/.test(q)) return false;
    return !allow.some((a) => a.pattern.test(q));
  });
}
