// 4.4 item 3 — regras estáticas sobre o código de src/ (fora do código gerado).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TENANT_SCOPED_MODELS } from "../../src/lib/db/tenant.ts";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      return name === "generated" ? [] : walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const files = walk(SRC).map((full) => ({
  path: relative(SRC, full).replaceAll("\\", "/"),
  // Sem comentários: a regra vale para código, não para texto explicativo.
  code: readFileSync(full, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1"),
}));

const offenders = (test: (f: (typeof files)[number]) => boolean) =>
  files.filter(test).map((f) => f.path);

describe("regras estáticas de src/", () => {
  it("o código foi lido (sanidade)", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.path === "lib/db/client.ts")).toBe(true);
  });

  it("@prisma/client, o cliente gerado e o adapter só são importados em lib/db/", () => {
    expect(
      offenders(
        (f) =>
          /from "(@prisma\/[^"]+|[^"]*generated\/prisma[^"]*)"/.test(f.code) &&
          !f.path.startsWith("lib/db/"),
      ),
    ).toEqual([]);
  });

  it("`new PrismaClient(` só existe em lib/db/client.ts (uma instância por processo)", () => {
    expect(offenders((f) => /new PrismaClient\s*\(/.test(f.code))).toEqual([
      "lib/db/client.ts",
    ]);
  });

  it("date-fns-tz só é importado em lib/time/zone.ts", () => {
    expect(offenders((f) => f.code.includes("date-fns-tz"))).toEqual([
      "lib/time/zone.ts",
    ]);
  });

  it("$queryRawUnsafe e $executeRawUnsafe são proibidos", () => {
    expect(offenders((f) => /\$(query|execute)RawUnsafe/.test(f.code))).toEqual(
      [],
    );
  });

  // Cada arquivo revisado e por que NENHUMA consulta dele precisa de organization_id.
  const RAW_SQL_ALLOWLIST: Record<string, string> = {
    "lib/db/database.ts": "SELECT 1 (readiness); sem tabelas",
    "lib/db/locks/index.ts":
      "trava users (domínio de autenticação, global) e a linha de organizations pelo próprio id",
    "lib/db/locks/outbox.ts":
      "email_outbox é global (não pertence a uma empresa)",
    "lib/db/locks/maintenance.ts":
      "sessions, auth_tokens e email_outbox são globais; limpeza por vencimento",
  };

  it("$queryRaw/$executeRaw só em arquivos da allowlist revisada (com justificativa)", () => {
    const using = offenders((f) =>
      /\$(queryRaw|executeRaw)\b/.test(f.code),
    ).sort();
    expect(using).toEqual(Object.keys(RAW_SQL_ALLOWLIST).sort());
    for (const reason of Object.values(RAW_SQL_ALLOWLIST))
      expect(reason.length).toBeGreaterThan(10);
  });

  it("SQL em tabela escopada por empresa, se um dia existir em raw SQL, precisa citar organization_id", () => {
    // Nenhum raw SQL toca hoje uma tabela escopada; este teste falha se alguém adicionar um sem organization_id.
    const tenantTables = ["memberships"];
    const bad = offenders(
      (f) =>
        /\$(queryRaw|executeRaw)\b/.test(f.code) &&
        tenantTables.some((t) => new RegExp(`\\b${t}\\b`).test(f.code)) &&
        !f.code.includes("organization_id"),
    );
    expect(bad).toEqual([]);
  });

  it("bloqueios de linha (FOR UPDATE / FOR NO KEY UPDATE) só em lib/db/locks/ (L8)", () => {
    expect(
      offenders(
        (f) =>
          /FOR (NO KEY )?UPDATE/.test(f.code) &&
          !f.path.startsWith("lib/db/locks/"),
      ),
    ).toEqual([]);
  });

  it("modelos escopados por empresa: acesso direto só nos módulos revisados; os demais usam forTenant()", () => {
    const REVIEWED = [
      "lib/db/", // helper e infraestrutura
      "plugins/tenant.ts", // resolve a membership (user + empresa) a partir da sessão
      "modules/organizations/", // cria a empresa/membership e lista as empresas do PRÓPRIO usuário
    ];
    for (const model of TENANT_SCOPED_MODELS) {
      const accessor = model[0]!.toLowerCase() + model.slice(1);
      const bad = offenders(
        (f) =>
          new RegExp(`\\.${accessor}\\.\\w+`).test(f.code) &&
          !REVIEWED.some((r) => f.path.startsWith(r)) &&
          // fora dos módulos revisados, o acesso só é aceito em arquivos que obtêm o cliente por forTenant()
          !f.code.includes("forTenant("),
      );
      expect(
        bad,
        `acesso direto a ${model} fora dos módulos revisados e sem forTenant()`,
      ).toEqual([]);
    }
  });

  it("módulos de recursos escopados nunca recebem o PrismaClient sem escopo para consultar tabelas de tenant", () => {
    // Arquivos que usam forTenant() não podem ALÉM DISSO acessar o modelo escopado direto pelo cliente base.
    for (const model of TENANT_SCOPED_MODELS) {
      const accessor = model[0]!.toLowerCase() + model.slice(1);
      const bad = offenders(
        (f) =>
          f.code.includes("forTenant(") &&
          !f.path.startsWith("lib/db/") &&
          new RegExp(`\\bprisma\\.${accessor}\\.`).test(f.code),
      );
      expect(bad, `uso de prisma.${accessor}.* ao lado de forTenant()`).toEqual(
        [],
      );
    }
  });

  it("não há DELETE físico de entidades-pai (R-c): users e organizations", () => {
    expect(
      offenders((f) =>
        /\.(user|organization)\.(delete|deleteMany)\s*\(/.test(f.code),
      ),
    ).toEqual([]);
  });

  it("organizationId nunca é lido de body, query ou headers para autorização", () => {
    expect(
      offenders((f) =>
        /request\.(body|query|params|headers)\s*(\.|\[)\s*["']?organizationId/.test(
          f.code,
        ),
      ),
    ).toEqual([]);
  });
});
