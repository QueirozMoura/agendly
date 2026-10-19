// Etapa 8 — profissionais (sem login) e vínculo com serviços: escopo por empresa, FKs compostas e concorrência.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { forTenant, TenantScopeError } from "../../src/lib/db/tenant.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  api,
  createOrg,
  freshSession,
  signupVerified,
  type TestUser,
} from "../support/orgs.ts";

let t: AuthTestApp;
let ana: TestUser;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(201);
});
afterEach(() => t.close());

type Pro = { id: string; name: string; active: boolean; serviceIds: string[] };
const post = (
  user: TestUser,
  body: unknown,
  headers: Record<string, string> = {},
) => api(t, "POST", "/api/professionals", user, body, headers);
const list = (user: TestUser, query = "") =>
  api(t, "GET", `/api/professionals${query}`, user);
const one = (user: TestUser, id: string) =>
  api(t, "GET", `/api/professionals/${id}`, user);
const patch = (user: TestUser, id: string, body: unknown) =>
  api(t, "PATCH", `/api/professionals/${id}`, user, body);
const link = (user: TestUser, id: string, serviceIds: unknown) =>
  api(t, "PUT", `/api/professionals/${id}/services`, user, { serviceIds });
const mkPro = async (user: TestUser, name = "Carla") =>
  (await post(user, { name })).json().professional as Pro;
const mkSvc = async (user: TestUser, name = "Corte") =>
  (
    await api(t, "POST", "/api/services", user, { name, durationMinutes: 30 })
  ).json().service as { id: string };

