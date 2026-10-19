// Etapa 7 — CRUD de serviços (escopado por empresa, somente OWNER da empresa ativa).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { forTenant } from "../../src/lib/db/tenant.ts";
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

const newService = (extra: Record<string, unknown> = {}) => ({
  name: "Corte",
  durationMinutes: 30,
  ...extra,
});
const post = (
  user: TestUser,
  body: unknown,
  headers: Record<string, string> = {},
) => api(t, "POST", "/api/services", user, body, headers);
const list = (user: TestUser, query = "") =>
  api(t, "GET", `/api/services${query}`, user);
const one = (user: TestUser, id: string) =>
  api(t, "GET", `/api/services/${id}`, user);
const patch = (
  user: TestUser,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
) => api(t, "PATCH", `/api/services/${id}`, user, body, headers);
const create = async (user: TestUser, extra: Record<string, unknown> = {}) =>
  (await post(user, newService(extra))).json().service as { id: string };

describe("POST /api/services — criação", () => {
  it("cria com padrões (buffer 0, ativo, sem preço) na empresa ativa da sessão", async () => {
    const res = await post(ana, newService({ name: "  Corte de cabelo " }));
    expect(res.statusCode).toBe(201);
    expect(res.json().service).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Corte de cabelo",
      durationMinutes: 30,
      bufferMinutes: 0,
      priceCents: null,
      active: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const row = await t.prisma.service.findFirstOrThrow();
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    expect(row.organizationId).toBe(org.id); // a empresa veio da sessão
    expect(JSON.stringify(res.json())).not.toContain(org.id); // e o id da empresa não vaza
  });

  it("aceita buffer, preço e duração fora da grade de 15 min (D5)", async () => {
    const res = await post(
      ana,
      newService({ durationMinutes: 47, bufferMinutes: 10, priceCents: 8990 }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().service).toMatchObject({
      durationMinutes: 47,
      bufferMinutes: 10,
      priceCents: 8990,
    });
  });

  it("limites aceitos nas fronteiras", async () => {
    for (const extra of [
      { durationMinutes: 1 },
      { durationMinutes: 1440 },
      { bufferMinutes: 1440 },
      { priceCents: 0 },
      { priceCents: 100_000_000 },
      { name: "x".repeat(100) },
    ]) {
      expect(
        (await post(ana, newService(extra))).statusCode,
        JSON.stringify(extra),
      ).toBe(201);
    }
  });

  it("entradas inválidas => 400 VALIDATION_ERROR com o campo apontado, nada é criado", async () => {
    const bad: Array<[string, Record<string, unknown>, string]> = [
      ["nome vazio", newService({ name: "   " }), "name"],
      ["nome longo", newService({ name: "x".repeat(101) }), "name"],
      ["nome ausente", { durationMinutes: 30 }, "name"],
      ["duração zero", newService({ durationMinutes: 0 }), "durationMinutes"],
      [
        "duração negativa",
        newService({ durationMinutes: -5 }),
        "durationMinutes",
      ],
      [
        "duração fracionada",
        newService({ durationMinutes: 30.5 }),
        "durationMinutes",
      ],
      [
        "duração acima do teto",
        newService({ durationMinutes: 1441 }),
        "durationMinutes",
      ],
      [
        "duração como texto",
        newService({ durationMinutes: "30" }),
        "durationMinutes",
      ],
      ["duração ausente", { name: "Corte" }, "durationMinutes"],
      ["buffer negativo", newService({ bufferMinutes: -1 }), "bufferMinutes"],
      [
        "buffer fracionado",
        newService({ bufferMinutes: 0.5 }),
        "bufferMinutes",
      ],
      [
        "buffer acima do teto",
        newService({ bufferMinutes: 1441 }),
        "bufferMinutes",
      ],
      ["preço negativo", newService({ priceCents: -1 }), "priceCents"],
      ["preço fracionado", newService({ priceCents: 10.5 }), "priceCents"],
      [
        "preço acima do teto",
        newService({ priceCents: 100_000_001 }),
        "priceCents",
      ],
      ["preço como texto", newService({ priceCents: "10" }), "priceCents"],
    ];
    for (const [label, body, field] of bad) {
      const res = await post(ana, body);
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error.code, label).toBe("VALIDATION_ERROR");
      expect(
        res
          .json()
          .error.details.some((d: { path: string }) => d.path === field),
        label,
      ).toBe(true);
    }
    expect(await t.prisma.service.count()).toBe(0);
  });

  it("campos não permitidos (organizationId, id, active, createdAt, role...) => 400", async () => {
    for (const extra of [
      { organizationId: "00000000-0000-7000-8000-000000000000" },
      { id: "00000000-0000-7000-8000-000000000000" },
      { active: false },
      { createdAt: "2020-01-01T00:00:00Z" },
      { organization: { connect: { id: "x" } } },
      { professionals: [] },
    ]) {
      expect(
        (await post(ana, newService(extra))).statusCode,
        JSON.stringify(extra),
      ).toBe(400);
    }
    expect(await t.prisma.service.count()).toBe(0);
  });

  it("limite de criação: a 121ª na janela => 429", async () => {
    // Insere 120 pelo cliente escopado (rápido) e usa a API para exceder o contador do limitador.
    for (let i = 0; i < 120; i++)
      expect((await post(ana, newService({ name: `S${i}` }))).statusCode).toBe(
        201,
      );
    const res = await post(ana, newService({ name: "excedente" }));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(await t.prisma.service.count()).toBe(120);
  }, 60_000);
});

