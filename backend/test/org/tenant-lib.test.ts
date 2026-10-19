// 4.4 itens 1 e 2 — inventário de modelos (a partir do schema) e matriz de operações do helper forTenant().
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_MODELS,
  SUPPORTED_OPERATIONS,
  TENANT_SCOPED_MODELS,
  TenantScopeError,
  forTenant,
  scopeOperationArgs,
} from "../../src/lib/db/tenant.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { TEST_DB, prodPrisma, truncate } from "../support/databases.ts";
import { parseSchemaModels } from "../support/schema-model.ts";

const ORG = "00000000-0000-7000-8000-00000000000a";
const OTHER = "00000000-0000-7000-8000-00000000000b";
const models = parseSchemaModels();

describe("item 1 — inventário via schema: todo modelo é escopado OU global explícito", () => {
  it("o schema foi lido (sanidade)", () => {
    expect(models.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        "User",
        "Session",
        "Organization",
        "Membership",
        "AuthToken",
        "EmailOutbox",
      ]),
    );
  });

  it("modelo com organizationId está em TENANT_SCOPED_MODELS e vice-versa", () => {
    const withOrg = models
      .filter((m) => m.hasOrganizationId)
      .map((m) => m.name)
      .sort();
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(withOrg);
  });

  it("todo modelo está classificado; nenhum em duas listas; modelo novo não classificado FALHA aqui", () => {
    const unclassified = models
      .map((m) => m.name)
      .filter((n) => !TENANT_SCOPED_MODELS.has(n) && !GLOBAL_MODELS.has(n));
    expect(
      unclassified,
      `modelos sem classificação: ${unclassified.join(", ")}`,
    ).toEqual([]);
    for (const n of TENANT_SCOPED_MODELS)
      expect(GLOBAL_MODELS.has(n), n).toBe(false);
    // as listas não citam modelos que não existem mais
    const names = new Set(models.map((m) => m.name));
    for (const n of [...TENANT_SCOPED_MODELS, ...GLOBAL_MODELS])
      expect(names.has(n), n).toBe(true);
  });

  it("modelos globais NÃO têm organizationId (e Session usa active_organization_id, que não é de tenant)", () => {
    for (const m of models.filter((x) => GLOBAL_MODELS.has(x.name)))
      expect(m.hasOrganizationId, m.name).toBe(false);
  });
});

describe("item 2 — matriz de operações: modelo escopado × operação", () => {
  const tenantModels = models
    .filter((m) => m.hasOrganizationId)
    .map((m) => m.name);

  it("há ao menos um modelo escopado para a matriz exercitar", () => {
    expect(tenantModels.length).toBeGreaterThan(0);
  });

  const sample = (op: string) => {
    switch (op) {
      case "create":
        return { data: { userId: "u", role: "OWNER" } };
      case "createMany":
        return {
          data: [
            { userId: "u1", role: "OWNER" },
            { userId: "u2", role: "OWNER" },
          ],
        };
      case "update":
      case "updateMany":
        return { where: { id: "x" }, data: { role: "OWNER" } };
      case "upsert":
        return {
          where: { id: "x" },
          create: { userId: "u", role: "OWNER" },
          update: { role: "OWNER" },
        };
      default:
        return { where: { id: "x" } };
    }
  };

  for (const op of SUPPORTED_OPERATIONS) {
    it(`${op}: o que é ENVIADO contém o organizationId do contexto`, () => {
      for (const model of tenantModels) {
        const out = scopeOperationArgs(op, sample(op), ORG) as Record<
          string,
          unknown
        >;
        const carriers: unknown[] =
          op === "create"
            ? [out.data]
            : op === "createMany"
              ? (out.data as unknown[])
              : op === "upsert"
                ? [out.where, out.create]
                : [out.where];
        for (const c of carriers)
          expect(
            (c as Record<string, unknown>).organizationId,
            `${model}.${op}`,
          ).toBe(ORG);
        if (op === "update" || op === "updateMany")
          expect(out.data).toEqual({ role: "OWNER" });
      }
    });

    it(`${op}: organizationId DIVERGENTE do chamador é rejeitado`, () => {
      const base = sample(op) as Record<string, unknown>;
      const poisoned = (() => {
        switch (op) {
          case "create":
            return {
              data: { ...(base.data as object), organizationId: OTHER },
            };
          case "createMany":
            return {
              data: [{ userId: "u", role: "OWNER", organizationId: OTHER }],
            };
          case "update":
          case "updateMany":
            return { ...base, data: { role: "OWNER", organizationId: OTHER } };
          case "upsert":
            return {
              ...base,
              create: { userId: "u", role: "OWNER", organizationId: OTHER },
            };
          default:
            return { where: { id: "x", organizationId: OTHER } };
        }
      })();
      expect(() => scopeOperationArgs(op, poisoned, ORG)).toThrow(
        TenantScopeError,
      );
    });
  }

  it("where também não pode apontar para outra empresa via chave única composta", () => {
    expect(() =>
      scopeOperationArgs(
        "findUnique",
        {
          where: {
            userId_organizationId: { userId: "u", organizationId: OTHER },
          },
        },
        ORG,
      ),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeOperationArgs(
        "findUnique",
        {
          where: {
            userId_organizationId: { userId: "u", organizationId: ORG },
          },
        },
        ORG,
      ),
    ).not.toThrow();
  });

  it("escritas não podem mover o registro de empresa nem usar a relação `organization`", () => {
    expect(() =>
      scopeOperationArgs(
        "update",
        { where: {}, data: { organization: { connect: { id: OTHER } } } },
        ORG,
      ),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeOperationArgs(
        "create",
        { data: { organization: { connect: { id: OTHER } } } },
        ORG,
      ),
    ).toThrow(TenantScopeError);
  });

  it("lista FECHADA: operações fora dela lançam erro", () => {
    for (const op of [
      "createManyAndReturn",
      "updateManyAndReturn",
      "findRaw",
      "aggregateRaw",
      "$queryRaw",
      "",
    ]) {
      expect(() => scopeOperationArgs(op, {}, ORG), op).toThrow(
        TenantScopeError,
      );
    }
  });

  it("a função é pura: não altera o objeto recebido", () => {
    const args = Object.freeze({ where: Object.freeze({ id: "x" }) });
    expect(() => scopeOperationArgs("findMany", args, ORG)).not.toThrow();
    expect(args.where).toEqual({ id: "x" });
  });
});

