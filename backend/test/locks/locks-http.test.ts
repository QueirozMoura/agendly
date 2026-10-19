// L9 (cobertura do lock, parte de TimeOff/WorkingHours/vínculos), L10 (lock_timeout => 503, nada gravado) e
// concorrência dos fluxos da Etapa 9. Postgres real. Concorrência = evidência por amostragem, não prova (6.5).
import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerErrorHandling } from "../../src/plugins/error-handler.ts";
import { buildLoggerOptions } from "../../src/lib/logger.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
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

let t: AuthTestApp;
let ana: TestUser;
let orgId: string;
let pa: string;
let pb: string;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(201);
  orgId = (
    await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    })
  ).id;
  [pa, pb] = (await Promise.all([mkPro("Carla"), mkPro("Davi")])).sort() as [
    string,
    string,
  ];
});
afterEach(() => t.close());

const mkPro = async (name: string) =>
  (await api(t, "POST", "/api/professionals", ana, { name })).json()
    .professional.id as string;
const mkSvc = async (name = "Corte") =>
  (
    await api(t, "POST", "/api/services", ana, { name, durationMinutes: 30 })
  ).json().service.id as string;
const wh = (professionalId: string, over: Record<string, unknown> = {}) =>
  api(t, "POST", "/api/working-hours", ana, {
    professionalId,
    weekday: 1,
    startTime: "09:00",
    endTime: "12:00",
    ...over,
  });
const to = (professionalId: string, over: Record<string, unknown> = {}) =>
  api(t, "POST", "/api/time-off", ana, {
    professionalId,
    startsAt: "2031-07-01T10:00:00Z",
    endsAt: "2031-07-01T12:00:00Z",
    ...over,
  });

/** Segura a trava N2 do profissional numa conexão à parte até `release()`. */
async function holdProfessional(id: string) {
  const c = await rawClient(TEST_DB);
  await c.query("BEGIN");
  await c.query(
    "SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE",
    [id],
  );
  return {
    release: async () => {
      await c.query("ROLLBACK");
      await c.end();
    },
  };
}

describe("L9 — toda escrita de TimeOff/WorkingHours/vínculos passa pela trava N2 antes de escrever", () => {
  const WRITE =
    /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+"?public"?\."?(time_off|working_hours|professional_services|professionals)"?/i;
  const isLock = (q: string) =>
    /FROM professionals[\s\S]*FOR NO KEY UPDATE/.test(q);

  async function assertLockedBeforeWrite(
    label: string,
    action: () => Promise<{ statusCode: number }>,
    expectedStatus: number,
  ) {
    t.queries.length = 0;
    const res = await action();
    expect(res.statusCode, label).toBe(expectedStatus);
    const lockAt = t.queries.findIndex(isLock);
    const writeAt = t.queries.findIndex((q) => WRITE.test(q));
    expect(
      writeAt,
      `${label}: nenhuma escrita foi observada`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      lockAt,
      `${label}: escrita sem o lock do profissional`,
    ).toBeGreaterThanOrEqual(0);
    expect(lockAt, `${label}: lock DEPOIS da escrita`).toBeLessThan(writeAt);
    // as leituras que decidem a escrita (sobreposição, contagem) também acontecem sob o lock
    const firstRead = t.queries.findIndex(
      (q) =>
        /FROM "public"\."(working_hours|time_off)"/.test(q) &&
        /^\s*SELECT/i.test(q),
    );
    if (firstRead >= 0 && label.startsWith("POST"))
      expect(lockAt).toBeLessThan(firstRead);
  }

  it("rotas de escrita: o SELECT … FOR NO KEY UPDATE precede o primeiro INSERT/UPDATE/DELETE", async () => {
    const svc = await mkSvc();
    const w = (await wh(pa)).json().workingHours.id as string;
    const o = (await to(pa)).json().timeOff.id as string;
    await assertLockedBeforeWrite(
      "POST working-hours",
      () => wh(pb, { weekday: 2 }),
      201,
    );
    await assertLockedBeforeWrite(
      "PATCH working-hours",
      () =>
        api(t, "PATCH", `/api/working-hours/${w}`, ana, { endTime: "13:00" }),
      200,
    );
    await assertLockedBeforeWrite(
      "DELETE working-hours",
      () => api(t, "DELETE", `/api/working-hours/${w}`, ana),
      204,
    );
    await assertLockedBeforeWrite("POST time-off", () => to(pb), 201);
    await assertLockedBeforeWrite(
      "PATCH time-off",
      () => api(t, "PATCH", `/api/time-off/${o}`, ana, { reason: "x" }),
      200,
    );
    await assertLockedBeforeWrite(
      "DELETE time-off",
      () => api(t, "DELETE", `/api/time-off/${o}`, ana),
      204,
    );
    await assertLockedBeforeWrite(
      "PUT services",
      () =>
        api(t, "PUT", `/api/professionals/${pa}/services`, ana, {
          serviceIds: [svc],
        }),
      200,
    );
    await assertLockedBeforeWrite(
      "PATCH professional",
      () => api(t, "PATCH", `/api/professionals/${pa}`, ana, { active: false }),
      200,
    );
  });

  it("o lock é de UM profissional por operação, o dono da linha: a de outro profissional não bloqueia (L3)", async () => {
    const w = (await wh(pa)).json().workingHours.id as string;
    const held = await holdProfessional(pb);
    try {
      const started = Date.now();
      expect(
        (
          await api(t, "PATCH", `/api/working-hours/${w}`, ana, {
            endTime: "13:00",
          })
        ).statusCode,
      ).toBe(200);
      expect((await to(pa)).statusCode).toBe(201);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await held.release();
    }
  });

  it("operação que não passa pelo lock não existe: escrita sem N2 é recusada em tempo de execução", async () => {
    // (a cobertura estática dos serviços está em locks-static.test.ts; o guard unitário, em guard.test.ts)
    const { enterLeafWrite, LockCoverageViolation } =
      await import("../../src/lib/db/locks/index.ts");
    await t.prisma.$transaction(async (tx) => {
      expect(() => enterLeafWrite(tx, pa)).toThrow(LockCoverageViolation);
    });
  });
});

