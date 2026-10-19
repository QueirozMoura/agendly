// Etapa 6 — empresas: criação atômica com OWNER, consulta, configurações, troca de empresa ativa e constraints.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/lib/db/client.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
import {
  makeAuthApp,
  post,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  api,
  createOrg,
  freshSession,
  orgInput,
  signupUnverified,
  signupVerified,
} from "../support/orgs.ts";

let t: AuthTestApp;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const get = (user: { cookie: string }, headers: Record<string, string> = {}) =>
  api(t, "GET", "/api/organization", user, undefined, headers);
const patch = (
  user: { cookie: string },
  body: unknown,
  headers: Record<string, string> = {},
) => api(t, "PATCH", "/api/organization", user, body, headers);

describe("POST /api/organizations — criação", () => {
  it("cria a empresa + membership OWNER + empresa ativa da sessão, e não expõe o id interno", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const res = await createOrg(t, ana, "salao-da-ana", {
      timezone: "america/sao_paulo",
      name: "  Salão da Ana ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().organization).toEqual({
      name: "Salão da Ana",
      slug: "salao-da-ana",
      timezone: "America/Sao_Paulo", // nome IANA canônico
      status: "ACTIVE",
      publishedAt: null,
      publicMinNoticeMinutes: 120,
      publicMaxAdvanceDays: 60,
      publicMaxActiveBookingsPerPhone: 3,
      createdAt: expect.any(String),
      role: "OWNER",
    });

    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const memberships = await t.prisma.membership.findMany();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      userId: ana.userId,
      organizationId: org.id,
      role: "OWNER",
    });
    expect(
      (await t.prisma.session.findFirstOrThrow()).activeOrganizationId,
    ).toBe(org.id);
    expect(JSON.stringify(res.json())).not.toContain(org.id);
  });

  it("e-mail não verificado => 403 EMAIL_NOT_VERIFIED e nada é criado (R10)", async () => {
    const bob = await signupUnverified(t, "bob@example.com");
    const res = await createOrg(t, bob, "empresa-do-bob");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await t.prisma.organization.count()).toBe(0);
    expect(await t.prisma.membership.count()).toBe(0);
  });

  it("sem sessão => 401 em todas as rotas de empresa", async () => {
    const calls: Array<[string, string, unknown?]> = [
      ["POST", "/api/organizations", orgInput("sem-sessao")],
      ["GET", "/api/organizations"],
      ["POST", "/api/session/active-organization", { slug: "x" }],
      ["GET", "/api/organization"],
      ["PATCH", "/api/organization", { name: "x" }],
    ];
    for (const [method, url, body] of calls) {
      const res = await api(t, method as "GET", url, undefined, body);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }
    expect(await t.prisma.organization.count()).toBe(0);
  });

  it("entradas inválidas => 400 VALIDATION_ERROR e nada é criado", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const base = orgInput("empresa-valida");
    const bad: Array<[string, Record<string, unknown>]> = [
      ["nome vazio", { ...base, name: "  " }],
      ["nome longo", { ...base, name: "x".repeat(101) }],
      ["slug curto", { ...base, slug: "ab" }],
      ["slug longo", { ...base, slug: "a".repeat(41) }],
      ["slug com espaço", { ...base, slug: "com espaco" }],
      ["slug com acento", { ...base, slug: "açaí-bar" }],
      ["slug com hífen no início", { ...base, slug: "-abc" }],
      ["slug com hífen no fim", { ...base, slug: "abc-" }],
      ["slug com hífen repetido", { ...base, slug: "a--b" }],
      ["slug com barra", { ...base, slug: "a/b" }],
      ["slug reservado", { ...base, slug: "api" }],
      ["slug reservado (marca)", { ...base, slug: "Agendly" }],
      ["fuso inválido", { ...base, timezone: "Mars/Phobos" }],
      ["fuso como deslocamento", { ...base, timezone: "+03:00" }],
      ["fuso abreviado", { ...base, timezone: "EST" }],
      ["fuso vazio", { ...base, timezone: "" }],
      ["fuso ausente", { name: base.name, slug: base.slug }],
      ["nome não é texto", { ...base, name: 42 }],
    ];
    for (const [label, body] of bad) {
      const res = await api(t, "POST", "/api/organizations", ana, body);
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error.code, label).toBe("VALIDATION_ERROR");
    }
    expect(await t.prisma.organization.count()).toBe(0);
  });

  it("campos não permitidos (organizationId, role, status, publishedAt, id, limites) => 400", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    for (const extra of [
      { organizationId: "00000000-0000-7000-8000-000000000000" },
      { id: "00000000-0000-7000-8000-000000000000" },
      { role: "OWNER" },
      { userId: ana.userId },
      { status: "ACTIVE" },
      { publishedAt: "2020-01-01T00:00:00Z" },
      { publicMaxActiveBookingsPerPhone: 99 },
      { memberships: [] },
    ]) {
      const res = await createOrg(t, ana, "empresa-extra", extra);
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await t.prisma.organization.count()).toBe(0);
  });

  it("endereço (slug) duplicado, inclusive com outra caixa, e por outro usuário => 409 SLUG_UNAVAILABLE", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
    for (const [user, slug] of [
      [ana, "salao"],
      [bob, "salao"],
      [bob, "SALAO"],
    ] as const) {
      const res = await createOrg(t, user, slug);
      expect(res.statusCode, slug).toBe(409);
      expect(res.json().error.code).toBe("SLUG_UNAVAILABLE");
    }
    expect(await t.prisma.organization.count()).toBe(1);
    expect(await t.prisma.membership.count()).toBe(1);
  });

  it("criações simultâneas do mesmo slug => exatamente uma vence, sem membership órfã", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    const [a, b] = await Promise.all([
      createOrg(t, ana, "disputado"),
      createOrg(t, bob, "disputado"),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await t.prisma.organization.count()).toBe(1);
    expect(await t.prisma.membership.count()).toBe(1);
  });

  it("um usuário pode ser OWNER de várias empresas (D1)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-um");
    await createOrg(t, ana, "empresa-dois");
    expect(
      await t.prisma.membership.count({
        where: { userId: ana.userId, role: "OWNER" },
      }),
    ).toBe(2);
  });

  it("limite de criação: a 6ª empresa na janela => 429", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    for (let i = 0; i < 5; i++)
      expect((await createOrg(t, ana, `empresa-${i}x`)).statusCode).toBe(201);
    const res = await createOrg(t, ana, "empresa-extra");
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("atomicidade da criação (organização + membership OWNER + empresa ativa)", () => {
  const failing = (model: "membership" | "session") => (p: PrismaClient) =>
    p.$extends({
      query: {
        [model]: {
          async create({
            args,
            query,
          }: {
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) {
            await query(args); // o INSERT chega a ocorrer dentro da transação...
            throw new Error(`falha injetada em ${model}.create`);
          },
          async update({
            args,
            query,
          }: {
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) {
            await query(args);
            throw new Error(`falha injetada em ${model}.update`);
          },
        },
      } as never,
    }) as unknown as PrismaClient;

  for (const model of ["membership", "session"] as const) {
    it(`falha em ${model} => nenhuma empresa, nenhuma membership e sessão sem empresa ativa`, async () => {
      const ana = await signupVerified(t, "ana@example.com");
      await t.close();
      t = await makeAuthApp({ wrapPrisma: failing(model) }); // a sessão da Ana continua válida no banco
      const res = await createOrg(t, ana, "empresa-falha");
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
      expect(await t.prisma.organization.count()).toBe(0); // ...e o rollback desfaz o que já tinha sido inserido
      expect(await t.prisma.membership.count()).toBe(0);
      expect(
        (await t.prisma.session.findFirstOrThrow()).activeOrganizationId,
      ).toBeNull();
    });
  }
});

describe("GET /api/organizations e troca de empresa ativa", () => {
  it("lista só as empresas do próprio usuário e informa a ativa pelo slug", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, ana, "empresa-um");
    await createOrg(t, ana, "empresa-dois");
    await createOrg(t, bob, "empresa-bob");
    const res = await api(t, "GET", "/api/organizations", ana);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().organizations.map((o: { slug: string }) => o.slug),
    ).toEqual(["empresa-um", "empresa-dois"]);
    expect(res.json().activeSlug).toBe("empresa-dois"); // a última criada vira a ativa
    expect(JSON.stringify(res.json())).not.toContain("empresa-bob");
  });

  it("trocar para uma empresa própria muda a empresa ativa da sessão", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-um");
    await createOrg(t, ana, "empresa-dois");
    const res = await api(t, "POST", "/api/session/active-organization", ana, {
      slug: "EMPRESA-UM",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().organization).toMatchObject({
      slug: "empresa-um",
      role: "OWNER",
    });
    expect((await get(ana)).json().organization.slug).toBe("empresa-um");
  });

  it("trocar para empresa de OUTRO usuário e para uma inexistente dá a MESMA resposta 404", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, ana, "empresa-ana");
    await createOrg(t, bob, "empresa-bob");
    const before = (
      await t.prisma.session.findMany({ where: { userId: ana.userId } })
    )[0]?.activeOrganizationId;
    const other = await api(
      t,
      "POST",
      "/api/session/active-organization",
      ana,
      { slug: "empresa-bob" },
    );
    const none = await api(t, "POST", "/api/session/active-organization", ana, {
      slug: "nao-existe",
    });
    expect(other.statusCode).toBe(404);
    expect({ ...other.json().error, requestId: 0 }).toEqual({
      ...none.json().error,
      requestId: 0,
    });
    expect(other.json().error.code).toBe("NOT_FOUND");
    expect(
      (await t.prisma.session.findMany({ where: { userId: ana.userId } }))[0]
        ?.activeOrganizationId,
    ).toBe(before);
  });

  it("corpo com organizationId ou campo extra => 400", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    for (const body of [
      { slug: "empresa-ana", organizationId: "x" },
      { organizationId: "x" },
      {},
    ]) {
      expect(
        (await api(t, "POST", "/api/session/active-organization", ana, body))
          .statusCode,
      ).toBe(400);
    }
  });

  it("sessão nova (sem empresa ativa): rotas de empresa ativa => 403 NO_ACTIVE_ORGANIZATION até escolher", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const fresh = await freshSession(t, "ana@example.com");
    for (const res of [await get(fresh), await patch(fresh, { name: "x" })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("NO_ACTIVE_ORGANIZATION");
    }
    expect(
      (
        await api(t, "POST", "/api/session/active-organization", fresh, {
          slug: "empresa-ana",
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(fresh)).statusCode).toBe(200);
  });

  it("query string (inclusive organizationId) é rejeitada nas leituras", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    for (const url of [
      "/api/organization?organizationId=x",
      "/api/organization?x=1",
      "/api/organizations?organizationId=x",
    ]) {
      expect((await api(t, "GET", url, ana)).statusCode, url).toBe(400);
    }
  });
});

