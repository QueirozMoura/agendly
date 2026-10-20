// Etapa 10 — CONCORRÊNCIA DETERMINÍSTICA (Postgres real). Aqui os entrelaçamentos são forçados por uma conexão `pg`
// à parte que SEGURA uma trava de verdade (L1, L2, L3, L13, L14, L15, 6.4 teste 8); as repetições com paralelismo
// livre (L12, 6.4 teste 4) são amostragem. O estresse aleatório (L4, L6, L7) está em stress.test.ts.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../../src/jobs/maintenance.ts";
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
  book,
  bookOk,
  makeBookable,
  makeProfessional,
  newCustomer,
  type Bookable,
} from "../support/booking.ts";

let t: AuthTestApp;
let ana: TestUser;
let b: Bookable;
let orgId: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
  orgId = (
    await t.prisma.organization.findUniqueOrThrow({ where: { slug: "salao" } })
  ).id;
  b = await makeBookable(t, ana, {
    name: "Corte",
    durationMinutes: 30,
    bufferMinutes: 10,
  });
});
afterEach(() => t.close());

const code = (r: { json: () => { error: { code: string } } }) =>
  r.json().error.code;
const input = (hhmm: string, over: Record<string, unknown> = {}) => ({
  ...b,
  startsAt: at(MONDAY, hhmm),
  customer: newCustomer(1),
  ...over,
});
const make = (hhmm: string, over: Record<string, unknown> = {}) =>
  bookOk(t, ana, input(hhmm, over) as never);
const tryBook = (
  hhmm: string,
  over: Record<string, unknown> = {},
  key?: string,
) => book(t, ana, input(hhmm, over) as never, key);
const row = (id: string) =>
  t.prisma.appointment.findUniqueOrThrow({ where: { id } });

/** Conexão à parte numa transação aberta. `release` termina (COMMIT ou ROLLBACK) e fecha. */
async function openTx() {
  const c = await rawClient(TEST_DB);
  await c.query("BEGIN");
  return {
    c,
    lockProfessional: (id: string) =>
      c.query("SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE", [
        id,
      ]),
    lockCustomer: (id: string) =>
      c.query("SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE", [id]),
    end: async (how: "COMMIT" | "ROLLBACK" = "COMMIT") => {
      await c.query(how);
      await c.end();
    },
  };
}

/** Coerente com o CHECK: ends = início + duração; blocked = ends + buffer. */
const insertAppointment = (
  c: pg.Client,
  professionalId: string,
  customerId: string,
  startIso: string,
  dur = 30,
  buf = 10,
) =>
  c.query(
    `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until,
       service_name_snapshot, duration_minutes_snapshot, buffer_minutes_snapshot, source, version, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(mins => $6::int),
       $5::timestamptz + make_interval(mins => ($6::int + $7::int)), 'Corte', $6::int, $7::int, 'PANEL', 1, now())
     RETURNING id`,
    [orgId, professionalId, b.serviceId, customerId, startIso, dur, buf],
  );
const customerFor = async (n: number) =>
  (
    await make(`0${8 + (n % 2)}:00`.slice(-5), {
      customer: newCustomer(100 + n),
      startsAt: at("2031-03-10", `0${8 + (n % 2)}:00`.slice(-5)),
    })
  ).customer.id;

/** Resolve quando `p` termina; devolve `undefined` se ainda estiver pendente depois de `ms`. */
async function settledWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return Promise.race([p, sleep(ms).then(() => undefined)]);
}

describe("L1 — agendamento × TimeOff (a trava do profissional serializa os dois)", () => {
  it("T1 trava o profissional e cria TimeOff: createAppointment NÃO termina antes do commit e depois falha com PROFESSIONAL_UNAVAILABLE", async () => {
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    await t1.c.query(
      `INSERT INTO time_off (id, organization_id, professional_id, starts_at, ends_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::timestamptz, $4::timestamptz, now())`,
      [orgId, b.professionalId, at(MONDAY, "10:00"), at(MONDAY, "11:00")],
    );
    const pending = tryBook("10:00");
    expect(await settledWithin(pending, 700)).toBeUndefined(); // bloqueado pela trava
    await t1.end("COMMIT");
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "PROFESSIONAL_UNAVAILABLE",
    ]);
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it("inverso: T1 cria o agendamento e segura o commit; createTimeOff espera e então falha com a lista de conflitos", async () => {
    const customer = await customerFor(1);
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    const inserted = await insertAppointment(
      t1.c,
      b.professionalId,
      customer,
      "2031-03-03T13:00:00Z",
    );
    const pending = api(t, "POST", "/api/time-off", ana, {
      professionalId: b.professionalId,
      startsAt: at(MONDAY, "10:00"),
      endsAt: at(MONDAY, "11:00"),
    });
    expect(await settledWithin(pending, 700)).toBeUndefined();
    await t1.end("COMMIT");
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
    ]);
    expect(
      res.json().error.details.conflicts.map((x: { id: string }) => x.id),
    ).toEqual([inserted.rows[0].id]);
    expect(await t.prisma.timeOff.count()).toBe(0);
  });
});

