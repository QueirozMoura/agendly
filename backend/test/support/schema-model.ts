import { readFileSync } from "node:fs";

export interface SchemaModel {
  name: string;
  dbName: string;
  fields: string[];
  /** Tem a coluna `organizationId` (escopado por tenant)? */
  hasOrganizationId: boolean;
}

/** Lê os modelos do schema.prisma (fonte de verdade do inventário de tenant: 4.4, item 1). */
export function parseSchemaModels(
  path = new URL("../../prisma/schema.prisma", import.meta.url),
): SchemaModel[] {
  const text = readFileSync(path, "utf8");
  const models: SchemaModel[] = [];
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m as unknown as [string, string, string];
    const fields = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)[0] as string);
    const dbName = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    models.push({
      name,
      dbName,
      fields,
      hasOrganizationId: fields.includes("organizationId"),
    });
  }
  return models;
}

/**
 * Modelos-PAI: alvo de alguma relação com chaves estrangeiras (`@relation(fields: [...])`) declarada em outro modelo.
 * Apagar uma linha-pai conflita com as checagens de FK dos filhos e criaria esperas fora da hierarquia de locks
 * (R-c, 6.5); por isso nenhum código de produção pode dar `delete`/`deleteMany` neles.
 */
export function parentModels(
  path = new URL("../../prisma/schema.prisma", import.meta.url),
): string[] {
  const text = readFileSync(path, "utf8");
  const parents = new Set<string>();
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m as unknown as [string, string, string];
    for (const line of body.split("\n")) {
      const rel = /^\s*\w+\s+(\w+)\??\s+@relation\(.*fields:\s*\[/.exec(line);
      if (rel && rel[1] !== name) parents.add(rel[1] as string);
    }
  }
  return [...parents].sort();
}