describe("GET/PATCH /api/organization — configurações", () => {
  it("consulta a empresa ativa com o papel", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const res = await get(ana);
    expect(res.statusCode).toBe(200);
    expect(res.json().organization).toMatchObject({
      slug: "empresa-ana",
      role: "OWNER",
      timezone: "America/Sao_Paulo",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("altera nome, slug e limites permitidos", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const res = await patch(ana, {
      name: "  Novo Nome ",
      slug: "NOVO-slug",
      publicMinNoticeMinutes: 30,
      publicMaxAdvanceDays: 90,
      publicMaxActiveBookingsPerPhone: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().organization).toMatchObject({
      name: "Novo Nome",
      slug: "novo-slug",
      publicMinNoticeMinutes: 30,
      publicMaxAdvanceDays: 90,
      publicMaxActiveBookingsPerPhone: 5,
      timezone: "America/Sao_Paulo",
    });
    const row = await t.prisma.organization.findFirstOrThrow();
    expect(row).toMatchObject({ slug: "novo-slug", publicMaxAdvanceDays: 90 });
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row.createdAt.getTime(),
    );
    // O slug novo vale como empresa ativa imediatamente; o antigo some.
    expect((await get(ana, { "x-active-org": "novo-slug" })).statusCode).toBe(
      200,
    );
    expect((await get(ana, { "x-active-org": "empresa-ana" })).statusCode).toBe(
      409,
    );
  });

  it("atualização parcial mantém os demais campos", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    await patch(ana, { publicMaxAdvanceDays: 30 });
    expect((await get(ana)).json().organization).toMatchObject({
      name: "Empresa empresa-ana",
      publicMinNoticeMinutes: 120,
      publicMaxAdvanceDays: 30,
    });
  });

  it("fuso horário é IMUTÁVEL: enviar `timezone` => 400 e nada muda", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    for (const body of [
      { timezone: "America/New_York" },
      { name: "Outro", timezone: "America/Sao_Paulo" },
    ]) {
      const res = await patch(ana, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    const row = await t.prisma.organization.findFirstOrThrow();
    expect(row.timezone).toBe("America/Sao_Paulo");
    expect(row.name).toBe("Empresa empresa-ana");
  });

  it("campos não autorizados (organizationId, id, status, publishedAt, role, createdAt) => 400", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    for (const body of [
      { organizationId: "00000000-0000-7000-8000-000000000000" },
      { id: "00000000-0000-7000-8000-000000000000" },
      { status: "ACTIVE" },
      { publishedAt: "2020-01-01T00:00:00Z" },
      { role: "OWNER" },
      { createdAt: "2020-01-01T00:00:00Z" },
      { name: "ok", memberships: [] },
    ]) {
      const res = await patch(ana, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const row = await t.prisma.organization.findFirstOrThrow();
    expect(row.publishedAt).toBeNull();
    expect(row.name).toBe("Empresa empresa-ana");
  });

  it("corpo vazio e valores fora da faixa => 400", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    for (const body of [
      {},
      { name: "" },
      { slug: "api" },
      { publicMinNoticeMinutes: -1 },
      { publicMinNoticeMinutes: 1.5 },
      { publicMinNoticeMinutes: 99999 },
      { publicMaxAdvanceDays: 0 },
      { publicMaxAdvanceDays: 366 },
      { publicMaxActiveBookingsPerPhone: 0 },
      { publicMaxActiveBookingsPerPhone: 21 },
      { publicMaxActiveBookingsPerPhone: "3" },
    ]) {
      expect((await patch(ana, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
  });

  it("regra entre campos: antecedência mínima deve ser menor que a máxima (usa o valor já gravado)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const res = await patch(ana, {
      publicMaxAdvanceDays: 1,
      publicMinNoticeMinutes: 1440,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("publicMinNoticeMinutes");
    expect((await patch(ana, { publicMaxAdvanceDays: 1 })).statusCode).toBe(
      200,
    ); // 120 min < 1 dia
    expect(
      (await patch(ana, { publicMinNoticeMinutes: 1440 })).statusCode,
    ).toBe(400); // 1440 >= 1 dia
  });

  it("edições concorrentes que, juntas, violariam a regra: uma passa e a outra recebe 400 (lock da empresa)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const [a, b] = await Promise.all([
      patch(ana, { publicMaxAdvanceDays: 1 }),
      patch(ana, { publicMinNoticeMinutes: 5000 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const row = await t.prisma.organization.findFirstOrThrow();
    expect(row.publicMinNoticeMinutes).toBeLessThan(
      row.publicMaxAdvanceDays * 1440,
    );
  });

  it("slug em uso por outra empresa => 409 e nada muda", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, ana, "empresa-ana");
    await createOrg(t, bob, "empresa-bob");
    const res = await patch(ana, { slug: "empresa-bob", name: "Invasora" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SLUG_UNAVAILABLE");
    expect((await get(ana)).json().organization).toMatchObject({
      slug: "empresa-ana",
      name: "Empresa empresa-ana",
    });
    expect((await get(bob)).json().organization.slug).toBe("empresa-bob");
  });

  it("PATCH/POST exigem Origin permitido e JSON (CSRF)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const noOrigin = await t.app.inject({
      method: "PATCH",
      url: "/api/organization",
      headers: { cookie: ana.cookie, "content-type": "application/json" },
      payload: '{"name":"x"}',
    });
    expect(noOrigin.statusCode).toBe(403);
    const form = await t.app.inject({
      method: "PATCH",
      url: "/api/organization",
      headers: {
        cookie: ana.cookie,
        origin: "http://localhost:5173",
        "content-type": "text/plain",
      },
      payload: "name=x",
    });
    expect(form.statusCode).toBe(415);
    expect((await get(ana)).json().organization.name).toBe(
      "Empresa empresa-ana",
    );
  });
});

describe("contexto de empresa (X-Active-Org e membership)", () => {
  it("X-Active-Org divergente => 409 ACTIVE_ORG_CHANGED e NADA é executado; igual ou ausente => ok", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-um");
    await createOrg(t, ana, "empresa-dois"); // ativa
    const stale = await patch(
      ana,
      { name: "Alterado pela aba velha" },
      { "x-active-org": "empresa-um" },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("ACTIVE_ORG_CHANGED");
    expect((await get(ana)).json().organization.name).toBe(
      "Empresa empresa-dois",
    );
    expect(
      (await t.prisma.organization.findMany({ orderBy: { slug: "asc" } })).map(
        (o) => o.name,
      ),
    ).toEqual(["Empresa empresa-dois", "Empresa empresa-um"]);
    expect(
      (await get(ana, { "x-active-org": "empresa-dois" })).statusCode,
    ).toBe(200);
    expect(
      (await patch(ana, { name: "Ok" }, { "x-active-org": "empresa-dois" }))
        .statusCode,
    ).toBe(200);
  });

  it("X-Active-Org nunca concede acesso: apontar para empresa alheia => 409, não 200", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, ana, "empresa-ana");
    await createOrg(t, bob, "empresa-bob");
    const res = await get(ana, { "x-active-org": "empresa-bob" });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).not.toContain("empresa-bob");
  });

  it("membership perdida: 403 ORGANIZATION_ACCESS_REVOKED e a sessão perde a empresa ativa (4.1)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const c = await rawClient(TEST_DB);
    await c.query("DELETE FROM memberships"); // simulação administrativa; o produto não remove membros no MVP
    await c.end();
    const res = await get(ana);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ORGANIZATION_ACCESS_REVOKED");
    expect(
      (await t.prisma.session.findFirstOrThrow()).activeOrganizationId,
    ).toBeNull();
    expect((await get(ana)).json().error.code).toBe("NO_ACTIVE_ORGANIZATION");
  });

  it("OWNER de 2 empresas: cada alteração só atinge a empresa ativa", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-um");
    await createOrg(t, ana, "empresa-dois");
    await patch(ana, { publicMaxAdvanceDays: 10 }); // empresa-dois (ativa)
    await api(t, "POST", "/api/session/active-organization", ana, {
      slug: "empresa-um",
    });
    expect((await get(ana)).json().organization.publicMaxAdvanceDays).toBe(60);
    await patch(ana, { publicMaxAdvanceDays: 20 });
    const rows = await t.prisma.organization.findMany({
      orderBy: { slug: "asc" },
    });
    expect(rows.map((r) => [r.slug, r.publicMaxAdvanceDays])).toEqual([
      ["empresa-dois", 10],
      ["empresa-um", 20],
    ]);
  });
});

