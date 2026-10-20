// Revisão humana da Etapa 10: (1) concluir / não comparecer só depois do FIM do atendimento (relógio injetado, limites
// temporais e corrida com remarcação); (2) conflitos R4 com total real e `truncated` (nunca uma lista parcial
// apresentada como completa). Integração com Postgres real.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  MONDAY,
  at,
  bookOk,
  makeBookable,
  newCustomer,
  type Bookable,
} from "../support/booking.ts";

let t: AuthTestApp;
let ana: TestUser;
let b: Bookable;
let orgId: string;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
  orgId = (
    await t.prisma.organization.findUniqueOrThrow({ where: { slug: "salao" } })
  ).id;
  b = await makeBookable(t, ana, { durationMinutes: 30, bufferMinutes: 10 });
});
afterEach(() => t.close());

const code = (r: { json: () => { error: { code: string } } }) =>
  r.json().error.code;
const make = (hhmm: string, n = 1) =>
  bookOk(t, ana, {
    ...b,
    startsAt: at(MONDAY, hhmm),
    customer: newCustomer(n),
  });
const act = (id: string, action: string, body: unknown) =>
  api(t, "POST", `/api/appointments/${id}/${action}`, ana, body);
const row = (id: string) =>
  t.prisma.appointment.findUniqueOrThrow({ where: { id } });
/** Move o relógio de teste para um instante exato. */
const setClock = (iso: string) =>
  t.clock.advance(new Date(iso).getTime() - t.clock.now().getTime());