describe("forTenant() com PostgreSQL real", () => {
  const prisma = prodPrisma();
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncate(TEST_DB, ["users", "organizations"]));

  async function seed() {
    const [u1, u2, u3] = await Promise.all(
      ["a", "b", "c"].map((n) =>
        prisma.user.create({
          data: { email: `${n}@example.com`, passwordHash: "h", name: n },
        }),
      ),
    );
    const a = await prisma.organization.create({
      data: { name: "A", slug: "empresa-a", timezone: "UTC" },
    });
    const b = await prisma.organization.create({
      data: { name: "B", slug: "empresa-b", timezone: "UTC" },
    });
    const ma = await prisma.membership.create({
      data: { userId: u1!.id, organizationId: a.id, role: "OWNER" },
    });
    const mb = await prisma.membership.create({
      data: { userId: u2!.id, organizationId: b.id, role: "OWNER" },
    });
    return { a, b, ma, mb, users: [u1!, u2!, u3!] as const };
  }

  it("leituras só enxergam a empresa do contexto; id de OUTRA empresa => null / P2025", async () => {
    const { a, ma, mb } = await seed();
    const db = forTenant(prisma, a.id);
    expect((await db.membership.findMany()).map((m) => m.id)).toEqual([ma.id]);
    expect(await db.membership.count()).toBe(1);
    expect(await db.membership.findUnique({ where: { id: mb.id } })).toBeNull();
    expect(await db.membership.findFirst({ where: { id: mb.id } })).toBeNull();
    await expect(
      db.membership.findUniqueOrThrow({ where: { id: mb.id } }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      db.membership.update({ where: { id: mb.id }, data: { role: "OWNER" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      db.membership.delete({ where: { id: mb.id } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(
      (await db.membership.deleteMany({ where: { id: mb.id } })).count,
    ).toBe(0);
    expect(await prisma.membership.count()).toBe(2);
  });

  it("create/createMany/upsert injetam a empresa; divergente => TenantScopeError e nada é gravado", async () => {
    const { a, b, users } = await seed();
    const db = forTenant(prisma, a.id);
    // A empresa A já tem OWNER: o índice parcial barra o INSERT — prova que ele foi feito NA empresa A.
    const dup = await db.membership
      .create({ data: { userId: users[2].id, role: "OWNER" } as never })
      .catch((e) => e);
    expect(classifyDbError(dup)).toBe("unique_violation");
    // Em uma empresa sem membership, o organizationId do contexto é injetado e o registro nasce nela.
    const empty = await prisma.organization.create({
      data: { name: "C", slug: "empresa-c", timezone: "UTC" },
    });
    const made = await forTenant(prisma, empty.id).membership.create({
      data: { userId: users[2].id, role: "OWNER" } as never,
    });
    expect(made.organizationId).toBe(empty.id);
    await expect(
      db.membership.create({
        data: { userId: users[2].id, organizationId: b.id, role: "OWNER" },
      }),
    ).rejects.toThrow(TenantScopeError);
    expect(
      await prisma.membership.count({
        where: { userId: users[2].id, organizationId: b.id },
      }),
    ).toBe(0);
    const agg = await db.membership.aggregate({ _count: true });
    expect(agg._count).toBe(1);
    expect(
      await db.membership.groupBy({ by: ["organizationId"], _count: true }),
    ).toHaveLength(1);
  });

  it("modelos globais não são acessíveis pelo cliente escopado", async () => {
    const { a } = await seed();
    const db = forTenant(prisma, a.id);
    await expect(db.user.findMany()).rejects.toThrow(TenantScopeError);
    await expect(db.organization.findMany()).rejects.toThrow(TenantScopeError);
    await expect(db.session.deleteMany()).rejects.toThrow(TenantScopeError);
  });

  it("dentro de $transaction interativa o cliente continua escopado", async () => {
    const { a, ma } = await seed();
    const ids = await forTenant(prisma, a.id).$transaction(async (tx) =>
      (await tx.membership.findMany()).map((m) => m.id),
    );
    expect(ids).toEqual([ma.id]);
  });

  it("LIMITE conhecido: $queryRaw não é coberto (a garantia nesses casos é revisão + regras estáticas)", async () => {
    const { a } = await seed();
    const rows = await forTenant(prisma, a.id).$queryRaw<
      { id: string }[]
    >`SELECT id FROM memberships`;
    expect(rows).toHaveLength(2);
  });
});