describe("constraints e erros de banco", () => {
  it("só um OWNER por empresa (índice parcial) — inclusive por SQL cru", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, ana, "empresa-ana");
    const org = await t.prisma.organization.findFirstOrThrow();
    const err = await t.prisma.membership
      .create({
        data: { userId: bob.userId, organizationId: org.id, role: "OWNER" },
      })
      .catch((e) => e);
    expect(classifyDbError(err)).toBe("unique_violation");
    expect(await t.prisma.membership.count()).toBe(1);
  });

  it("slug fora do formato é rejeitado pelo CHECK do banco (SQL cru)", async () => {
    const c = await rawClient(TEST_DB);
    const q = (slug: string) =>
      c
        .query(
          `INSERT INTO organizations (id, name, slug, timezone, updated_at) VALUES (gen_random_uuid(), 'x', $1, 'UTC', now())`,
          [slug],
        )
        .catch((e) => e as { code: string; constraint: string });
    const results = [
      await q("Maiuscula"),
      await q("ab"),
      await q("-abc"),
      await q("a--b"),
      await q("a".repeat(41)),
    ];
    await c.end();
    for (const r of results)
      expect((r as { constraint: string }).constraint).toBe(
        "organizations_slug_format",
      );
  });

  it("o banco recusa trocar o fuso horário da empresa (gatilho, 23514), mesmo por SQL cru", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const c = await rawClient(TEST_DB);
    const err = await c
      .query("UPDATE organizations SET timezone = 'America/New_York'")
      .catch((e) => e as { code: string });
    await c.query("UPDATE organizations SET name = 'ok', timezone = timezone"); // atualizar sem mudar o fuso é permitido
    await c.end();
    expect((err as { code: string }).code).toBe("23514");
    expect((await t.prisma.organization.findFirstOrThrow()).timezone).toBe(
      "America/Sao_Paulo",
    );
  });

  it("não há como apagar empresa/usuário com memberships (RESTRICT, R-c)", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const err = await t.prisma.organization.deleteMany().catch((e) => e);
    expect(classifyDbError(err)).toBe("foreign_key_violation");
    expect(await t.prisma.organization.count()).toBe(1);
  });
});

