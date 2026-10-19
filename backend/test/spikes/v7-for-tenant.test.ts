// V7 — o que um client extension "forTenant" realmente cobre. Protótipo descartável (só neste teste);
// a implementação de produção é da Etapa 6.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SPIKE_DB, spikePrisma, truncate } from "../support/databases.ts";
import { appointmentData, seedOrg } from "../support/spike-fixtures.ts";

const base = spikePrisma();
afterAll(() => base.$disconnect());
beforeEach(() => truncate(SPIKE_DB, ["orgs"]));

const TENANT_MODELS = new Set([
  "Professional",
  "Service",
  "Customer",
  "Appointment",
  "Note",
]);
const WHERE_OPS = new Set([
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
]);

type Obj = Record<string, unknown>;

function scoped(organizationId: string) {
  const withOrg = (o: Obj | undefined): Obj => {
    if (o && "organizationId" in o && o.organizationId !== organizationId) {
      throw new Error("organizationId divergente do contexto");
    }
    return { ...o, organizationId };
  };
  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const a = args as Obj;
          if (WHERE_OPS.has(operation))
            return query({ ...a, where: withOrg(a.where as Obj) });
          if (operation === "create")
            return query({ ...a, data: withOrg(a.data as Obj) });
          if (operation === "createMany") {
            const data = a.data as Obj | Obj[];
            return query({
              ...a,
              data: Array.isArray(data) ? data.map(withOrg) : withOrg(data),
            });
          }
          if (operation === "upsert") {
            return query({
              ...a,
              where: withOrg(a.where as Obj),
              create: withOrg(a.create as Obj),
            } as never);
          }
          throw new Error(`operação não suportada: ${model}.${operation}`); // lista fechada
        },
      },
    },
  });
}

async function twoTenants() {
  const a = await seedOrg(base, "A");
  const b = await seedOrg(base, "B");
  return { a, b, db: scoped(a.org.id) };
}

describe("V7 forTenant — operações de topo (cobertas)", () => {
  it("findMany/findFirst/count/aggregate/groupBy só enxergam o tenant do contexto", async () => {
    const { a, db } = await twoTenants();
    expect((await db.professional.findMany()).map((p) => p.id)).toEqual([
      a.professional.id,
    ]);
    expect(await db.professional.count()).toBe(1);
    expect((await db.appointment.aggregate({ _count: true }))._count).toBe(0);
    expect(
      await db.professional.groupBy({ by: ["organizationId"], _count: true }),
    ).toHaveLength(1);
  });

  it("findUnique por id de OUTRO tenant => null (where estendido é aceito pelo Prisma 7)", async () => {
    const { b, db } = await twoTenants();
    expect(
      await db.professional.findUnique({ where: { id: b.professional.id } }),
    ).toBeNull();
  });

  it("update/delete por id de outro tenant => P2025 (nada alterado)", async () => {
    const { b, db } = await twoTenants();
    await expect(
      db.professional.update({
        where: { id: b.professional.id },
        data: { name: "hack" },
      }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      db.professional.delete({ where: { id: b.professional.id } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(
      (await base.professional.findUnique({ where: { id: b.professional.id } }))
        ?.name,
    ).toBe("p");
  });

  it("updateMany/deleteMany ficam restritos ao tenant", async () => {
    const { a, b, db } = await twoTenants();
    await db.professional.updateMany({ data: { name: "novo" } });
    expect(
      (await base.professional.findUnique({ where: { id: a.professional.id } }))
        ?.name,
    ).toBe("novo");
    expect(
      (await base.professional.findUnique({ where: { id: b.professional.id } }))
        ?.name,
    ).toBe("p");
    await db.professional.deleteMany();
    expect(await base.professional.count()).toBe(1);
  });

  it("create injeta organizationId; valor divergente é rejeitado", async () => {
    const { a, b, db } = await twoTenants();
    const p = await db.professional.create({ data: { name: "novo" } as never });
    expect(p.organizationId).toBe(a.org.id);
    await expect(
      db.professional.create({ data: { name: "x", organizationId: b.org.id } }),
    ).rejects.toThrow("divergente");
  });

  it("createMany e upsert recebem o organizationId; upsert com where de outro tenant cria em vez de sobrescrever", async () => {
    const { a, b, db } = await twoTenants();
    await db.professional.createMany({
      data: [{ name: "1" }, { name: "2" }] as never,
    });
    expect(
      await base.professional.count({ where: { organizationId: a.org.id } }),
    ).toBe(3);
    const up = await db.professional
      .upsert({
        where: { id: b.professional.id },
        create: { name: "criado" } as never,
        update: { name: "sobrescrito" },
      })
      .catch((e) => e);
    // O profissional de B não foi sobrescrito (where escopado => não encontra => tenta criar com o MESMO id? não:
    // create não leva o id de B). Resultado esperado: nova linha em A e B intacto.
    expect(
      (await base.professional.findUnique({ where: { id: b.professional.id } }))
        ?.name,
    ).toBe("p");
    expect(up.organizationId).toBe(a.org.id);
  });

  it("operação fora da lista fechada lança erro (ex.: createManyAndReturn)", async () => {
    const { db } = await twoTenants();
    await expect(
      (
        db.professional as never as {
          createManyAndReturn: (a: unknown) => Promise<unknown>;
        }
      ).createManyAndReturn({
        data: [{ name: "x" }],
      }),
    ).rejects.toThrow("não suportada");
  });

  it("dentro de transação interativa o cliente estendido continua escopado", async () => {
    const { a, db } = await twoTenants();
    const ids = await db.$transaction(async (tx) =>
      (await tx.professional.findMany()).map((p) => p.id),
    );
    expect(ids).toEqual([a.professional.id]);
  });
});

describe("V7 forTenant — NÃO cobertas (o helper é redução de risco, não garantia)", () => {
  it("$queryRaw ignora a extensão e enxerga todos os tenants", async () => {
    const { db } = await twoTenants();
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM professionals`;
    expect(rows).toHaveLength(2);
  });

  it("filtro/include aninhado de relação NÃO é escopado pela extensão (a FK composta é a garantia)", async () => {
    const { a, db } = await twoTenants();
    await db.appointment.create({ data: appointmentData(a, 0) as never });
    const withRel = await db.appointment.findFirst({
      include: { professional: true },
    });
    expect(withRel?.professional.organizationId).toBe(a.org.id); // coerente só por causa da FK composta
  });

  it("escrita aninhada com connect para registro de outro tenant: o banco (FK composta) é quem barra", async () => {
    const { a, b } = await twoTenants();
    const d = appointmentData(a, 0);
    const err = await base.appointment
      .create({
        data: {
          startsAt: d.startsAt,
          endsAt: d.endsAt,
          blockedUntil: d.blockedUntil,
          durationMinutesSnapshot: 30,
          bufferMinutesSnapshot: 0,
          org: { connect: { id: a.org.id } },
          professional: {
            connect: {
              organizationId_id: {
                organizationId: b.org.id,
                id: b.professional.id,
              },
            },
          },
          service: {
            connect: {
              organizationId_id: { organizationId: a.org.id, id: a.service.id },
            },
          },
          customer: {
            connect: {
              organizationId_id: {
                organizationId: a.org.id,
                id: a.customer.id,
              },
            },
          },
        },
      })
      .catch((e) => e);
    console.info(
      "V7 nested connect error:",
      err.code,
      String(err.message).split("\n").pop(),
    );
    expect(err.code).toBe("P2003"); // FK composta barra o connect cruzado
    expect(await base.appointment.count()).toBe(0);
  });
});
