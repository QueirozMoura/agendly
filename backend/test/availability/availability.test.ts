// Etapa 9 — CRUD de WorkingHours e TimeOff: validação, sobreposição, permissões, integridade no banco.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDbError } from "../../src/lib/db/errors.ts";
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
let pro: string;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(201);
  pro = await mkPro(ana);
});
afterEach(() => t.close());

const mkPro = async (user: TestUser, name = "Carla") =>
  (await api(t, "POST", "/api/professionals", user, { name })).json()
    .professional.id as string;

type Wh = {
  id: string;
  professionalId: string;
  weekday: number;
  startTime: string;
  endTime: string;
};
const whBody = (over: Record<string, unknown> = {}) => ({
  professionalId: pro,
  weekday: 1,
  startTime: "09:00",
  endTime: "12:00",
  ...over,
});
const addWh = (over: Record<string, unknown> = {}, user = ana) =>
  api(t, "POST", "/api/working-hours", user, whBody(over));
const listWh = (professionalId = pro, user = ana) =>
  api(t, "GET", `/api/working-hours?professionalId=${professionalId}`, user);

type To = {
  id: string;
  professionalId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};
const toBody = (over: Record<string, unknown> = {}) => ({
  professionalId: pro,
  startsAt: "2031-07-01T10:00:00-03:00",
  endsAt: "2031-07-01T12:00:00-03:00",
  ...over,
});
const addTo = (over: Record<string, unknown> = {}, user = ana) =>
  api(t, "POST", "/api/time-off", user, toBody(over));
const listTo = (professionalId = pro, user = ana) =>
  api(t, "GET", `/api/time-off?professionalId=${professionalId}`, user);