describe("L2 — agendamento × WorkingHours", () => {
  it("T1 reduz o expediente (trava + UPDATE): createAppointment espera e depois falha; nada é gravado", async () => {
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    await t1.c.query(
      `UPDATE working_hours SET end_minute = 600 WHERE professional_id = $1 AND weekday = 1`,
      [b.professionalId],
    ); // até 10:00
    const pending = tryBook("10:00");
    expect(await settledWithin(pending, 700)).toBeUndefined();
    await t1.end("COMMIT");
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "PROFESSIONAL_UNAVAILABLE",
    ]);
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it("inverso: T1 cria o agendamento; a redução do expediente espera e então falha com WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS", async () => {
    const customer = await customerFor(2);
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
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    const inserted = await insertAppointment(
      t1.c,
      b.professionalId,
      customer,
      "2031-03-03T20:00:00Z",
    ); // 17:00–17:30 locais
    const pending = api(t, "PATCH", `/api/working-hours/${mon.id}`, ana, {
      endTime: "17:15",
    });
    expect(await settledWithin(pending, 700)).toBeUndefined();
    await t1.end("COMMIT");
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
    ]);
    expect(
      res.json().error.details.conflicts.map((x: { id: string }) => x.id),
    ).toEqual([inserted.rows[0].id]);
    expect(
      (await t.prisma.workingHours.findUniqueOrThrow({ where: { id: mon.id } }))
        .endMinute,
    ).toBe(1080);
  });
});

describe("L3 — profissionais diferentes não se bloqueiam", () => {
  it("com o profissional A preso por outra transação, criar em B termina rápido enquanto A fica pendente", async () => {
    const davi = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    try {
      const onA = tryBook("10:00", { customer: newCustomer(1) });
      const started = Date.now();
      const onB = await bookOk(
        t,
        ana,
        input("10:00", {
          professionalId: davi,
          customer: newCustomer(2),
        }) as never,
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(onB.professionalId).toBe(davi);
      expect(await settledWithin(onA, 300)).toBeUndefined();
      await t1.end("ROLLBACK");
      expect((await onA).statusCode).toBe(201);
    } finally {
      await t1.c.end().catch(() => undefined);
    }
  });
});

describe("L13 — o profissional mudou entre a leitura sem lock e a trava", () => {
  it("remarcar encontra X na leitura, outra transação move o agendamento para Y antes da trava => 409 STALE_VERSION", async () => {
    const davi = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    const a = await make("10:00");
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId); // X
    await t1.c.query(
      `UPDATE appointments SET professional_id = $2, version = version + 1 WHERE id = $1`,
      [a.id, davi],
    );
    const pending = api(
      t,
      "POST",
      `/api/appointments/${a.id}/reschedule`,
      ana,
      { startsAt: at(MONDAY, "14:00"), version: 1 },
    );
    expect(await settledWithin(pending, 700)).toBeUndefined(); // leu o agendamento (em X) e espera a trava de X
    await t1.end("COMMIT");
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([409, "STALE_VERSION"]);
    expect(await row(a.id)).toMatchObject({ professionalId: davi, version: 2 }); // a remarcação não foi aplicada
    expect((await row(a.id)).startsAt.toISOString()).toBe(
      "2031-03-03T13:00:00.000Z",
    );
  });
});

