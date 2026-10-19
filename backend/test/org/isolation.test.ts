// 4.4 itens 4–7 e 5 — registro de rotas × testes de isolamento, suíte A×B de caixa-preta, sentinela de SQL
// e FKs compostas. Duas empresas com os recursos que existem hoje (empresa e membership).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB, SPIKE_DB, rawClient } from "../support/databases.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  api,
  createOrg,
  signupVerified,
  type TestUser,
} from "../support/orgs.ts";
import { sentinelViolations } from "../support/sql-sentinel.ts";

/**
 * Rotas `tenant` COBERTAS por este arquivo. Adicionar uma rota tenant sem entrada aqui (e sem o ataque A×B
 * correspondente abaixo) faz o teste de registro de rotas falhar.
 */
const TENANT_ROUTES_WITH_AB_TESTS = new Set([
  "GET /api/organization",
  "PATCH /api/organization",
  "GET /api/services",
  "POST /api/services",
  "GET /api/services/:id",
  "PATCH /api/services/:id",
  "GET /api/professionals",
  "POST /api/professionals",
  "GET /api/professionals/:id",
  "PATCH /api/professionals/:id",
  "PUT /api/professionals/:id/services",
  "GET /api/working-hours",
  "POST /api/working-hours",
  "PATCH /api/working-hours/:id",
  "DELETE /api/working-hours/:id",
  "GET /api/time-off",
  "POST /api/time-off",
  "PATCH /api/time-off/:id",
  "DELETE /api/time-off/:id",
]);

let t: AuthTestApp;
let A: TestUser;
let B: TestUser;
const ORG_B_SLUG = "empresa-b-secreta";

beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  A = await signupVerified(t, "a@example.com");
  B = await signupVerified(t, "b@example.com");
  expect((await createOrg(t, A, "empresa-a")).statusCode).toBe(201);
  expect((await createOrg(t, B, ORG_B_SLUG)).statusCode).toBe(201);
});
afterEach(() => t.close());

const snapshotB = () =>
  t.prisma.organization.findUniqueOrThrow({ where: { slug: ORG_B_SLUG } });

