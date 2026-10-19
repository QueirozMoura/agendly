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