describe("regressão dos fluxos de autenticação com a empresa ativa", () => {
  it("trocar a senha derruba a sessão (mesmo com empresa ativa) e o novo login começa sem empresa ativa", async () => {
    const ana = await signupVerified(t, "ana@example.com");
    await createOrg(t, ana, "empresa-ana");
    const forgot = await post(t, "/api/auth/forgot-password", {
      email: ana.email,
    });
    expect(forgot.statusCode).toBe(202);
    const { latestToken } = await import("../support/auth-app.ts");
    const token = await latestToken(t, "RESET_PASSWORD", ana.email);
    expect(
      (
        await post(t, "/api/auth/reset-password", {
          token,
          newPassword: "nova-senha-bem-longa-4K",
        })
      ).statusCode,
    ).toBe(204);
    expect((await get(ana)).statusCode).toBe(401);
    const login = await post(t, "/api/auth/login", {
      email: ana.email,
      password: "nova-senha-bem-longa-4K",
    });
    expect(login.statusCode).toBe(200);
    const fresh = {
      cookie: `${login.cookies[0]?.name}=${login.cookies[0]?.value}`,
    };
    expect((await get(fresh)).json().error.code).toBe("NO_ACTIVE_ORGANIZATION");
    expect(
      (await api(t, "GET", "/api/organizations", fresh)).json().organizations,
    ).toHaveLength(1);
  });
});