describe("item 4 — registro de rotas × classificação", () => {
  it("toda rota está classificada (tenant | auth | public | none)", () => {
    const routes = t.app.routeRegistry.filter((r) => r.method !== "HEAD");
    expect(routes.length).toBeGreaterThan(15);
    const unclassified = routes
      .filter((r) => !r.access)
      .map((r) => `${r.method} ${r.url}`);
    expect(
      unclassified,
      `rotas sem classificação: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("rotas tenant exigem ação de permissão e têm teste A×B; nenhuma `public` existe ainda", () => {
    const routes = t.app.routeRegistry.filter((r) => r.method !== "HEAD");
    const tenant = routes.filter((r) => r.access === "tenant");
    expect(tenant.length).toBeGreaterThan(0);
    for (const r of tenant) {
      expect(r.action, `${r.method} ${r.url} sem ação de can()`).toBeTruthy();
      expect(
        TENANT_ROUTES_WITH_AB_TESTS.has(`${r.method} ${r.url}`),
        `${r.method} ${r.url} sem teste A×B`,
      ).toBe(true);
    }
    expect(new Set(tenant.map((r) => `${r.method} ${r.url}`))).toEqual(
      TENANT_ROUTES_WITH_AB_TESTS,
    );
    expect(routes.filter((r) => r.access === "public")).toEqual([]);
  });

  it("nenhuma rota tenant tem organizationId no caminho; parâmetros de caminho só identificam recursos (a empresa vem da sessão)", () => {
    for (const r of t.app.routeRegistry.filter((x) => x.access === "tenant")) {
      expect(r.url).not.toMatch(/organization_?id|org_?id|:org|:tenant|:slug/i);
      for (const param of r.url.match(/:\w+/g) ?? []) expect(param).toBe(":id");
    }
  });

  it("toda rota `tenant` rejeita requisição sem sessão (401) antes de qualquer outra coisa", async () => {
    for (const r of t.app.routeRegistry.filter((x) => x.access === "tenant")) {
      const res = await api(t, r.method as "GET", r.url, undefined, {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });
});

describe("item 5 — suíte A×B de caixa-preta", () => {
  it("GET /api/organization: A enxerga só a própria empresa, mesmo manipulando entradas", async () => {
    const before = await snapshotB();
    const ok = await api(t, "GET", "/api/organization", A);
    expect(ok.json().organization.slug).toBe("empresa-a");
    const orgB = await snapshotB();

    const attacks = [
      api(t, "GET", `/api/organization?organizationId=${orgB.id}`, A), // query ⇒ 400
      api(t, "GET", `/api/organization?slug=${ORG_B_SLUG}`, A), // query ⇒ 400
      api(t, "GET", "/api/organization", A, undefined, {
        "x-active-org": ORG_B_SLUG,
      }), // header ⇒ 409
      api(t, "GET", "/api/organization", A, undefined, {
        "x-organization-id": orgB.id,
      }), // ignorado, nunca concede
    ];
    const [q1, q2, h1, h2] = await Promise.all(attacks);
    expect(q1!.statusCode).toBe(400);
    expect(q2!.statusCode).toBe(400);
    expect(h1!.statusCode).toBe(409);
    expect(h2!.json().organization.slug).toBe("empresa-a"); // header desconhecido não troca de empresa
    for (const r of [q1, q2, h1, h2])
      expect(JSON.stringify(r!.json())).not.toContain(ORG_B_SLUG);
    expect(await snapshotB()).toEqual(before);
  });

  it("PATCH /api/organization: A não consegue alterar B por nenhum caminho", async () => {
    const orgB = await snapshotB();
    const before = { ...orgB };
    const attempts = [
      { body: { organizationId: orgB.id, name: "hackeada" }, expect: 400 },
      { body: { id: orgB.id, name: "hackeada" }, expect: 400 },
      { body: { slug: ORG_B_SLUG }, expect: 409 }, // tomar o endereço de B
      {
        body: { name: "hackeada" },
        headers: { "x-active-org": ORG_B_SLUG },
        expect: 409,
      },
      {
        body: { name: "hackeada", memberships: [{ organizationId: orgB.id }] },
        expect: 400,
      },
    ];
    for (const a of attempts) {
      const res = await api(
        t,
        "PATCH",
        "/api/organization",
        A,
        a.body,
        a.headers ?? {},
      );
      expect(res.statusCode, JSON.stringify(a.body)).toBe(a.expect);
    }
    expect(await snapshotB()).toEqual(before);
    expect(
      (await api(t, "GET", "/api/organization", A)).json().organization.name,
    ).toBe("Empresa empresa-a");
    expect(
      await t.prisma.membership.count({ where: { organizationId: orgB.id } }),
    ).toBe(1);
  });

  it("trocar a empresa ativa: A não consegue ativar a empresa de B (404 idêntico a inexistente)", async () => {
    const sessionA = await t.prisma.session.findFirstOrThrow({
      where: { userId: A.userId },
    });
    const orgB = await snapshotB();
    for (const slug of [ORG_B_SLUG, "nao-existe-mesmo"]) {
      const res = await api(t, "POST", "/api/session/active-organization", A, {
        slug,
      });
      expect(res.statusCode).toBe(404);
    }
    // ids manipulados no corpo nunca valem
    expect(
      (
        await api(t, "POST", "/api/session/active-organization", A, {
          slug: "empresa-a",
          organizationId: orgB.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await t.prisma.session.findUniqueOrThrow({ where: { id: sessionA.id } }))
        .activeOrganizationId,
    ).toBe(sessionA.activeOrganizationId);
  });

  it("listagem: cada usuário vê só as próprias empresas", async () => {
    const a = (await api(t, "GET", "/api/organizations", A)).json();
    const b = (await api(t, "GET", "/api/organizations", B)).json();
    expect(a.organizations.map((o: { slug: string }) => o.slug)).toEqual([
      "empresa-a",
    ]);
    expect(b.organizations.map((o: { slug: string }) => o.slug)).toEqual([
      ORG_B_SLUG,
    ]);
    expect(JSON.stringify(a)).not.toContain(ORG_B_SLUG);
  });

  it("sessão de A com a empresa ativa de B injetada no banco (adulteração) não concede acesso: 403 e a empresa ativa é limpa", async () => {
    const orgB = await snapshotB();
    await t.prisma.session.updateMany({
      where: { userId: A.userId },
      data: { activeOrganizationId: orgB.id },
    });
    const res = await api(t, "GET", "/api/organization", A);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ORGANIZATION_ACCESS_REVOKED");
    expect(JSON.stringify(res.json())).not.toContain(ORG_B_SLUG);
    expect(
      (await t.prisma.session.findFirstOrThrow({ where: { userId: A.userId } }))
        .activeOrganizationId,
    ).toBeNull();
    expect((await snapshotB()).name).toBe("Empresa empresa-b-secreta");
  });

  it("item 6 — sentinela de SQL: nenhuma consulta a tabela escopada deixa de citar organization_id (fora da allowlist)", async () => {
    t.queries.length = 0;
    // Percorre todos os caminhos de A e B.
    for (const u of [A, B]) {
      await api(t, "GET", "/api/organization", u);
      await api(t, "PATCH", "/api/organization", u, {
        publicMaxAdvanceDays: 30,
      });
      await api(t, "GET", "/api/organizations", u);
      await api(t, "POST", "/api/session/active-organization", u, {
        slug: u === A ? "empresa-a" : ORG_B_SLUG,
      });
    }
    await api(t, "GET", "/api/organization", A, undefined, {
      "x-active-org": ORG_B_SLUG,
    });
    await createOrg(t, A, "segunda-de-a");
    await api(t, "PATCH", "/api/organization", A, { organizationId: "x" });

    expect(t.queries.some((q) => /"memberships"/.test(q))).toBe(true); // a sentinela está vendo as consultas
    const violations = sentinelViolations(t.queries, [
      {
        pattern: /"user_id" = \$1/,
        reason:
          "listagem/troca das empresas do PRÓPRIO usuário: filtradas por user_id vindo da sessão",
      },
    ]);
    expect(violations).toEqual([]);
  });
});

describe("item 5 — A×B para serviços", () => {
  const svc = (
    user: TestUser,
    id: string,
    body?: unknown,
    method: "GET" | "PATCH" = "GET",
    headers: Record<string, string> = {},
  ) => api(t, method, `/api/services/${id}`, user, body, headers);

  it("A não lê, lista, altera nem desativa o serviço de B; respostas iguais às de id inexistente", async () => {
    const sb = (
      await api(t, "POST", "/api/services", B, {
        name: "Segredo do B",
        durationMinutes: 20,
      })
    ).json().service;
    const sa = (
      await api(t, "POST", "/api/services", A, {
        name: "Do A",
        durationMinutes: 30,
      })
    ).json().service;
    const rowB = await t.prisma.service.findUniqueOrThrow({
      where: { id: sb.id },
    });

    const ghost = "00000000-0000-7000-8000-000000000999";
    const [getB, getGhost, patchB, patchGhost] = await Promise.all([
      svc(A, sb.id),
      svc(A, ghost),
      svc(A, sb.id, { name: "hackeado", active: false }, "PATCH"),
      svc(A, ghost, { name: "hackeado", active: false }, "PATCH"),
    ]);
    for (const r of [getB, getGhost, patchB, patchGhost])
      expect(r.statusCode).toBe(404);
    expect({ ...getB.json().error, requestId: 0 }).toEqual({
      ...getGhost.json().error,
      requestId: 0,
    });
    expect({ ...patchB.json().error, requestId: 0 }).toEqual({
      ...patchGhost.json().error,
      requestId: 0,
    });

    const listA = (await api(t, "GET", "/api/services", A)).json();
    expect(listA.services.map((s: { id: string }) => s.id)).toEqual([sa.id]);
    expect(JSON.stringify(listA)).not.toContain("Segredo do B");

    // ids, empresa e cabeçalhos manipulados
    const orgB = await snapshotB();
    const attacks = [
      api(t, "POST", "/api/services", A, {
        name: "x",
        durationMinutes: 10,
        organizationId: orgB.id,
      }), // 400
      api(t, "GET", `/api/services?organizationId=${orgB.id}`, A), // 400
      api(
        t,
        "POST",
        "/api/services",
        A,
        { name: "x", durationMinutes: 10 },
        { "x-active-org": ORG_B_SLUG },
      ), // 409
      svc(A, sb.id, { name: "x" }, "PATCH", { "x-active-org": ORG_B_SLUG }), // 409
      svc(A, sb.id, { organizationId: orgB.id }, "PATCH"), // 400
    ];
    const codes = (await Promise.all(attacks)).map((r) => r.statusCode);
    expect(codes).toEqual([400, 400, 409, 409, 400]);

    expect(
      await t.prisma.service.findUniqueOrThrow({ where: { id: sb.id } }),
    ).toEqual(rowB); // B intacto
    expect(
      await t.prisma.service.count({ where: { organizationId: orgB.id } }),
    ).toBe(1);
    expect(await t.prisma.service.count()).toBe(2); // nada foi criado por engano em nenhuma empresa
  });

  it("sentinela de SQL: toda consulta à tabela services cita organization_id", async () => {
    const mine = (
      await api(t, "POST", "/api/services", A, {
        name: "Do A",
        durationMinutes: 30,
      })
    ).json().service;
    t.queries.length = 0;
    await api(t, "GET", "/api/services", A);
    await api(t, "GET", `/api/services/${mine.id}`, A);
    await api(t, "PATCH", `/api/services/${mine.id}`, A, { name: "novo" });
    await api(t, "POST", "/api/services", A, {
      name: "outro",
      durationMinutes: 15,
    });
    await api(t, "GET", `/api/services/${mine.id}`, B); // alheio
    await api(t, "PATCH", `/api/services/${mine.id}`, B, { name: "x" }); // alheio
    expect(t.queries.some((q) => /"services"/.test(q))).toBe(true);
    expect(sentinelViolations(t.queries, [])).toEqual([]);
  });
});

describe("item 5 — A×B para profissionais e vínculos", () => {
  const pro = (user: TestUser, name: string) =>
    api(t, "POST", "/api/professionals", user, { name }).then(
      (r) => r.json().professional as { id: string },
    );
  const svc = (user: TestUser, name: string) =>
    api(t, "POST", "/api/services", user, { name, durationMinutes: 30 }).then(
      (r) => r.json().service as { id: string },
    );
  const setLinks = (
    user: TestUser,
    professionalId: string,
    serviceIds: string[],
    headers: Record<string, string> = {},
  ) =>
    api(
      t,
      "PUT",
      `/api/professionals/${professionalId}/services`,
      user,
      { serviceIds },
      headers,
    );

  it("A não lê, altera, desativa nem vincula nada de B; respostas iguais às de id inexistente", async () => {
    const pa = await pro(A, "Profissional A");
    const pb = await pro(B, "Profissional B");
    const sa = await svc(A, "Serviço A");
    const sb = await svc(B, "Serviço B");
    await setLinks(B, pb.id, [sb.id]);
    const ghost = "00000000-0000-7000-8000-000000000999";
    const orgB = await snapshotB();
    const linksBefore = await t.prisma.professionalService.findMany({
      orderBy: { createdAt: "asc" },
    });
    const rowB = await t.prisma.professional.findUniqueOrThrow({
      where: { id: pb.id },
    });

    const [getB, getGhost, patchB, patchGhost] = await Promise.all([
      api(t, "GET", `/api/professionals/${pb.id}`, A),
      api(t, "GET", `/api/professionals/${ghost}`, A),
      api(t, "PATCH", `/api/professionals/${pb.id}`, A, {
        name: "hackeado",
        active: false,
      }),
      api(t, "PATCH", `/api/professionals/${ghost}`, A, {
        name: "hackeado",
        active: false,
      }),
    ]);
    for (const r of [getB, getGhost, patchB, patchGhost])
      expect(r.statusCode).toBe(404);
    expect({ ...getB.json().error, requestId: 0 }).toEqual({
      ...getGhost.json().error,
      requestId: 0,
    });
    expect({ ...patchB.json().error, requestId: 0 }).toEqual({
      ...patchGhost.json().error,
      requestId: 0,
    });

    // vincular: profissional de B, serviço de B, e mistura — tudo 404, igual a inexistente, e nada muda
    const attempts = await Promise.all([
      setLinks(A, pb.id, [sa.id]), // profissional alheio
      setLinks(A, pa.id, [sb.id]), // serviço alheio
      setLinks(A, pa.id, [sa.id, sb.id]), // um próprio e um alheio: nada é aplicado
      setLinks(A, pa.id, [ghost]), // inexistente
      setLinks(A, ghost, [sa.id]), // profissional inexistente
    ]);
    for (const r of attempts) expect(r.statusCode).toBe(404);
    const norm = (r: (typeof attempts)[number]) => ({
      ...r.json().error,
      requestId: 0,
    });
    for (const r of attempts) expect(norm(r)).toEqual(norm(attempts[3]!));
    expect(
      await t.prisma.professionalService.count({
        where: { professionalId: pa.id },
      }),
    ).toBe(0);

    // corpo/cabeçalho/consulta manipulados
    const codes = (
      await Promise.all([
        api(t, "POST", "/api/professionals", A, {
          name: "x",
          organizationId: orgB.id,
        }),
        api(t, "GET", `/api/professionals?organizationId=${orgB.id}`, A),
        api(
          t,
          "POST",
          "/api/professionals",
          A,
          { name: "x" },
          { "x-active-org": ORG_B_SLUG },
        ),
        api(
          t,
          "PATCH",
          `/api/professionals/${pb.id}`,
          A,
          { name: "x" },
          { "x-active-org": ORG_B_SLUG },
        ),
        api(t, "PUT", `/api/professionals/${pa.id}/services`, A, {
          serviceIds: [sa.id],
          organizationId: orgB.id,
        }),
      ])
    ).map((r) => r.statusCode);
    expect(codes).toEqual([400, 400, 409, 409, 400]);

    const list = (await api(t, "GET", "/api/professionals", A)).json();
    expect(list.professionals.map((p: { id: string }) => p.id)).toEqual([
      pa.id,
    ]);
    expect(JSON.stringify(list)).not.toContain(sb.id);
    expect(
      await t.prisma.professional.findUniqueOrThrow({ where: { id: pb.id } }),
    ).toEqual(rowB);
    expect(
      await t.prisma.professionalService.findMany({
        orderBy: { createdAt: "asc" },
      }),
    ).toEqual(linksBefore);
    expect(await t.prisma.professional.count()).toBe(2);
  });

  it("sentinela de SQL: consultas a professionals e professional_services citam organization_id", async () => {
    const pa = await pro(A, "Profissional A");
    const sa = await svc(A, "Serviço A");
    t.queries.length = 0;
    await api(t, "GET", "/api/professionals", A);
    await api(t, "GET", `/api/professionals/${pa.id}`, A);
    await api(t, "PATCH", `/api/professionals/${pa.id}`, A, { name: "novo" });
    await setLinks(A, pa.id, [sa.id]);
    await setLinks(A, pa.id, []);
    await api(t, "GET", `/api/professionals/${pa.id}`, B); // alheio
    await setLinks(B, pa.id, [sa.id]); // alheio
    expect(t.queries.some((q) => /"professional_services"/.test(q))).toBe(true);
    expect(t.queries.some((q) => /FROM professionals/.test(q))).toBe(true); // a trava (SQL cru) também é vista
    expect(sentinelViolations(t.queries, [])).toEqual([]);
  });
});

describe("item 5 — A×B para WorkingHours e TimeOff", () => {
  const pro = (user: TestUser, name: string) =>
    api(t, "POST", "/api/professionals", user, { name }).then(
      (r) => r.json().professional.id as string,
    );
  const addWh = (user: TestUser, professionalId: string) =>
    api(t, "POST", "/api/working-hours", user, {
      professionalId,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
    }).then((r) => r.json().workingHours.id as string);
  const addTo = (user: TestUser, professionalId: string) =>
    api(t, "POST", "/api/time-off", user, {
      professionalId,
      startsAt: "2031-07-01T10:00:00Z",
      endsAt: "2031-07-01T12:00:00Z",
    }).then((r) => r.json().timeOff.id as string);
  const norm = (r: { statusCode: number; json: () => { error: object } }) => ({
    status: r.statusCode,
    error: { ...r.json().error, requestId: 0 },
  });
  const GHOST = "00000000-0000-7000-8000-000000000999";

  it("A não lê, cria, altera nem remove nada de B; respostas iguais às de id inexistente; B intacto", async () => {
    const pa = await pro(A, "Profissional A");
    const pb = await pro(B, "Profissional B");
    const whB = await addWh(B, pb);
    const toB = await addTo(B, pb);
    const whA = await addWh(A, pa);
    const rowsB = async () => ({
      wh: await t.prisma.workingHours.findMany({
        where: { professionalId: pb },
      }),
      to: await t.prisma.timeOff.findMany({ where: { professionalId: pb } }),
    });
    const before = await rowsB();
    const total = {
      wh: await t.prisma.workingHours.count(),
      to: await t.prisma.timeOff.count(),
    };

    const attack = (idB: string, proB: string) =>
      Promise.all([
        api(t, "GET", `/api/working-hours?professionalId=${proB}`, A),
        api(t, "GET", `/api/time-off?professionalId=${proB}`, A),
        api(t, "POST", "/api/working-hours", A, {
          professionalId: proB,
          weekday: 2,
          startTime: "09:00",
          endTime: "10:00",
        }),
        api(t, "POST", "/api/time-off", A, {
          professionalId: proB,
          startsAt: "2031-08-01T10:00:00Z",
          endsAt: "2031-08-01T11:00:00Z",
        }),
        api(t, "PATCH", `/api/working-hours/${idB}`, A, { endTime: "23:00" }),
        api(t, "DELETE", `/api/working-hours/${idB}`, A),
        api(t, "PATCH", `/api/time-off/${idB}`, A, { reason: "hackeado" }),
        api(t, "DELETE", `/api/time-off/${idB}`, A),
      ]);
    const real = await Promise.all([attack(whB, pb), attack(toB, pb)]);
    const ghost = await Promise.all([
      attack(GHOST, GHOST),
      attack(GHOST, GHOST),
    ]);
    // os 4 ataques por id: o id de B vale para a rota certa (working-hours ou time-off); a outra rota recebe um id
    // desconhecido para ela — de todo modo, sempre 404 idêntico ao de id inexistente
    for (const results of [...real, ...ghost])
      for (const r of results) expect(r.statusCode).toBe(404);
    for (let i = 0; i < 8; i++) {
      expect(norm(real[0]![i]!), `ataque ${i} (working-hours)`).toEqual(
        norm(ghost[0]![i]!),
      );
      expect(norm(real[1]![i]!), `ataque ${i} (time-off)`).toEqual(
        norm(ghost[1]![i]!),
      );
    }
    expect(await rowsB()).toEqual(before);
    expect(await t.prisma.workingHours.count()).toBe(total.wh);
    expect(await t.prisma.timeOff.count()).toBe(total.to);
    // A continua enxergando e operando o que é seu
    expect(
      (
        await api(t, "PATCH", `/api/working-hours/${whA}`, A, {
          endTime: "13:00",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        (
          await api(t, "GET", `/api/working-hours?professionalId=${pa}`, A)
        ).json().workingHours as unknown[]
      ).length,
    ).toBe(1);
  });

  it("organizationId no corpo/na query => 400; X-Active-Org de B => 409; nada muda em B", async () => {
    const pa = await pro(A, "Profissional A");
    const orgB = await snapshotB();
    const before = {
      wh: await t.prisma.workingHours.count(),
      to: await t.prisma.timeOff.count(),
    };
    const whId = await addWh(A, pa);
    const toId = await addTo(A, pa);
    const responses = await Promise.all([
      api(
        t,
        "GET",
        `/api/working-hours?professionalId=${pa}&organizationId=${orgB.id}`,
        A,
      ),
      api(
        t,
        "GET",
        `/api/time-off?professionalId=${pa}&organizationId=${orgB.id}`,
        A,
      ),
      api(t, "POST", "/api/working-hours", A, {
        professionalId: pa,
        weekday: 3,
        startTime: "09:00",
        endTime: "10:00",
        organizationId: orgB.id,
      }),
      api(t, "POST", "/api/time-off", A, {
        professionalId: pa,
        startsAt: "2031-08-01T10:00:00Z",
        endsAt: "2031-08-01T11:00:00Z",
        organizationId: orgB.id,
      }),
      api(t, "PATCH", `/api/working-hours/${whId}`, A, {
        organizationId: orgB.id,
      }),
      api(t, "PATCH", `/api/time-off/${toId}`, A, { organizationId: orgB.id }),
    ]);
    for (const r of responses) expect(r.statusCode).toBe(400);
    const switched = await Promise.all([
      api(t, "GET", `/api/working-hours?professionalId=${pa}`, A, undefined, {
        "x-active-org": ORG_B_SLUG,
      }),
      api(
        t,
        "POST",
        "/api/working-hours",
        A,
        {
          professionalId: pa,
          weekday: 3,
          startTime: "09:00",
          endTime: "10:00",
        },
        { "x-active-org": ORG_B_SLUG },
      ),
      api(
        t,
        "DELETE",
        `/api/time-off/${toId}`,
        A,
        {},
        { "x-active-org": ORG_B_SLUG },
      ),
    ]);
    for (const r of switched) expect(r.statusCode).toBe(409);
    expect(await t.prisma.workingHours.count()).toBe(before.wh + 1);
    expect(await t.prisma.timeOff.count()).toBe(before.to + 1);
    expect(
      await t.prisma.workingHours.count({ where: { organizationId: orgB.id } }),
    ).toBe(0);
  });

  it("sentinela de SQL: consultas a working_hours e time_off citam organization_id", async () => {
    const pa = await pro(A, "Profissional A");
    t.queries.length = 0;
    const w = await addWh(A, pa);
    const o = await addTo(A, pa);
    await api(t, "GET", `/api/working-hours?professionalId=${pa}`, A);
    await api(t, "GET", `/api/time-off?professionalId=${pa}`, A);
    await api(t, "PATCH", `/api/working-hours/${w}`, A, { endTime: "13:00" });
    await api(t, "PATCH", `/api/time-off/${o}`, A, { reason: "x" });
    await api(t, "DELETE", `/api/working-hours/${w}`, B); // alheio
    await api(t, "DELETE", `/api/time-off/${o}`, A);
    await api(t, "DELETE", `/api/working-hours/${w}`, A);
    expect(t.queries.some((q) => /"working_hours"/.test(q))).toBe(true);
    expect(t.queries.some((q) => /"time_off"/.test(q))).toBe(true);
    expect(sentinelViolations(t.queries, [])).toEqual([]);
  });
});

describe("os detectores realmente detectam (testes dos testes)", () => {
  it("o registro de rotas enxerga rota sem classificação e rota tenant sem ação", async () => {
    const { buildApp } = await import("../../src/app.ts");
    const app = buildApp({ logger: false, checkDatabase: async () => {} });
    app.get("/api/sem-classificacao", async () => 1);
    app.get(
      "/api/tenant-sem-acao",
      { config: { access: "tenant" } },
      async () => 1,
    );
    await app.ready();
    const find = (url: string) =>
      app.routeRegistry.find((r) => r.url === url && r.method === "GET");
    expect(find("/api/sem-classificacao")?.access).toBeUndefined();
    expect(find("/api/tenant-sem-acao")).toMatchObject({
      access: "tenant",
      action: undefined,
    });
    await app.close();
  });

  it("a sentinela de SQL acusa consulta em tabela escopada sem organization_id e aceita as demais", () => {
    const bad =
      'SELECT "public"."memberships"."id" FROM "public"."memberships" WHERE "public"."memberships"."role" = $1';
    const ok =
      'SELECT "public"."memberships"."id" FROM "public"."memberships" WHERE "public"."memberships"."organization_id" = $1';
    const unrelated = 'SELECT "public"."users"."id" FROM "public"."users"';
    expect(sentinelViolations([bad, ok, unrelated], [])).toEqual([bad]);
    expect(
      sentinelViolations([bad], [{ pattern: /"role" = \$1/, reason: "teste" }]),
    ).toEqual([]);
  });
});

describe("item 7 — FKs compostas entre tabelas escopadas", () => {
  /** FKs de tabela com organization_id para OUTRA tabela com organization_id que NÃO incluem organization_id. */
  async function nonCompositeTenantFks(db: string) {
    const c = await rawClient(db);
    try {
      const { rows } = await c.query(`
        WITH tenant_tables AS (
          SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped))
        SELECT con.conname, src.relname AS source, tgt.relname AS target,
               (SELECT bool_or(a.attname = 'organization_id')
                  FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) AS has_org
          FROM pg_constraint con
          JOIN tenant_tables src ON src.oid = con.conrelid
          JOIN tenant_tables tgt ON tgt.oid = con.confrelid
         WHERE con.contype = 'f'`);
      return rows as Array<{
        conname: string;
        source: string;
        target: string;
        has_org: boolean;
      }>;
    } finally {
      await c.end();
    }
  }

  it("schema do spike (tabelas filhas reais): todas as FKs entre tabelas de tenant são compostas", async () => {
    const fks = await nonCompositeTenantFks(SPIKE_DB);
    expect(fks.length).toBeGreaterThanOrEqual(4); // appointments→professionals/services/customers e notes→professionals
    expect(fks.filter((f) => !f.has_org)).toEqual([]);
  });

  it("schema de produção: as FKs entre tabelas escopadas (vínculo profissional×serviço) são todas compostas", async () => {
    const fks = await nonCompositeTenantFks(TEST_DB);
    expect(fks.filter((f) => !f.has_org)).toEqual([]);
    expect(fks.map((f) => `${f.source}->${f.target}`).sort()).toEqual([
      "professional_services->professionals",
      "professional_services->services",
      "time_off->professionals",
      "working_hours->professionals",
    ]);
  });

  it("par inconsistente via SQL cru falha por FK composta — evidência do spike da Etapa 3 (v3-composite-fk.test.ts)", async () => {
    const c = await rawClient(SPIKE_DB);
    const { rows } = await c.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointments_organization_id_professional_id_fkey'`,
    );
    await c.end();
    expect(rows[0].def).toContain(
      "FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id)",
    );
    expect(rows[0].def).toContain("ON DELETE RESTRICT");
    expect(rows[0].def).not.toContain("SET NULL");
  });
});