describe("L10 — lock_timeout: 503 TEMPORARILY_BUSY, rollback total e nada gravado", () => {
  it("todas as escritas esperam a trava, estouram o lock_timeout com 503 + Retry-After e não alteram nada; leituras não esperam", async () => {
    const svc = await mkSvc();
    const w = (await wh(pa)).json().workingHours.id as string;
    const o = (await to(pa)).json().timeOff.id as string;
    await api(t, "PUT", `/api/professionals/${pa}/services`, ana, {
      serviceIds: [svc],
    });

    const snapshot = async () => ({
      wh: await t.prisma.workingHours.findMany({ orderBy: { id: "asc" } }),
      to: await t.prisma.timeOff.findMany({ orderBy: { id: "asc" } }),
      links: await t.prisma.professionalService.findMany(),
      pro: await t.prisma.professional.findUniqueOrThrow({ where: { id: pa } }),
    });
    const before = await snapshot();

    const held = await holdProfessional(pa);
    let writes: Awaited<ReturnType<typeof api>>[];
    let reads: Awaited<ReturnType<typeof api>>[];
    const burstMs: number[] = [];
    try {
      // leituras primeiro (não esperam o lock); depois a rajada de 8 escritas, que cabe no pool de 10 conexões
      reads = await Promise.all([
        api(t, "GET", `/api/working-hours?professionalId=${pa}`, ana),
        api(t, "GET", `/api/time-off?professionalId=${pa}`, ana),
        api(t, "GET", `/api/professionals/${pa}`, ana),
      ]);
      const started = Date.now();
      writes = await Promise.all([
        wh(pa, { weekday: 3 }),
        api(t, "PATCH", `/api/working-hours/${w}`, ana, { endTime: "13:00" }),
        api(t, "DELETE", `/api/working-hours/${w}`, ana),
        to(pa, {
          startsAt: "2031-08-01T10:00:00Z",
          endsAt: "2031-08-01T11:00:00Z",
        }),
        api(t, "PATCH", `/api/time-off/${o}`, ana, { reason: "mudou" }),
        api(t, "DELETE", `/api/time-off/${o}`, ana),
        api(t, "PUT", `/api/professionals/${pa}/services`, ana, {
          serviceIds: [],
        }),
        api(t, "PATCH", `/api/professionals/${pa}`, ana, { active: false }),
      ]);
      burstMs.push(Date.now() - started);
    } finally {
      await held.release();
    }

    expect(reads.map((r) => r.statusCode)).toEqual([200, 200, 200]); // L15: leitura não espera o lock
    expect(writes.map((r) => r.statusCode)).toEqual(Array(8).fill(503));
    for (const r of writes) {
      expect(r.headers["retry-after"]).toBe("1");
      expect(r.json().error).toMatchObject({
        code: "TEMPORARILY_BUSY",
        message: "O sistema está ocupado. Tente novamente em instantes.",
      });
      expect(JSON.stringify(r.json())).not.toMatch(
        /55P03|lock|professionals|organization/i,
      ); // sem detalhes internos
    }
    // Esperou o lock_timeout (2 s) e, no pior caso da fila na mesma linha, ~2× isso (tuple lock + transação dona);
    // em nenhum caso chegou ao timeout da transação interativa (8 s), que viraria 500 em vez de 503.
    expect(burstMs[0]).toBeGreaterThanOrEqual(1800);
    expect(burstMs[0]).toBeLessThan(5500);

    expect(await snapshot()).toEqual(before); // nada gravado
    expect(t.logs()).toContain("lock_timeout (55P03)");

    // nenhuma transação ficou aberta e a mesma operação funciona assim que a trava é liberada
    const c = await rawClient(TEST_DB);
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
        [TEST_DB],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
    expect((await wh(pa, { weekday: 3 })).statusCode).toBe(201);
    expect(
      (
        await api(t, "PATCH", `/api/professionals/${pa}`, ana, {
          active: false,
        })
      ).statusCode,
    ).toBe(200);
  }, 30_000);

  it("a trava de outro profissional não faz esperar; o 503 não vaza a existência de nada de outra empresa", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const bobPro = (
      await api(t, "POST", "/api/professionals", bob, { name: "Bia" })
    ).json().professional.id as string;
    const held = await holdProfessional(bobPro);
    try {
      const started = Date.now();
      // Ana escrevendo no profissional da Bob: 404 imediato (não espera a trava da outra empresa)
      const res = await wh(bobPro);
      expect(res.statusCode).toBe(404);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await held.release();
    }
  });
});