describe("concluir e não comparecer só depois do FIM do atendimento (ends_at <= now)", () => {
  // atendimento das 10:00 locais: [13:00Z, 13:30Z), buffer até 13:40Z
  it.each(["complete", "no-show"])(
    "%s: antes do início, no meio e 1 ms antes do fim => 422 APPOINTMENT_NOT_FINISHED; no fim exato e depois => 200",
    async (action) => {
      const a = await make("10:00");
      for (const iso of [
        "2031-03-03T12:00:00.000Z",
        "2031-03-03T13:00:00.000Z",
        "2031-03-03T13:15:00.000Z",
        "2031-03-03T13:29:59.999Z",
      ]) {
        setClock(iso);
        const res = await act(a.id, action, { version: 1 });
        expect([res.statusCode, code(res)], iso).toEqual([
          422,
          "APPOINTMENT_NOT_FINISHED",
        ]);
        expect(await row(a.id)).toMatchObject({
          status: "SCHEDULED",
          version: 1,
        }); // nada mudou
      }
      setClock("2031-03-03T13:30:00.000Z"); // exatamente ends_at
      const ok = await act(a.id, action, { version: 1 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().appointment.status).toBe(
        action === "complete" ? "COMPLETED" : "NO_SHOW",
      );
    },
  );

  it("o buffer não conta: depois de ends_at e antes de blocked_until já pode concluir; o horário só é liberado depois que terminou", async () => {
    const a = await make("10:00");
    setClock("2031-03-03T13:35:00.000Z"); // dentro do buffer (até 13:40)
    expect((await act(a.id, "complete", { version: 1 })).statusCode).toBe(200);
  });

  it("cancelar e confirmar NÃO têm a restrição (antes do fim continuam permitidos)", async () => {
    const a = await make("10:00");
    const n = await make("11:00", 2);
    setClock("2031-03-03T13:10:00.000Z");
    expect((await act(a.id, "confirm", { version: 1 })).statusCode).toBe(200);
    expect((await act(n.id, "cancel", { version: 1 })).statusCode).toBe(200);
  });

  it("ordem das checagens: versão desatualizada (409) e transição inválida (409) vêm antes do 422; 404 de outra empresa continua 404", async () => {
    const a = await make("10:00");
    const stale = await act(a.id, "complete", { version: 9 });
    expect([stale.statusCode, code(stale)]).toEqual([409, "STALE_VERSION"]);
    await act(a.id, "cancel", { version: 1 });
    const invalid = await act(a.id, "complete", { version: 2 });
    expect([invalid.statusCode, code(invalid)]).toEqual([
      409,
      "INVALID_STATUS_TRANSITION",
    ]);
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const foreign = await api(
      t,
      "POST",
      `/api/appointments/${a.id}/complete`,
      bob,
      { version: 2 },
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("remarcar para o futuro um atendimento que já terminou volta a bloquear a conclusão (vale o ends_at ATUAL)", async () => {
    const a = await make("10:00");
    setClock("2031-03-03T14:00:00.000Z"); // 11:00 locais: já terminou
    const moved = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "15:00"),
      version: 1,
    });
    expect(moved.statusCode).toBe(200);
    const res = await act(a.id, "complete", { version: 2 });
    expect([res.statusCode, code(res)]).toEqual([
      422,
      "APPOINTMENT_NOT_FINISHED",
    ]);
  });

  it("corrida: um atendimento terminado é remarcado para o futuro enquanto se tenta concluir => STALE_VERSION, nunca conclui o que deixou de ter terminado", async () => {
    const a = await make("10:00");
    setClock("2031-03-03T14:00:00.000Z");
    const t1 = await rawClient(TEST_DB);
    await t1.query("BEGIN");
    await t1.query(
      "SELECT id FROM appointments WHERE id = $1 FOR NO KEY UPDATE",
      [a.id],
    );
    await t1.query(
      `UPDATE appointments SET starts_at = '2031-03-03T18:00:00Z', ends_at = '2031-03-03T18:30:00Z',
         blocked_until = '2031-03-03T18:40:00Z', version = version + 1 WHERE id = $1`,
      [a.id],
    );
    const pending = act(a.id, "complete", { version: 1 }); // leu o atendimento (terminado) e espera a linha
    await new Promise((r) => setTimeout(r, 600));
    await t1.query("COMMIT");
    await t1.end();
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([409, "STALE_VERSION"]);
    expect(await row(a.id)).toMatchObject({ status: "SCHEDULED", version: 2 });
  });
});

describe("R4 — conflitos com total real, limite explícito e `truncated`", () => {
  async function seedAppointments(
    n: number,
    stepDays: number,
    startIso: string,
  ) {
    const c = await rawClient(TEST_DB);
    try {
      const cust = await c.query(
        `INSERT INTO customers (id, organization_id, name, phone_e164, updated_at) VALUES (gen_random_uuid(), $1, 'Cliente', '+5511900000001', now()) RETURNING id`,
        [orgId],
      );
      await c.query(
        `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until,
           service_name_snapshot, duration_minutes_snapshot, buffer_minutes_snapshot, source, version, updated_at)
         SELECT gen_random_uuid(), $1, $2, $3, $4, s, s + interval '30 minutes', s + interval '40 minutes', 'Corte', 30, 10, 'PANEL', 1, now()
           FROM (SELECT $5::timestamptz + (g * $6::int) * interval '1 day' AS s FROM generate_series(0, $7::int - 1) g) x`,
        [
          orgId,
          b.professionalId,
          b.serviceId,
          cust.rows[0].id,
          startIso,
          stepDays,
          n,
        ],
      );
    } finally {
      await c.end();
    }
  }
  const timeOffOver = (days: number) =>
    api(t, "POST", "/api/time-off", ana, {
      professionalId: b.professionalId,
      startsAt: "2031-03-03T00:00:00Z",
      endsAt: new Date(Date.UTC(2031, 2, 3 + days)).toISOString(),
    });

  it.each([
    [1, false],
    [99, false],
    [100, false],
    [101, true],
    [130, true],
  ])(
    "TimeOff sobre %i agendamentos: totalCount real; lista de até 100; truncated=%s; nada criado nem cancelado",
    async (n, truncated) => {
      await seedAppointments(n, 1, "2031-03-03T13:00:00Z"); // um por dia, às 10:00 locais
      const res = await timeOffOver(n + 1);
      expect([res.statusCode, code(res)]).toEqual([
        409,
        "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
      ]);
      const d = res.json().error.details as {
        conflicts: Array<{ id: string; startsAt: string }>;
        totalCount: number;
        truncated: boolean;
      };
      expect(d.totalCount).toBe(n);
      expect(d.conflicts).toHaveLength(Math.min(n, 100));
      expect(d.truncated).toBe(truncated);
      expect(d.conflicts.map((x) => x.startsAt)).toEqual(
        [...d.conflicts.map((x) => x.startsAt)].sort(),
      ); // por início
      expect(d.conflicts[0]!.startsAt).toBe("2031-03-03T13:00:00.000Z"); // os mais próximos primeiro
      expect(new Set(d.conflicts.map((x) => x.id)).size).toBe(
        d.conflicts.length,
      );
      expect(Buffer.byteLength(res.body)).toBeLessThan(64 * 1024); // resposta limitada
      expect(await t.prisma.timeOff.count()).toBe(0);
      expect(
        await t.prisma.appointment.count({ where: { status: "SCHEDULED" } }),
      ).toBe(n); // ninguém foi cancelado
    },
  );

  it("PATCH de folga com muitos conflitos segue o mesmo contrato e mantém a folga como estava", async () => {
    await seedAppointments(120, 1, "2031-03-03T13:00:00Z");
    const off = (
      await api(t, "POST", "/api/time-off", ana, {
        professionalId: b.professionalId,
        startsAt: "2030-01-01T00:00:00Z",
        endsAt: "2030-01-02T00:00:00Z",
      })
    ).json().timeOff;
    const res = await api(t, "PATCH", `/api/time-off/${off.id}`, ana, {
      startsAt: "2031-03-03T00:00:00Z",
      endsAt: "2031-07-10T00:00:00Z",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      totalCount: 120,
      truncated: true,
    });
    expect(
      (
        await t.prisma.timeOff.findUniqueOrThrow({ where: { id: off.id } })
      ).startsAt.toISOString(),
    ).toBe("2030-01-01T00:00:00.000Z");
  });

  it("WorkingHours: apagar o expediente com 130 agendamentos futuros => totalCount 130, 100 listados, truncated; resolver em rodadas até passar", async () => {
    const mon = (
      (
        await api(
          t,
          "GET",
          `/api/working-hours?professionalId=${b.professionalId}`,
          ana,
        )
      ).json().workingHours as Array<{ id: string; weekday: number }>
    ).find((h) => h.weekday === 1)!;
    await seedAppointments(130, 7, "2031-03-03T13:00:00Z"); // 130 segundas-feiras às 10:00 locais
    const attempt = () =>
      api(t, "DELETE", `/api/working-hours/${mon.id}`, ana, {});
    const first = await attempt();
    expect([first.statusCode, code(first)]).toEqual([
      409,
      "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
    ]);
    const d1 = first.json().error.details as {
      conflicts: Array<{ id: string }>;
      totalCount: number;
      truncated: boolean;
    };
    expect([d1.totalCount, d1.conflicts.length, d1.truncated]).toEqual([
      130,
      100,
      true,
    ]);
    expect(await t.prisma.workingHours.count({ where: { id: mon.id } })).toBe(
      1,
    );

    // o usuário cancela os listados (aqui direto no banco) e repete: restam 30, agora a lista é completa
    await t.prisma.appointment.updateMany({
      where: { id: { in: d1.conflicts.map((x) => x.id) } },
      data: { status: "CANCELLED" },
    });
    const second = await attempt();
    const d2 = second.json().error.details as {
      conflicts: unknown[];
      totalCount: number;
      truncated: boolean;
    };
    expect([
      second.statusCode,
      d2.totalCount,
      d2.conflicts.length,
      d2.truncated,
    ]).toEqual([409, 30, 30, false]);

    await t.prisma.appointment.updateMany({
      where: { status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
    expect((await attempt()).statusCode).toBe(204);
  });
});