describe("WorkingHours — criação, listagem e formato", () => {
  it("cria um intervalo semanal em hora local e lista ordenado por dia e início", async () => {
    const res = await addWh({
      weekday: 3,
      startTime: "14:00",
      endTime: "18:30",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().workingHours).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      professionalId: pro,
      weekday: 3,
      startTime: "14:00",
      endTime: "18:30",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await addWh({ weekday: 1, startTime: "13:00", endTime: "14:00" });
    await addWh({ weekday: 1, startTime: "09:00", endTime: "12:00" });
    const list = (await listWh()).json().workingHours as Wh[];
    expect(list.map((w) => `${w.weekday} ${w.startTime}-${w.endTime}`)).toEqual(
      ["1 09:00-12:00", "1 13:00-14:00", "3 14:00-18:30"],
    );
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    expect(JSON.stringify(res.json())).not.toContain(org.id);
    expect(
      (await t.prisma.workingHours.findFirstOrThrow()).organizationId,
    ).toBe(org.id);
  });

  it("aceita expediente até 24:00 e a semana inteira (0 = domingo ... 6 = sábado)", async () => {
    for (let d = 0; d <= 6; d++)
      expect(
        (await addWh({ weekday: d, startTime: "00:00", endTime: "24:00" }))
          .statusCode,
      ).toBe(201);
    expect(((await listWh()).json().workingHours as Wh[]).at(-1)).toMatchObject(
      { endTime: "24:00" },
    );
  });

  it("intervalos encostados são permitidos; sobrepostos => 409 WORKING_HOURS_OVERLAP e nada muda", async () => {
    expect(
      (await addWh({ startTime: "09:00", endTime: "12:00" })).statusCode,
    ).toBe(201);
    expect(
      (await addWh({ startTime: "12:00", endTime: "13:00" })).statusCode,
    ).toBe(201); // encosta
    for (const [s, e] of [
      ["11:45", "12:15"],
      ["09:00", "09:15"],
      ["08:00", "13:00"],
      ["10:00", "11:00"],
    ]) {
      const res = await addWh({ startTime: s, endTime: e });
      expect(res.statusCode, `${s}-${e}`).toBe(409);
      expect(res.json().error.code).toBe("WORKING_HOURS_OVERLAP");
    }
    expect(await t.prisma.workingHours.count()).toBe(2);
    // outro dia ou outro profissional com o mesmo horário não conflita
    expect((await addWh({ weekday: 2 })).statusCode).toBe(201);
    const other = await mkPro(ana, "Davi");
    expect((await addWh({ professionalId: other })).statusCode).toBe(201);
  });

  it("entradas inválidas => 400 e nada é gravado", async () => {
    const bad: unknown[] = [
      whBody({ weekday: 7 }),
      whBody({ weekday: -1 }),
      whBody({ weekday: 1.5 }),
      whBody({ weekday: "1" }),
      whBody({ startTime: "9:00" }),
      whBody({ startTime: "09:10" }), // fora da grade de 15 min
      whBody({ endTime: "12:07" }),
      whBody({ startTime: "25:00" }),
      whBody({ startTime: "24:00", endTime: "24:00" }),
      whBody({ startTime: "12:00", endTime: "12:00" }),
      whBody({ startTime: "13:00", endTime: "12:00" }),
      whBody({ professionalId: "não-é-uuid" }),
      whBody({ organizationId: "00000000-0000-7000-8000-000000000000" }),
      whBody({ id: "00000000-0000-7000-8000-000000000000" }),
      { weekday: 1, startTime: "09:00", endTime: "12:00" }, // sem professionalId
      {},
    ];
    for (const body of bad) {
      const res = await api(t, "POST", "/api/working-hours", ana, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(await t.prisma.workingHours.count()).toBe(0);
  });

  it("profissional inexistente => 404 (e a listagem exige professionalId válido)", async () => {
    const ghost = "00000000-0000-7000-8000-000000000000";
    expect((await addWh({ professionalId: ghost })).statusCode).toBe(404);
    expect((await listWh(ghost)).statusCode).toBe(404);
    expect((await api(t, "GET", "/api/working-hours", ana)).statusCode).toBe(
      400,
    );
    expect(
      (await api(t, "GET", `/api/working-hours?professionalId=${pro}&x=1`, ana))
        .statusCode,
    ).toBe(400);
    expect(
      (await api(t, "GET", "/api/working-hours?professionalId=abc", ana))
        .statusCode,
    ).toBe(400);
  });
});

describe("WorkingHours — alteração e remoção", () => {
  it("altera dia e horários; revalida a sobreposição contra os OUTROS intervalos (não contra si mesmo)", async () => {
    const a = (await addWh({ startTime: "09:00", endTime: "12:00" })).json()
      .workingHours as Wh;
    const b = (await addWh({ startTime: "13:00", endTime: "17:00" })).json()
      .workingHours as Wh;

    const grow = await api(t, "PATCH", `/api/working-hours/${a.id}`, ana, {
      endTime: "12:30",
    });
    expect(grow.statusCode).toBe(200); // cresce sem conflitar consigo mesmo
    expect(grow.json().workingHours).toMatchObject({
      startTime: "09:00",
      endTime: "12:30",
    });

    const clash = await api(t, "PATCH", `/api/working-hours/${a.id}`, ana, {
      endTime: "13:15",
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("WORKING_HOURS_OVERLAP");

    const move = await api(t, "PATCH", `/api/working-hours/${b.id}`, ana, {
      weekday: 4,
    });
    expect(move.json().workingHours).toMatchObject({
      weekday: 4,
      startTime: "13:00",
    });
    // volta ao dia do outro intervalo, agora livre
    expect(
      (
        await api(t, "PATCH", `/api/working-hours/${a.id}`, ana, {
          weekday: 4,
          startTime: "08:00",
          endTime: "13:00",
        })
      ).statusCode,
    ).toBe(200);
    const row = await t.prisma.workingHours.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(row).toMatchObject({ weekday: 4, startMinute: 480, endMinute: 780 });
  });

  it("resultado incoerente do PATCH (início >= fim após mesclar) => 400; corpo vazio ou campo proibido => 400", async () => {
    const a = (await addWh()).json().workingHours as Wh;
    const url = `/api/working-hours/${a.id}`;
    expect(
      (await api(t, "PATCH", url, ana, { startTime: "12:00" })).statusCode,
    ).toBe(400);
    expect(
      (await api(t, "PATCH", url, ana, { endTime: "09:00" })).statusCode,
    ).toBe(400);
    expect((await api(t, "PATCH", url, ana, {})).statusCode).toBe(400);
    expect(
      (await api(t, "PATCH", url, ana, { professionalId: pro })).statusCode,
    ).toBe(400); // o dono não muda
    expect(
      (await api(t, "PATCH", url, ana, { startTime: "09:05" })).statusCode,
    ).toBe(400);
    expect(
      (await api(t, "PATCH", url, ana, { organizationId: "x" })).statusCode,
    ).toBe(400);
    expect(
      await t.prisma.workingHours.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      startMinute: 540,
      endMinute: 720,
    });
  });

  it("remove (204) e a remoção repetida/id inexistente/id malformado => 404 idêntico", async () => {
    const a = (await addWh()).json().workingHours as Wh;
    expect(
      (await api(t, "DELETE", `/api/working-hours/${a.id}`, ana)).statusCode,
    ).toBe(204);
    expect(await t.prisma.workingHours.count()).toBe(0);
    const responses = await Promise.all(
      [a.id, "00000000-0000-7000-8000-000000000000", "malformado"].map((id) =>
        api(t, "DELETE", `/api/working-hours/${id}`, ana),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([404, 404, 404]);
    expect(
      new Set(
        responses.map((r) =>
          JSON.stringify({
            ...r.json(),
            error: { ...r.json().error, requestId: 0 },
          }),
        ),
      ).size,
    ).toBe(1);
    expect(
      (await api(t, "PATCH", `/api/working-hours/${a.id}`, ana, { weekday: 2 }))
        .statusCode,
    ).toBe(404);
  });
});

describe("TimeOff — criação, listagem, alteração e remoção", () => {
  it("cria com instantes ISO (qualquer offset), guarda em UTC e lista por início", async () => {
    const res = await addTo({ reason: "  Consulta médica " });
    expect(res.statusCode).toBe(201);
    expect(res.json().timeOff).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      professionalId: pro,
      startsAt: "2031-07-01T13:00:00.000Z",
      endsAt: "2031-07-01T15:00:00.000Z",
      reason: "Consulta médica",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await addTo({
      startsAt: "2031-06-01T00:00:00Z",
      endsAt: "2031-06-02T00:00:00Z",
      reason: "   ",
    });
    const list = (await listTo()).json().timeOff as To[];
    expect(list.map((o) => o.startsAt)).toEqual([
      "2031-06-01T00:00:00.000Z",
      "2031-07-01T13:00:00.000Z",
    ]);
    expect(list[0]?.reason).toBeNull(); // texto em branco vira nulo
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    expect((await t.prisma.timeOff.findFirstOrThrow()).organizationId).toBe(
      org.id,
    );
  });

  it("folgas podem se sobrepor entre si (o plano não proíbe) e o passado é aceito", async () => {
    expect((await addTo()).statusCode).toBe(201);
    expect((await addTo()).statusCode).toBe(201);
    expect(
      (
        await addTo({
          startsAt: "2020-01-01T00:00:00Z",
          endsAt: "2020-01-02T00:00:00Z",
        })
      ).statusCode,
    ).toBe(201);
    expect(await t.prisma.timeOff.count()).toBe(3);
  });

  it("entradas inválidas => 400 e nada é gravado", async () => {
    const bad: unknown[] = [
      toBody({ endsAt: "2031-07-01T10:00:00-03:00" }), // fim == início
      toBody({ endsAt: "2031-07-01T09:00:00-03:00" }), // fim < início
      toBody({ startsAt: "2031-07-01T10:00:00" }), // sem fuso
      toBody({ startsAt: "01/07/2031" }),
      toBody({ startsAt: 1_900_000_000 }),
      toBody({
        startsAt: "1999-12-31T00:00:00Z",
        endsAt: "2000-01-02T00:00:00Z",
      }),
      toBody({
        startsAt: "2031-01-01T00:00:00Z",
        endsAt: "2101-01-01T00:00:00Z",
      }),
      toBody({
        startsAt: "2031-01-01T00:00:00Z",
        endsAt: "2032-01-03T00:00:00Z",
      }), // > 366 dias
      toBody({ reason: "x".repeat(201) }),
      toBody({ reason: 5 }),
      toBody({ professionalId: "x" }),
      toBody({ organizationId: "00000000-0000-7000-8000-000000000000" }),
      { professionalId: pro },
    ];
    for (const body of bad) {
      const res = await api(t, "POST", "/api/time-off", ana, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await t.prisma.timeOff.count()).toBe(0);
    expect(
      (await addTo({ professionalId: "00000000-0000-7000-8000-000000000000" }))
        .statusCode,
    ).toBe(404);
  });

  it("altera início, fim e motivo mesclando com o valor atual; resultado incoerente => 400", async () => {
    const o = (await addTo({ reason: "férias" })).json().timeOff as To;
    const url = `/api/time-off/${o.id}`;
    const ok = await api(t, "PATCH", url, ana, {
      endsAt: "2031-07-01T18:00:00Z",
    });
    expect(ok.json().timeOff).toMatchObject({
      startsAt: o.startsAt,
      endsAt: "2031-07-01T18:00:00.000Z",
      reason: "férias",
    });
    expect(
      (await api(t, "PATCH", url, ana, { reason: null })).json().timeOff.reason,
    ).toBeNull();
    expect(
      (await api(t, "PATCH", url, ana, { startsAt: "2031-07-02T00:00:00Z" }))
        .statusCode,
    ).toBe(400);
    expect((await api(t, "PATCH", url, ana, {})).statusCode).toBe(400);
    expect(
      (await api(t, "PATCH", url, ana, { professionalId: pro })).statusCode,
    ).toBe(400);
    expect(
      (
        await t.prisma.timeOff.findUniqueOrThrow({ where: { id: o.id } })
      ).endsAt.toISOString(),
    ).toBe("2031-07-01T18:00:00.000Z");
  });

  it("remove (204); id repetido/inexistente/malformado => 404", async () => {
    const o = (await addTo()).json().timeOff as To;
    expect(
      (await api(t, "DELETE", `/api/time-off/${o.id}`, ana)).statusCode,
    ).toBe(204);
    for (const id of [
      o.id,
      "00000000-0000-7000-8000-000000000000",
      "malformado",
    ])
      expect(
        (await api(t, "DELETE", `/api/time-off/${id}`, ana)).statusCode,
      ).toBe(404);
    expect(await t.prisma.timeOff.count()).toBe(0);
  });

  it("limite de sanidade de 1000 folgas por profissional => 422 TIME_OFF_LIMIT_REACHED", async () => {
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const c = await rawClient(TEST_DB);
    try {
      await c.query(
        `INSERT INTO time_off (id, organization_id, professional_id, starts_at, ends_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, now() + (g || ' hours')::interval,
                now() + (g || ' hours')::interval + interval '30 minutes', now()
           FROM generate_series(1, 1000) g`,
        [org.id, pro],
      );
    } finally {
      await c.end();
    }
    const res = await addTo();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("TIME_OFF_LIMIT_REACHED");
    expect(await t.prisma.timeOff.count()).toBe(1000);
  });
});

describe("sessão, permissão e cabeçalhos", () => {
  it("sem sessão => 401; sem empresa ativa => 403; escrita sem Origin => 403; X-Active-Org divergente => 409", async () => {
    const w = (await addWh()).json().workingHours as Wh;
    const o = (await addTo()).json().timeOff as To;
    const calls: Array<[string, string, unknown?]> = [
      ["GET", `/api/working-hours?professionalId=${pro}`],
      ["POST", "/api/working-hours", whBody()],
      ["PATCH", `/api/working-hours/${w.id}`, { weekday: 2 }],
      ["DELETE", `/api/working-hours/${w.id}`],
      ["GET", `/api/time-off?professionalId=${pro}`],
      ["POST", "/api/time-off", toBody()],
      ["PATCH", `/api/time-off/${o.id}`, { reason: "x" }],
      ["DELETE", `/api/time-off/${o.id}`],
    ];
    for (const [m, url, body] of calls)
      expect(
        (await api(t, m as "GET", url, undefined, body)).statusCode,
        `${m} ${url}`,
      ).toBe(401);

    const noOrg = await signupVerified(t, "sem-empresa@example.com");
    for (const [m, url, body] of calls)
      expect(
        (await api(t, m as "GET", url, noOrg, body)).statusCode,
        `${m} ${url}`,
      ).toBe(403);

    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/api/working-hours",
      headers: { cookie: ana.cookie, "content-type": "application/json" },
      payload: JSON.stringify(whBody({ weekday: 5 })),
    });
    expect(noOrigin.statusCode).toBe(403);
    const mismatch = await api(
      t,
      "POST",
      "/api/working-hours",
      ana,
      whBody({ weekday: 5 }),
      { "x-active-org": "outra-empresa" },
    );
    expect(mismatch.statusCode).toBe(409);
    expect(await t.prisma.workingHours.count()).toBe(1);
  });

  it("respostas não são cacheáveis", async () => {
    expect((await listWh()).headers["cache-control"]).toBe("no-store");
    expect((await listTo()).headers["cache-control"]).toBe("no-store");
  });
});

describe("integridade no banco (SQL cru) — as regras valem sem a aplicação", () => {
  async function exec(sql: string, params: unknown[] = []) {
    const c = await rawClient(TEST_DB);
    try {
      return await c.query(sql, params);
    } catch (err) {
      return err as Error;
    } finally {
      await c.end();
    }
  }
  const sqlState = (e: unknown) => (e as { code?: string }).code;

  async function ids() {
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    return { org: org.id };
  }
  const insertWh = (
    org: string,
    p: string,
    weekday: number,
    s: number,
    e: number,
  ) =>
    exec(
      `INSERT INTO working_hours (id, organization_id, professional_id, weekday, start_minute, end_minute, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
      [org, p, weekday, s, e],
    );

  it("CHECKs de faixa: dia 0–6, 0 <= início < fim <= 1440, múltiplos de 15 => 23514", async () => {
    const { org } = await ids();
    const invalidRanges: Array<[number, number, number]> = [
      [7, 540, 600],
      [-1, 540, 600],
      [1, 600, 600],
      [1, 660, 600],
      [1, -15, 60],
      [1, 0, 1455],
      [1, 545, 600],
      [1, 540, 605],
    ];
    for (const [d, s, e] of invalidRanges) {
      const err = await insertWh(org, pro, d, s, e);
      expect(sqlState(err), `${d} ${s}-${e}`).toBe("23514");
    }
    expect(await t.prisma.workingHours.count()).toBe(0);
    expect(sqlState(await insertWh(org, pro, 1, 0, 1440))).toBeUndefined();
  });

  it("EXCLUDE: sobreposição no mesmo profissional e dia => 23P01; encostar, outro dia e outro profissional passam", async () => {
    const { org } = await ids();
    const other = await mkPro(ana, "Davi");
    expect(sqlState(await insertWh(org, pro, 1, 540, 720))).toBeUndefined();
    const err = await insertWh(org, pro, 1, 705, 810);
    expect(sqlState(err)).toBe("23P01");
    expect(classifyDbError(err)).toBe("exclusion_violation");
    expect(sqlState(await insertWh(org, pro, 1, 720, 810))).toBeUndefined(); // encosta
    expect(sqlState(await insertWh(org, pro, 2, 540, 720))).toBeUndefined();
    expect(sqlState(await insertWh(org, other, 1, 540, 720))).toBeUndefined();
  });

  it("time_off: ends_at > starts_at (23514)", async () => {
    const { org } = await ids();
    const err = await exec(
      `INSERT INTO time_off (id, organization_id, professional_id, starts_at, ends_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '2031-01-01T10:00Z', '2031-01-01T10:00Z', now())`,
      [org, pro],
    );
    expect(sqlState(err)).toBe("23514");
  });

  it("FK composta: profissional de OUTRA empresa => 23503 nas duas tabelas; RESTRICT protege o profissional", async () => {
    const { org } = await ids();
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia-bob");
    const bobPro = await mkPro(bob, "Bia");
    const wh = await insertWh(org, bobPro, 1, 540, 600);
    expect(sqlState(wh)).toBe("23503");
    const to = await exec(
      `INSERT INTO time_off (id, organization_id, professional_id, starts_at, ends_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '2031-01-01T10:00Z', '2031-01-01T11:00Z', now())`,
      [org, bobPro],
    );
    expect(sqlState(to)).toBe("23503");
    expect((wh as Error).message).toContain(
      "working_hours_organization_id_professional_id_fkey",
    );
    expect((to as Error).message).toContain(
      "time_off_organization_id_professional_id_fkey",
    );

    await addWh();
    await addTo();
    const del = await exec("DELETE FROM professionals WHERE id = $1", [pro]);
    expect(classifyDbError(del)).toBe("foreign_key_violation"); // 23001 (RESTRICT)
    expect(await t.prisma.professional.count({ where: { id: pro } })).toBe(1);
  });
});