describe("criação, consulta e edição de profissionais", () => {
  it("cria sem conta de usuário, ativo e sem serviços, na empresa ativa da sessão", async () => {
    const res = await post(ana, { name: "  Carla Souza " });
    expect(res.statusCode).toBe(201);
    expect(res.json().professional).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Carla Souza",
      active: true,
      serviceIds: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    expect(
      (await t.prisma.professional.findFirstOrThrow()).organizationId,
    ).toBe(org.id);
    expect(JSON.stringify(res.json())).not.toContain(org.id);
    expect(await t.prisma.user.count()).toBe(1); // nenhum usuário foi criado para o profissional (D2)
  });

  it("entradas inválidas e campos proibidos (organizationId, userId, active, id) => 400", async () => {
    for (const body of [
      {},
      { name: "  " },
      { name: "x".repeat(101) },
      { name: 5 },
      { name: "A", organizationId: "00000000-0000-7000-8000-000000000000" },
      { name: "A", userId: ana.userId },
      { name: "A", active: false },
      { name: "A", id: "x" },
      { name: "A", services: [] },
    ]) {
      const res = await post(ana, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(await t.prisma.professional.count()).toBe(0);
  });

  it("lista por nome com filtro ?active=; detalhe; id malformado = inexistente (404 idêntico)", async () => {
    const b = await mkPro(ana, "Beto");
    await mkPro(ana, "Ana");
    await patch(ana, b.id, { active: false });
    expect(
      (await list(ana)).json().professionals.map((p: Pro) => p.name),
    ).toEqual(["Ana", "Beto"]);
    expect(
      (await list(ana, "?active=true"))
        .json()
        .professionals.map((p: Pro) => p.name),
    ).toEqual(["Ana"]);
    expect(
      (await list(ana, "?active=false"))
        .json()
        .professionals.map((p: Pro) => p.name),
    ).toEqual(["Beto"]);
    for (const q of ["?active=x", "?organizationId=x"])
      expect((await list(ana, q)).statusCode).toBe(400);
    expect((await one(ana, b.id)).json().professional).toMatchObject({
      id: b.id,
      active: false,
    });
    const missing = await one(ana, "00000000-0000-7000-8000-000000000000");
    const malformed = await one(ana, "xyz");
    expect([missing.statusCode, malformed.statusCode]).toEqual([404, 404]);
    expect({ ...missing.json().error, requestId: 0 }).toEqual({
      ...malformed.json().error,
      requestId: 0,
    });
  });

  it("edita e desativa/reativa sem apagar; corpo vazio ou campo proibido => 400 e nada muda", async () => {
    const p = await mkPro(ana);
    expect(
      (await patch(ana, p.id, { name: " Carla Nova " })).json().professional
        .name,
    ).toBe("Carla Nova");
    expect(
      (await patch(ana, p.id, { active: false })).json().professional.active,
    ).toBe(false);
    expect(
      (await patch(ana, p.id, { active: true })).json().professional.active,
    ).toBe(true);
    for (const body of [
      {},
      { name: "" },
      { active: "sim" },
      { organizationId: "x" },
      { userId: ana.userId },
      { name: "ok", extra: 1 },
    ]) {
      expect(
        (await patch(ana, p.id, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(await t.prisma.professional.count()).toBe(1);
    expect((await one(ana, p.id)).json().professional.name).toBe("Carla Nova");
  });

  it("sem sessão => 401; sem empresa ativa => 403; escrita sem Origin => 403; X-Active-Org divergente => 409", async () => {
    const id = "00000000-0000-7000-8000-000000000001";
    for (const [m, u, b] of [
      ["GET", "/api/professionals"],
      ["POST", "/api/professionals", { name: "x" }],
      ["GET", `/api/professionals/${id}`],
      ["PATCH", `/api/professionals/${id}`, { name: "x" }],
      ["PUT", `/api/professionals/${id}/services`, { serviceIds: [] }],
    ] as const) {
      expect((await api(t, m, u, undefined, b)).statusCode, `${m} ${u}`).toBe(
        401,
      );
    }
    const fresh = {
      ...(await freshSession(t, "ana@example.com")),
      email: "ana@example.com",
      userId: ana.userId,
    };
    expect((await list(fresh)).json().error.code).toBe(
      "NO_ACTIVE_ORGANIZATION",
    );
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/api/professionals",
      headers: { cookie: ana.cookie, "content-type": "application/json" },
      payload: '{"name":"x"}',
    });
    expect(noOrigin.statusCode).toBe(403);
    await createOrg(t, ana, "segunda-empresa");
    const stale = await post(
      ana,
      { name: "x" },
      { "x-active-org": "salao-da-ana" },
    );
    expect(stale.statusCode).toBe(409);
    expect(await t.prisma.professional.count()).toBe(0);
  });

  it("limite de criação: a 121ª na janela => 429", async () => {
    for (let i = 0; i < 120; i++)
      expect((await post(ana, { name: `P${i}` })).statusCode).toBe(201);
    expect((await post(ana, { name: "excedente" })).statusCode).toBe(429);
    expect(await t.prisma.professional.count()).toBe(120);
  }, 60_000);
});

describe("PUT /api/professionals/:id/services — vínculo com serviços", () => {
  it("define, amplia, reduz e esvazia o conjunto; os ids aparecem no detalhe e na lista", async () => {
    const p = await mkPro(ana);
    const [s1, s2, s3] = [
      await mkSvc(ana, "A"),
      await mkSvc(ana, "B"),
      await mkSvc(ana, "C"),
    ];
    const ids = (r: { json(): { professional: Pro } }) =>
      r.json().professional.serviceIds.sort();
    expect(ids(await link(ana, p.id, [s1.id, s2.id]))).toEqual(
      [s1.id, s2.id].sort(),
    );
    expect(ids(await link(ana, p.id, [s2.id, s3.id]))).toEqual(
      [s2.id, s3.id].sort(),
    );
    expect(
      (await one(ana, p.id)).json().professional.serviceIds.sort(),
    ).toEqual([s2.id, s3.id].sort());
    expect((await list(ana)).json().professionals[0].serviceIds.sort()).toEqual(
      [s2.id, s3.id].sort(),
    );
    expect(ids(await link(ana, p.id, []))).toEqual([]);
    expect(await t.prisma.professionalService.count()).toBe(0);
  });

  it("é idempotente e ignora ids repetidos; serviço inativo pode ser vinculado; profissional inativo também", async () => {
    const p = await mkPro(ana);
    const s = await mkSvc(ana);
    await api(t, "PATCH", `/api/services/${s.id}`, ana, { active: false });
    await patch(ana, p.id, { active: false });
    for (let i = 0; i < 2; i++)
      expect((await link(ana, p.id, [s.id, s.id])).statusCode).toBe(200);
    expect(await t.prisma.professionalService.count()).toBe(1);
  });

  it("serviço de OUTRA empresa ou inexistente => 404 e NADA é aplicado (nem os serviços válidos da mesma chamada)", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const p = await mkPro(ana);
    const mine = await mkSvc(ana, "Meu");
    const theirs = await mkSvc(bob, "Dele");
    await link(ana, p.id, [mine.id]);
    for (const ids of [
      [theirs.id],
      [mine.id, theirs.id],
      ["00000000-0000-7000-8000-000000000000"],
    ]) {
      const res = await link(ana, p.id, ids);
      expect(res.statusCode, JSON.stringify(ids)).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }
    expect((await one(ana, p.id)).json().professional.serviceIds).toEqual([
      mine.id,
    ]); // conjunto anterior intacto
    expect(await t.prisma.professionalService.count()).toBe(1);
  });

  it("profissional de outra empresa ou inexistente => 404", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const theirs = await mkPro(bob);
    const mine = await mkSvc(ana);
    for (const id of [
      theirs.id,
      "00000000-0000-7000-8000-000000000000",
      "xyz",
    ]) {
      expect((await link(ana, id, [mine.id])).statusCode, id).toBe(404);
    }
    expect(await t.prisma.professionalService.count()).toBe(0);
  });

  it("corpo inválido => 400: serviceIds ausente/malformado/repetido demais/campos extras", async () => {
    const p = await mkPro(ana);
    for (const body of [
      {},
      { serviceIds: "x" },
      { serviceIds: ["nao-uuid"] },
      { serviceIds: [1] },
      {
        serviceIds: Array.from(
          { length: 201 },
          (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
        ),
      },
      { serviceIds: [], organizationId: "x" },
      { serviceIds: [], professionalId: p.id },
    ]) {
      expect(
        (await api(t, "PUT", `/api/professionals/${p.id}/services`, ana, body))
          .statusCode,
        JSON.stringify(body).slice(0, 80),
      ).toBe(400);
    }
  });

  it("PUTs simultâneos com conjuntos diferentes terminam com EXATAMENTE um dos conjuntos (nunca a união)", async () => {
    const p = await mkPro(ana);
    const svcs = await Promise.all(
      ["A", "B", "C", "D", "E", "F"].map((n) => mkSvc(ana, n)),
    );
    const setA = svcs
      .slice(0, 3)
      .map((s) => s.id)
      .sort();
    const setB = svcs
      .slice(3)
      .map((s) => s.id)
      .sort();
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all([
        link(ana, p.id, setA),
        link(ana, p.id, setB),
        link(ana, p.id, setA),
        link(ana, p.id, setB),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      const final = (
        await t.prisma.professionalService.findMany({
          where: { professionalId: p.id },
        })
      )
        .map((l) => l.serviceId)
        .sort();
      expect([JSON.stringify(setA), JSON.stringify(setB)]).toContain(
        JSON.stringify(final),
      );
    }
  });

  it("vínculo e desativação do profissional simultâneos não se perdem", async () => {
    const p = await mkPro(ana);
    const s = await mkSvc(ana);
    const [a, b] = await Promise.all([
      link(ana, p.id, [s.id]),
      patch(ana, p.id, { active: false }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const pro = (await one(ana, p.id)).json().professional as Pro;
    expect(pro).toMatchObject({ active: false, serviceIds: [s.id] });
  });
});

describe("integridade no banco (FKs compostas)", () => {
  async function twoOrgs() {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const [pa, pb] = [await mkPro(ana), await mkPro(bob)];
    const [sa, sb] = [await mkSvc(ana), await mkSvc(bob)];
    const [oa, ob] = await Promise.all(
      ["salao-da-ana", "barbearia-bob"].map((slug) =>
        t.prisma.organization.findUniqueOrThrow({ where: { slug } }),
      ),
    );
    return { pa, pb, sa, sb, oa: oa!, ob: ob! };
  }

  it("SQL cru: vincular profissional de uma empresa a serviço de outra falha por FK composta, nas duas direções", async () => {
    const { pa, pb, sa, sb, oa, ob } = await twoOrgs();
    const c = await rawClient(TEST_DB);
    const ins = (org: string, p: string, s: string) =>
      c
        .query(
          "INSERT INTO professional_services (organization_id, professional_id, service_id) VALUES ($1, $2, $3)",
          [org, p, s],
        )
        .catch((e) => e as { code: string; constraint: string });
    const results = [
      await ins(oa.id, pa.id, sb.id), // serviço de B na empresa A
      await ins(oa.id, pb.id, sa.id), // profissional de B na empresa A
      await ins(ob.id, pa.id, sb.id), // profissional de A na empresa B
      await ins(ob.id, pb.id, sa.id), // serviço de A na empresa B
    ];
    const ok = await ins(oa.id, pa.id, sa.id);
    await c.end();
    expect(results.map((r) => (r as { code: string }).code)).toEqual([
      "23503",
      "23503",
      "23503",
      "23503",
    ]);
    expect(
      results.map((r) => (r as { constraint: string }).constraint),
    ).toEqual([
      "professional_services_organization_id_service_id_fkey",
      "professional_services_organization_id_professional_id_fkey",
      "professional_services_organization_id_professional_id_fkey",
      "professional_services_organization_id_service_id_fkey",
    ]);
    expect((ok as { rowCount: number }).rowCount).toBe(1);
  });

  it("pelo Prisma (cliente sem escopo) o mesmo cruzamento também falha com violação de FK", async () => {
    const { pa, sb, oa } = await twoOrgs();
    const err = await t.prisma.professionalService
      .create({
        data: {
          organizationId: oa.id,
          professionalId: pa.id,
          serviceId: sb.id,
        },
      })
      .catch((e) => e);
    expect(classifyDbError(err)).toBe("foreign_key_violation");
  });

  it("vínculo duplicado viola a PK; FKs são RESTRICT/RESTRICT (nunca SET NULL) e protegem profissional e serviço", async () => {
    const { pa, sa, oa } = await twoOrgs();
    await link(ana, pa.id, [sa.id]);
    const dup = await t.prisma.professionalService
      .create({
        data: {
          organizationId: oa.id,
          professionalId: pa.id,
          serviceId: sa.id,
        },
      })
      .catch((e) => e);
    expect(classifyDbError(dup)).toBe("unique_violation");
    expect(
      classifyDbError(await t.prisma.professional.deleteMany().catch((e) => e)),
    ).toBe("foreign_key_violation");
    expect(
      classifyDbError(await t.prisma.service.deleteMany().catch((e) => e)),
    ).toBe("foreign_key_violation");
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'professional_services'::regclass AND contype = 'f' ORDER BY conname`,
    );
    const { rows: idx } = await c.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'professionals' AND indexdef ILIKE '%UNIQUE%(organization_id, id)%'`,
    );
    await c.end();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.def).toContain("(organization_id,");
      expect(r.def).toContain("ON UPDATE RESTRICT ON DELETE RESTRICT");
      expect(r.def).not.toContain("SET NULL");
    }
    expect(idx).toHaveLength(1);
  });
});

describe("forTenant() com Professional e ProfessionalService", () => {
  it("o cliente escopado só enxerga/altera a própria empresa e rejeita organizationId divergente", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const [pa, pb, sb] = [await mkPro(ana), await mkPro(bob), await mkSvc(bob)];
    await link(bob, pb.id, [sb.id]);
    const oa = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const ob = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "barbearia-bob" },
    });
    const db = forTenant(t.prisma, oa.id);
    expect((await db.professional.findMany()).map((p) => p.id)).toEqual([
      pa.id,
    ]);
    expect(await db.professionalService.findMany()).toEqual([]);
    expect(
      (
        await db.professionalService.deleteMany({
          where: { professionalId: pb.id },
        })
      ).count,
    ).toBe(0);
    await expect(
      db.professional.update({ where: { id: pb.id }, data: { name: "x" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      db.professionalService.createMany({
        data: [
          { organizationId: ob.id, professionalId: pb.id, serviceId: sb.id },
        ],
      }),
    ).rejects.toThrow(TenantScopeError);
    expect(await t.prisma.professionalService.count()).toBe(1);
  });
});