describe("autenticação, empresa ativa e CSRF", () => {
  it("sem sessão => 401 em todas as rotas de serviços", async () => {
    const id = "00000000-0000-7000-8000-000000000001";
    for (const [method, url, body] of [
      ["GET", "/api/services"],
      ["POST", "/api/services", newService()],
      ["GET", `/api/services/${id}`],
      ["PATCH", `/api/services/${id}`, { name: "x" }],
    ] as const) {
      const res = await api(t, method, url, undefined, body);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("sessão sem empresa ativa => 403 NO_ACTIVE_ORGANIZATION", async () => {
    const fresh = {
      ...(await freshSession(t, "ana@example.com")),
      email: "ana@example.com",
      userId: ana.userId,
    };
    for (const res of [await list(fresh), await post(fresh, newService())]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("NO_ACTIVE_ORGANIZATION");
    }
    expect(await t.prisma.service.count()).toBe(0);
  });

  it("escrita exige Origin permitido e JSON", async () => {
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie: ana.cookie, "content-type": "application/json" },
      payload: JSON.stringify(newService()),
    });
    expect(noOrigin.statusCode).toBe(403);
    const text = await t.app.inject({
      method: "POST",
      url: "/api/services",
      headers: {
        cookie: ana.cookie,
        origin: "http://localhost:5173",
        "content-type": "text/plain",
      },
      payload: "x",
    });
    expect(text.statusCode).toBe(415);
    expect(await t.prisma.service.count()).toBe(0);
  });

  it("X-Active-Org divergente => 409 e nada é criado/alterado", async () => {
    await createOrg(t, ana, "segunda-empresa"); // vira a ativa
    const stale = await post(ana, newService(), {
      "x-active-org": "salao-da-ana",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("ACTIVE_ORG_CHANGED");
    expect(await t.prisma.service.count()).toBe(0);
    expect(
      (await post(ana, newService(), { "x-active-org": "segunda-empresa" }))
        .statusCode,
    ).toBe(201);
  });
});

describe("GET /api/services e /api/services/:id", () => {
  it("lista ordenada por nome; filtro ?active=; query desconhecida => 400", async () => {
    const b = await create(ana, { name: "Barba" });
    await create(ana, { name: "Corte" });
    await create(ana, { name: "Alisamento" });
    await patch(ana, b.id, { active: false });
    const all = (await list(ana))
      .json()
      .services.map((s: { name: string }) => s.name);
    expect(all).toEqual(["Alisamento", "Barba", "Corte"]);
    expect(
      (await list(ana, "?active=true"))
        .json()
        .services.map((s: { name: string }) => s.name),
    ).toEqual(["Alisamento", "Corte"]);
    expect(
      (await list(ana, "?active=false"))
        .json()
        .services.map((s: { name: string }) => s.name),
    ).toEqual(["Barba"]);
    for (const q of ["?active=talvez", "?organizationId=x", "?foo=1"]) {
      expect((await list(ana, q)).statusCode, q).toBe(400);
    }
  });

  it("detalhe de um serviço; id malformado, inexistente => 404 idêntico", async () => {
    const s = await create(ana);
    expect((await one(ana, s.id)).json().service).toMatchObject({
      id: s.id,
      name: "Corte",
    });
    const missing = await one(ana, "00000000-0000-7000-8000-000000000000");
    const malformed = await one(ana, "nao-e-uuid");
    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect({ ...missing.json().error, requestId: 0 }).toEqual({
      ...malformed.json().error,
      requestId: 0,
    });
  });
});

describe("PATCH /api/services/:id — editar e ativar/desativar", () => {
  it("edita campos, aceita atualização parcial e remove o preço com null", async () => {
    const s = await create(ana, { priceCents: 5000, bufferMinutes: 5 });
    const res = await patch(ana, s.id, {
      name: " Corte novo ",
      durationMinutes: 45,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toMatchObject({
      name: "Corte novo",
      durationMinutes: 45,
      bufferMinutes: 5,
      priceCents: 5000,
    });
    expect(
      (await patch(ana, s.id, { priceCents: null })).json().service.priceCents,
    ).toBeNull();
    expect(
      (await patch(ana, s.id, { bufferMinutes: 0 })).json().service
        .bufferMinutes,
    ).toBe(0);
  });

  it("desativa e reativa (sem DELETE: R-c); o registro e o id permanecem", async () => {
    const s = await create(ana);
    expect(
      (await patch(ana, s.id, { active: false })).json().service.active,
    ).toBe(false);
    expect(await t.prisma.service.count()).toBe(1);
    expect(
      (await patch(ana, s.id, { active: true })).json().service.active,
    ).toBe(true);
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/api/services/${s.id}`,
          headers: {
            cookie: ana.cookie,
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("corpo vazio, valores inválidos e campos não permitidos => 400 e nada muda", async () => {
    const s = await create(ana);
    for (const body of [
      {},
      { name: "" },
      { durationMinutes: 0 },
      { bufferMinutes: -1 },
      { priceCents: -5 },
      { active: "sim" },
      { organizationId: "00000000-0000-7000-8000-000000000000" },
      { id: "00000000-0000-7000-8000-000000000000" },
      { createdAt: "2020-01-01T00:00:00Z" },
      { name: "ok", unknown: 1 },
    ]) {
      expect(
        (await patch(ana, s.id, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await one(ana, s.id)).json().service).toMatchObject({
      name: "Corte",
      durationMinutes: 30,
    });
  });

  it("edições simultâneas de campos DIFERENTES não se sobrescrevem", async () => {
    const s = await create(ana);
    const results = await Promise.all([
      patch(ana, s.id, { name: "Nome novo" }),
      patch(ana, s.id, { durationMinutes: 90 }),
      patch(ana, s.id, { priceCents: 1234 }),
      patch(ana, s.id, { active: false }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await one(ana, s.id)).json().service).toMatchObject({
      name: "Nome novo",
      durationMinutes: 90,
      priceCents: 1234,
      active: false,
    });
  });
});

describe("OWNER de duas empresas", () => {
  it("cada empresa vê e altera só os próprios serviços; id de uma não vale na outra", async () => {
    const s1 = await create(ana, { name: "Da primeira" });
    await createOrg(t, ana, "segunda-empresa");
    const s2 = await create(ana, { name: "Da segunda" });
    expect(
      (await list(ana)).json().services.map((s: { name: string }) => s.name),
    ).toEqual(["Da segunda"]);
    expect((await one(ana, s1.id)).statusCode).toBe(404);
    expect((await patch(ana, s1.id, { name: "invasor" })).statusCode).toBe(404);
    await api(t, "POST", "/api/session/active-organization", ana, {
      slug: "salao-da-ana",
    });
    expect(
      (await list(ana)).json().services.map((s: { name: string }) => s.name),
    ).toEqual(["Da primeira"]);
    expect((await one(ana, s2.id)).statusCode).toBe(404);
    expect(
      (await t.prisma.service.findMany({ orderBy: { name: "asc" } })).map(
        (s) => s.name,
      ),
    ).toEqual(["Da primeira", "Da segunda"]);
  });
});

describe("forTenant() e banco com o modelo Service", () => {
  it("cliente escopado não lê, altera nem apaga serviço de outra empresa", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-do-bob");
    const mine = await create(ana);
    const theirs = await create(bob);
    const orgA = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "salao-da-ana" },
      })
    ).id;
    const db = forTenant(t.prisma, orgA);
    expect((await db.service.findMany()).map((s) => s.id)).toEqual([mine.id]);
    expect(
      await db.service.findUnique({ where: { id: theirs.id } }),
    ).toBeNull();
    await expect(
      db.service.update({ where: { id: theirs.id }, data: { name: "x" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(
      (
        await db.service.updateMany({
          where: { id: theirs.id },
          data: { name: "x" },
        })
      ).count,
    ).toBe(0);
    expect(
      (await db.service.deleteMany({ where: { id: theirs.id } })).count,
    ).toBe(0);
    expect(
      (await t.prisma.service.findUniqueOrThrow({ where: { id: theirs.id } }))
        .name,
    ).toBe("Corte");
  });

  it("CHECKs do banco recusam duração < 1, buffer < 0 e preço < 0 mesmo por SQL cru", async () => {
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const c = await rawClient(TEST_DB);
    const ins = (d: number, b: number, p: number | null) =>
      c
        .query(
          `INSERT INTO services (id, organization_id, name, duration_minutes, buffer_minutes, price_cents, updated_at) VALUES (gen_random_uuid(), $1, 'x', $2, $3, $4, now())`,
          [org.id, d, b, p],
        )
        .catch((e) => e as { code: string; constraint: string });
    const results = [
      await ins(0, 0, null),
      await ins(30, -1, null),
      await ins(30, 0, -1),
    ];
    const ok = await ins(1, 0, 0);
    await c.end();
    expect(
      results.map((r) => (r as { constraint: string }).constraint),
    ).toEqual([
      "services_duration_positive",
      "services_buffer_non_negative",
      "services_price_non_negative",
    ]);
    expect((ok as { rowCount: number }).rowCount).toBe(1);
  });

  it("alvo das FKs compostas das próximas etapas existe: UNIQUE (organization_id, id)", async () => {
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'services' AND indexdef ILIKE '%UNIQUE%(organization_id, id)%'`,
    );
    await c.end();
    expect(rows).toHaveLength(1);
  });

  it("não se apaga empresa com serviços (RESTRICT) e a FK é RESTRICT/RESTRICT, nunca SET NULL", async () => {
    await create(ana);
    const err = await t.prisma.organization.deleteMany().catch((e) => e);
    expect(classifyDbError(err)).toBe("foreign_key_violation");
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'services_organization_id_fkey'`,
    );
    await c.end();
    expect(rows[0].def).toContain("ON UPDATE RESTRICT ON DELETE RESTRICT");
  });
});