describe("L14 — cliente (N1) serializa e respeita N1 → N2", () => {
  it("criação por customerId espera a trava do cliente mantida por outra transação", async () => {
    const first = await make("09:00");
    const t1 = await openTx();
    await t1.lockCustomer(first.customer.id);
    const pending = tryBook("11:00", {
      customer: undefined,
      customerId: first.customer.id,
    });
    expect(await settledWithin(pending, 700)).toBeUndefined();
    await t1.end("COMMIT");
    expect((await pending).statusCode).toBe(201);
  });

  it("cliente NOVO com o mesmo telefone em criações simultâneas => UMA linha de cliente; todos os agendamentos apontam para ela", async () => {
    const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
    const results = await Promise.all(
      hours.map((h) =>
        tryBook(h, {
          customer: { name: "Mesma Pessoa", phone: "(11) 97777-6666" },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(hours.map(() => 201));
    expect(
      await t.prisma.customer.count({ where: { phoneE164: "+5511977776666" } }),
    ).toBe(1);
    expect(
      new Set(results.map((r) => r.json().appointment.customer.id)).size,
    ).toBe(1);
  });

  it("hierarquia N1 → N2: criações do mesmo cliente em profissionais diferentes + edição do cliente em paralelo, sem deadlock", async () => {
    const pros = [
      b.professionalId,
      await makeProfessional(t, ana, b.serviceId, { name: "Davi" }),
      await makeProfessional(t, ana, b.serviceId, { name: "Eva" }),
    ];
    const seed = await make("08:00", { startsAt: at("2031-03-05", "08:00") });
    const ops: Array<Promise<{ statusCode: number }>> = [];
    for (let i = 0; i < 18; i++) {
      const hh = String(8 + Math.floor(i / 3)).padStart(2, "0");
      ops.push(
        bookOk(
          t,
          ana,
          input(`${hh}:00`, {
            professionalId: pros[i % 3],
            customer: undefined,
            customerId: seed.customer.id,
          }) as never,
        ).then(() => ({ statusCode: 201 })),
      );
      if (i % 4 === 0)
        ops.push(
          api(t, "PATCH", `/api/customers/${seed.customer.id}`, ana, {
            notes: `n${i}`,
          }),
        );
    }
    const results = await Promise.all(ops);
    expect(
      results.every((r) => r.statusCode === 200 || r.statusCode === 201),
    ).toBe(true);
    expect(t.logs()).not.toMatch(/40P01|LockOrderViolation|TEMPORARILY_BUSY/);
  });
});

describe("L15 — slots não bloqueiam nem são bloqueados", () => {
  const slotsOf = async (date = MONDAY) => {
    const res = await api(
      t,
      "GET",
      `/api/availability/slots?${new URLSearchParams({ professionalId: b.professionalId, serviceId: b.serviceId, date })}`,
      ana,
    );
    return res;
  };

  it("com profissional e cliente travados por outra transação, a leitura de slots responde na hora", async () => {
    const a = await make("10:00");
    const t1 = await openTx();
    await t1.lockProfessional(b.professionalId);
    await t1.lockCustomer(a.customer.id);
    const started = Date.now();
    const res = await slotsOf();
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(700);
    await t1.end("ROLLBACK");
  });

  it("um slot livre na UI pode dar 409 ao confirmar; recarregar os slots deixa de oferecê-lo", async () => {
    const before = (await slotsOf()).json().slots as string[];
    const target = at(MONDAY, "15:00");
    const targetIso = new Date(target).toISOString();
    expect(before).toContain(targetIso);
    await make("15:00", { customer: newCustomer(2) }); // outra pessoa pegou
    const res = await book(t, ana, {
      ...b,
      startsAt: targetIso,
      customer: newCustomer(3),
    });
    expect([res.statusCode, code(res)]).toEqual([409, "SLOT_UNAVAILABLE"]);
    expect((await slotsOf()).json().slots as string[]).not.toContain(targetIso);
  });
});

describe("conflito de horário sob paralelismo", () => {
  it("8 criações simultâneas do MESMO slot (clientes e chaves diferentes) => 1 × 201 e 7 × 409 SLOT_UNAVAILABLE, sem 5xx nem deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const hh = ["09:00", "11:00", "14:00"][round]!;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          tryBook(hh, { customer: newCustomer(10 * round + i + 1) }),
        ),
      );
      expect(
        results.map((r) => r.statusCode).sort(),
        `rodada ${round}`,
      ).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.statusCode === 409))
        expect(code(r)).toBe("SLOT_UNAVAILABLE");
    }
    expect(await t.prisma.appointment.count()).toBe(3);
    expect(t.logs()).not.toMatch(/40P01|TEMPORARILY_BUSY/);
  });

  it("sobreposições parciais simultâneas (buffer incluído): no máximo um dos que se tocam vence e nenhum par ativo se sobrepõe", async () => {
    const starts = ["10:00", "10:15", "10:30", "10:45", "11:00", "11:15"];
    const results = await Promise.all(
      starts.map((h, i) => tryBook(h, { customer: newCustomer(i + 1) })),
    );
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    const rows = await t.prisma.appointment.findMany({
      where: { status: "SCHEDULED" },
      orderBy: { startsAt: "asc" },
    });
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.blockedUntil.getTime(),
      );
  });
});