describe("tratador de erros — 55P03 e 40P01 viram 503 genérico", () => {
  async function appThrowing(err: unknown) {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = Fastify({
      logger: buildLoggerOptions(
        { LOG_LEVEL: "debug", DATABASE_URL: "postgres://u:p@h/db" },
        stream,
      ),
    });
    registerErrorHandling(app);
    app.get("/boom", async () => {
      throw err;
    });
    await app.ready();
    return { app, lines };
  }
  const dbError = (state: string) => ({
    code: "P2010",
    message: "raw query failed",
    meta: { driverAdapterError: { cause: { originalCode: state } } },
  });

  it.each([
    ["55P03", "lock_timeout (55P03)", "warn"],
    ["40P01", "deadlock (40P01)", "error"],
  ])("%s => 503 TEMPORARILY_BUSY com Retry-After", async (state, logText) => {
    const { app, lines } = await appThrowing(dbError(state));
    const res = await app.inject({ url: "/boom" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json().error.code).toBe("TEMPORARILY_BUSY");
    expect(lines.join("")).toContain(logText);
    await app.close();
  });

  it("outros erros de banco continuam 500 genérico (não são mascarados como 'ocupado')", async () => {
    const { app } = await appThrowing(dbError("23505"));
    const res = await app.inject({ url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
    await app.close();
  });
});

describe("concorrência dos fluxos da Etapa 9 (amostragem)", () => {
  it("N criações simultâneas de intervalos sobrepostos: exatamente 1 vence, as demais 409 (sem 5xx)", async () => {
    for (let round = 0; round < 3; round++) {
      const day = round + 1;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          wh(pa, { weekday: day, startTime: "09:00", endTime: "12:00" }),
        ),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes, `rodada ${round}`).toEqual([
        201, 409, 409, 409, 409, 409, 409, 409,
      ]);
      expect(
        results
          .filter((r) => r.statusCode === 409)
          .every((r) => r.json().error.code === "WORKING_HOURS_OVERLAP"),
      ).toBe(true);
    }
    expect(await t.prisma.workingHours.count()).toBe(3);
  });

  it("PATCHs simultâneos que levariam dois intervalos a colidir: no máximo um vence e a invariante vale", async () => {
    for (let round = 0; round < 3; round++) {
      const a = (
        await wh(pa, { weekday: 2, startTime: "08:00", endTime: "09:00" })
      ).json().workingHours.id as string;
      const b = (
        await wh(pa, { weekday: 3, startTime: "08:00", endTime: "09:00" })
      ).json().workingHours.id as string;
      const [ra, rb] = await Promise.all([
        api(t, "PATCH", `/api/working-hours/${a}`, ana, { weekday: 4 }),
        api(t, "PATCH", `/api/working-hours/${b}`, ana, { weekday: 4 }),
      ]);
      expect([ra.statusCode, rb.statusCode].sort(), `rodada ${round}`).toEqual([
        200, 409,
      ]);
      await t.prisma.workingHours.deleteMany();
    }
  });

  it("alterar e remover a MESMA linha em paralelo: um efeito coerente, o outro 404 ou 200 (nunca 5xx)", async () => {
    for (let round = 0; round < 6; round++) {
      const id = (await wh(pa, { weekday: round % 7 })).json().workingHours
        .id as string;
      const results = await Promise.all([
        api(t, "PATCH", `/api/working-hours/${id}`, ana, { endTime: "13:00" }),
        api(t, "DELETE", `/api/working-hours/${id}`, ana),
        api(t, "PATCH", `/api/working-hours/${id}`, ana, { endTime: "14:00" }),
      ]);
      for (const r of results)
        expect([200, 204, 404], `rodada ${round}`).toContain(r.statusCode);
      expect(results.some((r) => r.statusCode === 204)).toBe(true);
      expect(await t.prisma.workingHours.count()).toBe(0); // o DELETE sempre vence no fim: nenhuma linha "ressuscita"
      await t.prisma.workingHours.deleteMany();
    }
  });

  it("sem o lock, a rede de segurança do banco mantém a invariante (6.1, teste 8): 1 vence, o resto 23P01 ou 40P01", async () => {
    const clients = await Promise.all(
      Array.from({ length: 6 }, () => rawClient(TEST_DB)),
    );
    try {
      const outcomes = await Promise.all(
        clients.map(async (c) => {
          try {
            await c.query(
              `INSERT INTO working_hours (id, organization_id, professional_id, weekday, start_minute, end_minute, updated_at)
               VALUES (gen_random_uuid(), $1, $2, 6, 540, 720, now())`,
              [orgId, pa],
            );
            return "ok";
          } catch (e) {
            return (e as { code: string }).code;
          }
        }),
      );
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      expect(
        outcomes
          .filter((o) => o !== "ok")
          .every((o) => o === "23P01" || o === "40P01"),
      ).toBe(true);
      expect(await t.prisma.workingHours.count({ where: { weekday: 6 } })).toBe(
        1,
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("carga mista aleatória sobre 3 profissionais: nenhum 5xx/503, nenhum LockOrderViolation e invariantes preservadas", async () => {
    const pc = await mkPro("Eva");
    const pros = [pa, pb, pc];
    const svcs = await Promise.all([mkSvc("A"), mkSvc("B"), mkSvc("C")]);
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const hhmm = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const interval = () => {
      const s = rnd(88) * 15; // 0 .. 1305
      const e = Math.min(1440, s + (1 + rnd(8)) * 15);
      return { startTime: hhmm(s), endTime: hhmm(e) };
    };
    const created: string[] = [];
    const ops: Array<() => Promise<{ statusCode: number }>> = [];
    for (let i = 0; i < 90; i++) {
      const p = pros[rnd(3)]!;
      const kind = rnd(8);
      ops.push(async () => {
        if (kind === 0 || kind === 1) {
          const r = await wh(p, { weekday: rnd(3), ...interval() });
          if (r.statusCode === 201) created.push(r.json().workingHours.id);
          return r;
        }
        if (kind === 2 && created.length)
          return api(
            t,
            "PATCH",
            `/api/working-hours/${created[rnd(created.length)]}`,
            ana,
            { weekday: rnd(3), ...interval() },
          );
        if (kind === 3 && created.length)
          return api(
            t,
            "DELETE",
            `/api/working-hours/${created[rnd(created.length)]}`,
            ana,
          );
        if (kind === 4)
          return to(p, {
            startsAt: `2031-0${1 + rnd(9)}-1${rnd(9)}T10:00:00Z`,
            endsAt: `2031-0${1 + rnd(9)}-2${rnd(9)}T10:00:00Z`,
          });
        if (kind === 5)
          return api(t, "PUT", `/api/professionals/${p}/services`, ana, {
            serviceIds: svcs.filter(() => rnd(2) === 0),
          });
        if (kind === 6)
          return api(t, "PATCH", `/api/professionals/${p}`, ana, {
            active: rnd(2) === 0,
          });
        return api(t, "GET", `/api/working-hours?professionalId=${p}`, ana);
      });
    }
    const results = await Promise.all(ops.map((op) => op()));
    const statuses = new Set(results.map((r) => r.statusCode));
    for (const s of statuses)
      expect(
        [200, 201, 204, 400, 404, 409],
        `status inesperado ${s}`,
      ).toContain(s);

    const logs = t.logs();
    expect(logs).not.toContain("LockOrderViolation");
    expect(logs).not.toContain("LockCoverageViolation");
    expect(logs).not.toContain("40P01");
    expect(logs).not.toContain("TEMPORARILY_BUSY");

    const c = await rawClient(TEST_DB);
    try {
      const overlaps = await c.query(`
        SELECT a.id FROM working_hours a JOIN working_hours b
          ON a.professional_id = b.professional_id AND a.weekday = b.weekday AND a.id < b.id
         AND a.start_minute < b.end_minute AND b.start_minute < a.end_minute`);
      expect(overlaps.rowCount).toBe(0);
      const bad = await c.query(
        `SELECT 1 FROM time_off WHERE ends_at <= starts_at`,
      );
      expect(bad.rowCount).toBe(0);
    } finally {
      await c.end();
    }
  }, 60_000);
});