describe("L12 — cancelar × remarcar o mesmo agendamento em paralelo (amostragem)", () => {
  it("um vence e o outro recebe STALE_VERSION; o estado final é coerente com o vencedor", async () => {
    for (let round = 0; round < 10; round++) {
      const a = await make("10:00", {
        customer: newCustomer(round + 1),
        startsAt: at(`2031-03-0${3 + (round % 3)}`, "10:00"),
      });
      const [cancel, move] = await Promise.all([
        api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, { version: 1 }),
        api(t, "POST", `/api/appointments/${a.id}/reschedule`, ana, {
          startsAt: at(`2031-03-0${3 + (round % 3)}`, "14:00"),
          version: 1,
        }),
      ]);
      const statuses = [cancel.statusCode, move.statusCode].sort();
      expect(statuses, `rodada ${round}`).toEqual([200, 409]);
      const loser = cancel.statusCode === 409 ? cancel : move;
      expect(code(loser)).toBe("STALE_VERSION");
      const final = await row(a.id);
      expect(final.version).toBe(2);
      if (cancel.statusCode === 200) {
        expect(final.status).toBe("CANCELLED");
        expect(final.startsAt.toISOString().slice(11, 16)).toBe("13:00");
      } else {
        expect(final.status).toBe("SCHEDULED");
        expect(final.startsAt.toISOString().slice(11, 16)).toBe("17:00");
      }
    }
  });

  it("cancelar × criar TimeOff sobre o mesmo agendamento: falso positivo transitório é aceito, mas nunca sobra ativo dentro da folga", async () => {
    for (let round = 0; round < 8; round++) {
      const day = `2031-03-0${3 + (round % 3)}`;
      const a = await make("10:00", {
        customer: newCustomer(round + 1),
        startsAt: at(day, "10:00"),
      });
      const [cancel, off] = await Promise.all([
        api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, { version: 1 }),
        api(t, "POST", "/api/time-off", ana, {
          professionalId: b.professionalId,
          startsAt: at(day, "10:00"),
          endsAt: at(day, "10:30"),
        }),
      ]);
      expect(cancel.statusCode).toBe(200);
      expect([201, 409], `rodada ${round}`).toContain(off.statusCode); // 409 = viu ativo algo recém-cancelado
      if (off.statusCode === 409)
        expect(code(off)).toBe("TIMEOFF_CONFLICTS_WITH_APPOINTMENTS");
      // limpa a folga para a próxima rodada reutilizar o horário
      await t.prisma.timeOff.deleteMany();
    }
  });
});

describe("6.4 — idempotência sob concorrência", () => {
  it("4. requisições simultâneas com a MESMA chave => 1 agendamento e todas obtêm o mesmo resultado", async () => {
    for (let round = 0; round < 4; round++) {
      const key = randomUUID();
      const body = input("10:00", {
        startsAt: at(`2031-03-0${3 + round}`, "10:00"),
        customer: newCustomer(round + 1),
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => tryBook("10:00", body, key)),
      );
      expect(
        results.map((r) => r.statusCode),
        `rodada ${round}`,
      ).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.json().appointment.id)).size).toBe(1);
      expect(
        results.filter((r) => r.headers["idempotent-replay"] === "true"),
      ).toHaveLength(4);
      expect(
        await t.prisma.appointment.count({
          where: { createdByUserId: ana.userId },
        }),
      ).toBe(round + 1);
    }
    expect(await t.prisma.idempotencyRecord.count()).toBe(4);
  });

  it("mesma chave, payloads DIFERENTES em paralelo: exatamente um vence e os outros recebem 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      ["09:00", "10:00", "11:00", "12:00"].map((h, i) =>
        tryBook(h, { customer: newCustomer(i + 1) }, key),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([
      201, 409, 409, 409,
    ]);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(code(r)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await t.prisma.appointment.count()).toBe(1);
  });

  it("8. limpeza concorrente com criação em andamento: a linha reivindicada por uma transação aberta não é removida e não há duplicata", async () => {
    // registro VENCIDO há 3 h (elegível à limpeza)
    const key = randomUUID();
    const c0 = await rawClient(TEST_DB);
    await c0.query(
      `INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, created_at, expires_at)
       VALUES (gen_random_uuid(), $1, 'appointments.create', $2, 'antigo', now() - interval '27 hours', now() - interval '3 hours')`,
      [orgId, key],
    );
    await c0.end();
    // uma transação "de criação" reivindica de novo a chave e fica aberta (mesma instrução de claimIdempotencyKey)
    const t1 = await openTx();
    const claimed = await t1.c.query(
      `INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, created_at, expires_at)
       VALUES (gen_random_uuid(), $1, 'appointments.create', $2, 'novo', now(), now() + interval '24 hours')
       ON CONFLICT (organization_id, scope, key) DO UPDATE SET request_hash = EXCLUDED.request_hash, created_at = now(), expires_at = EXCLUDED.expires_at
       WHERE idempotency_records.expires_at <= now() RETURNING id`,
      [orgId, key],
    );
    expect(claimed.rowCount).toBe(1);
    const run = () =>
      runMaintenance({
        prisma: t.prisma,
        clock: t.clock,
        logger: { info: () => undefined },
      });
    expect((await run()).idempotency).toBe(0); // a linha está travada pela transação aberta: SKIP LOCKED a pula
    await t1.end("COMMIT");
    expect((await run()).idempotency).toBe(0); // agora vigente (24 h)
    const rows = await t.prisma.idempotencyRecord.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestHash: "novo" });
  });
});
