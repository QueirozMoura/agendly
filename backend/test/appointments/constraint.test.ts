// Etapa 10 — testes obrigatórios da constraint de 6.1 (1–10) e integridade do banco. Postgres REAL, SQL cru:
// o banco é a última linha de defesa e vale mesmo sem a aplicação.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
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
import { makeBookable, type Bookable } from "../support/booking.ts";

let t: AuthTestApp;
let ana: TestUser;
let c: pg.Client;
let org: string;
let b: Bookable;
let customer: string;

beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
  org = (
    await t.prisma.organization.findUniqueOrThrow({ where: { slug: "salao" } })
  ).id;
  b = await makeBookable(t, ana);
  c = await rawClient(TEST_DB);
  customer = await mkCustomer(org, "+5511900000001");
});
afterEach(async () => {
  await c.end();
  await t.close();
});

async function mkCustomer(orgId: string, phone: string): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO customers (id, organization_id, name, phone_e164, updated_at)
     VALUES (gen_random_uuid(), $1, 'Cliente', $2, now()) RETURNING id`,
    [orgId, phone],
  );
  return rows[0].id;
}

const sqlState = (e: unknown) => (e as { code?: string }).code;

/** Insere um agendamento com faixa coerente (ends = início + dur; blocked = ends + buf). Devolve o id ou o erro. */
async function insert(
  p: {
    start: string;
    dur?: number;
    buf?: number;
    status?: string;
    professional?: string;
    org?: string;
    customer?: string;
  },
  client: pg.Client = c,
): Promise<string | Error> {
  const dur = p.dur ?? 30;
  const buf = p.buf ?? 0;
  try {
    const { rows } = await client.query(
      `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at,
         blocked_until, status, service_name_snapshot, duration_minutes_snapshot, buffer_minutes_snapshot, source, version, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(mins => $6::int),
         $5::timestamptz + make_interval(mins => ($6::int + $7::int)), $8::"AppointmentStatus", 'Corte', $6::int, $7::int, 'PANEL', 1, now())
       RETURNING id`,
      [
        p.org ?? org,
        p.professional ?? b.professionalId,
        b.serviceId,
        p.customer ?? customer,
        p.start,
        dur,
        buf,
        p.status ?? "SCHEDULED",
      ],
    );
    return rows[0].id as string;
  } catch (e) {
    return e as Error;
  }
}
const ok = (r: string | Error) => typeof r === "string";
const T = (hhmm: string) => `2031-03-03T${hhmm}:00Z`;

describe("6.1 — constraint de exclusão (testes 1 a 6)", () => {
  it("1. dois ativos sobrepostos no mesmo profissional => 23P01", async () => {
    expect(ok(await insert({ start: T("13:00") }))).toBe(true);
    const err = await insert({ start: T("13:15") });
    expect(sqlState(err)).toBe("23P01");
    expect(classifyDbError(err)).toBe("exclusion_violation");
    // vale também para CONFIRMED
    expect(
      sqlState(await insert({ start: T("13:00"), status: "CONFIRMED" })),
    ).toBe("23P01");
  });

  it("2. encostados ([) => ambos passam", async () => {
    expect(ok(await insert({ start: T("13:00"), dur: 30 }))).toBe(true);
    expect(ok(await insert({ start: T("13:30"), dur: 30 }))).toBe(true);
    expect(ok(await insert({ start: T("12:30"), dur: 30 }))).toBe(true);
  });

  it("3. mesmo horário, profissionais diferentes => passam", async () => {
    const other = (
      await api(t, "POST", "/api/professionals", ana, { name: "Davi" })
    ).json().professional.id as string;
    expect(ok(await insert({ start: T("13:00") }))).toBe(true);
    expect(ok(await insert({ start: T("13:00"), professional: other }))).toBe(
      true,
    );
  });

  it("4. sobreposto a CANCELLED/NO_SHOW/COMPLETED passa; cancelar o primeiro e criar o segundo passa; reativar o primeiro depois FALHA", async () => {
    for (const status of ["CANCELLED", "NO_SHOW", "COMPLETED"])
      expect(ok(await insert({ start: T("13:00"), status }))).toBe(true);
    expect(ok(await insert({ start: T("13:00") }))).toBe(true); // ativo por cima de três não ativos
    const first = (await insert({ start: T("15:00") })) as string;
    await c.query(
      `UPDATE appointments SET status = 'CANCELLED', version = version + 1 WHERE id = $1`,
      [first],
    );
    expect(ok(await insert({ start: T("15:00") }))).toBe(true);
    const reactivate = await c
      .query(
        `UPDATE appointments SET status = 'SCHEDULED', version = version + 1 WHERE id = $1`,
        [first],
      )
      .catch((e: Error) => e);
    expect(sqlState(reactivate)).toBe("23P01");
  });

  it("5. sobreposição apenas dentro do buffer falha; fora do buffer passa", async () => {
    expect(ok(await insert({ start: T("13:00"), dur: 30, buf: 15 }))).toBe(
      true,
    ); // ocupa 13:00–13:45
    expect(sqlState(await insert({ start: T("13:30") }))).toBe("23P01"); // dentro do buffer
    expect(sqlState(await insert({ start: T("13:44") }))).toBe("23P01");
    expect(ok(await insert({ start: T("13:45") }))).toBe(true); // exatamente após blocked_until
    // simetria: um novo ANTES, cujo buffer invade o início do existente, também falha
    expect(
      sqlState(await insert({ start: T("12:45"), dur: 30, buf: 15 })),
    ).toBe("23P01");
    expect(ok(await insert({ start: T("12:30"), dur: 30, buf: 0 }))).toBe(true);
  });

  it("6. UPDATE (remarcar) não conflita consigo mesmo; sobre outro ativo falha", async () => {
    const a = (await insert({ start: T("13:00"), buf: 10 })) as string;
    await insert({ start: T("16:00") });
    const move = (id: string, start: string, dur = 30, buf = 10) =>
      c
        .query(
          `UPDATE appointments SET starts_at = $2::timestamptz,
             ends_at = $2::timestamptz + make_interval(mins => $3::int),
             blocked_until = $2::timestamptz + make_interval(mins => ($3::int + $4::int)), version = version + 1
           WHERE id = $1`,
          [id, start, dur, buf],
        )
        .catch((e: Error) => e);
    expect(sqlState(await move(a, T("13:15")))).toBeUndefined(); // sobrepõe a própria faixa antiga
    expect(sqlState(await move(a, T("15:50")))).toBe("23P01"); // cai sobre o das 16:00 (via buffer)
    expect(sqlState(await move(a, T("14:00")))).toBeUndefined();
  });
});

describe("6.1 — FK composta, concorrência no banco e migração (testes 7 a 10)", () => {
  it("7. (organization = A, profissional da B) via SQL cru falha por FK composta, não pela exclusão", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    expect((await createOrg(t, bob, "barbearia")).statusCode).toBe(201);
    const bobPro = (await makeBookable(t, bob)).professionalId;
    const err = await insert({ start: T("13:00"), professional: bobPro });
    expect(sqlState(err)).toBe("23503");
    expect((err as Error).message).toContain(
      "appointments_organization_id_professional_id_fkey",
    );
    // serviço e cliente de outra empresa também são recusados
    const bobOrg = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "barbearia" },
      })
    ).id;
    const bobCustomer = await mkCustomer(bobOrg, "+5511900000099");
    const cust = await insert({ start: T("13:00"), customer: bobCustomer });
    expect((cust as Error).message).toContain(
      "appointments_organization_id_customer_id_fkey",
    );
    const bobService = (await makeBookable(t, bob, { name: "Barba" }))
      .serviceId;
    const svc = await c
      .query(
        `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until,
           service_name_snapshot, duration_minutes_snapshot, buffer_minutes_snapshot, source, version, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now() + interval '30 minutes', now() + interval '30 minutes',
           'x', 30, 0, 'PANEL', 1, now())`,
        [org, b.professionalId, bobService, customer],
      )
      .catch((e: Error) => e);
    expect((svc as Error).message).toContain(
      "appointments_organization_id_service_id_fkey",
    );
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it("8a. N inserções concorrentes no mesmo slot COM o lock N2: 1 sucesso e N-1 23P01, sem 40P01, rápido", async () => {
    const clients = await Promise.all(
      Array.from({ length: 8 }, () => rawClient(TEST_DB)),
    );
    try {
      const started = Date.now();
      const outcomes = await Promise.all(
        clients.map(async (cl) => {
          await cl.query("BEGIN");
          await cl.query(
            "SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE",
            [b.professionalId],
          );
          const r = await insert({ start: T("13:00") }, cl);
          await cl.query(ok(r) ? "COMMIT" : "ROLLBACK");
          return ok(r) ? "ok" : sqlState(r);
        }),
      );
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "23P01")).toHaveLength(7);
      expect(Date.now() - started).toBeLessThan(900); // sem esperar o deadlock_timeout de 1 s
      expect(await t.prisma.appointment.count()).toBe(1);
    } finally {
      await Promise.all(clients.map((cl) => cl.end()));
    }
  });

  it("8b. SEM o lock a invariante vale (nunca 2 ativos), mas os perdedores podem receber 40P01 no lugar de 23P01", async () => {
    const clients = await Promise.all(
      Array.from({ length: 6 }, () => rawClient(TEST_DB)),
    );
    try {
      const outcomes = await Promise.all(
        clients.map(async (cl) => {
          await cl.query("BEGIN");
          const r = await insert({ start: T("14:00") }, cl);
          await cl.query(ok(r) ? "COMMIT" : "ROLLBACK").catch(() => undefined);
          return ok(r) ? "ok" : sqlState(r);
        }),
      );
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      for (const o of outcomes.filter((x) => x !== "ok"))
        expect(["23P01", "40P01"]).toContain(o);
      expect(
        await t.prisma.appointment.count({ where: { status: "SCHEDULED" } }),
      ).toBe(1);
    } finally {
      await Promise.all(clients.map((cl) => cl.end()));
    }
  });

  it("9. as constraints e o índice parcial existem no banco migrado (protege contra drift)", async () => {
    const { rows } = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'appointments'::regclass AND conname LIKE 'appointments\\_%' ESCAPE '\\'`,
    );
    const byName = Object.fromEntries(
      rows.map((r) => [r.conname, r.def as string]),
    );
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        "appointments_no_overlap",
        "appointments_range_valid",
        "appointments_range_coherent",
        "appointments_organization_id_professional_id_fkey",
        "appointments_organization_id_service_id_fkey",
        "appointments_organization_id_customer_id_fkey",
      ]),
    );
    expect(byName.appointments_no_overlap).toContain("EXCLUDE USING gist");
    expect(byName.appointments_no_overlap).toContain(
      "tstzrange(starts_at, blocked_until, '[)'::text)",
    );
    expect(byName.appointments_no_overlap).toMatch(
      /status = ANY|status\)::text = ANY|SCHEDULED/,
    );
    expect(byName.appointments_range_coherent).toContain("make_interval");
    for (const fk of ["professional_id", "service_id", "customer_id"]) {
      const def = byName[`appointments_organization_id_${fk}_fkey`] as string;
      expect(def).toContain("ON DELETE RESTRICT");
      expect(def).toContain("ON UPDATE RESTRICT");
      expect(def).not.toContain("SET NULL");
    }
    const idx = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'appointments_active_idx'`,
    );
    expect(idx.rows[0].indexdef).toMatch(/WHERE .*status/);
  });

  it("10. incoerência de ends_at/blocked_until/snapshots via SQL cru => 23514; atualização parcial também", async () => {
    const bad = (sql: string, ...params: unknown[]) =>
      c.query(sql, params).then(
        () => undefined,
        (e: Error) => sqlState(e),
      );
    const id = (await insert({
      start: T("13:00"),
      dur: 30,
      buf: 10,
    })) as string;
    const base = `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until,
      service_name_snapshot, duration_minutes_snapshot, buffer_minutes_snapshot, source, version, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4,`;
    const tail = `, 'x', 30, 10, 'PANEL', 1, now())`;
    const args = [org, b.professionalId, b.serviceId, customer];
    // ends_at errado
    expect(
      await bad(
        `${base} '2031-03-03T16:00Z', '2031-03-03T16:45Z', '2031-03-03T16:55Z'${tail}`,
        ...args,
      ),
    ).toBe("23514");
    // blocked_until errado
    expect(
      await bad(
        `${base} '2031-03-03T16:00Z', '2031-03-03T16:30Z', '2031-03-03T16:50Z'${tail}`,
        ...args,
      ),
    ).toBe("23514");
    // blocked_until < ends_at (range_valid)
    expect(
      await bad(
        `${base} '2031-03-03T16:00Z', '2031-03-03T16:30Z', '2031-03-03T16:20Z'${tail}`,
        ...args,
      ),
    ).toBe("23514");
    // fim <= início
    expect(
      await bad(
        `${base} '2031-03-03T16:00Z', '2031-03-03T16:00Z', '2031-03-03T16:10Z'${tail}`,
        ...args,
      ),
    ).toBe("23514");
    // atualização parcial: só o início
    expect(
      await bad(
        `UPDATE appointments SET starts_at = starts_at + interval '15 minutes' WHERE id = $1`,
        id,
      ),
    ).toBe("23514");
    // atualização parcial: só o snapshot do buffer
    expect(
      await bad(
        `UPDATE appointments SET buffer_minutes_snapshot = 20 WHERE id = $1`,
        id,
      ),
    ).toBe("23514");
    // a forma coerente completa passa
    expect(
      await bad(
        `UPDATE appointments SET starts_at = starts_at + interval '15 minutes', ends_at = ends_at + interval '15 minutes',
           blocked_until = blocked_until + interval '15 minutes' WHERE id = $1`,
        id,
      ),
    ).toBeUndefined();
  });
});

describe("integridade de customers e idempotency_records", () => {
  it("telefone único por empresa (23505) e só em E.164 (23514); o mesmo telefone em outra empresa é permitido", async () => {
    const dup = await c
      .query(
        `INSERT INTO customers (id, organization_id, name, phone_e164, updated_at) VALUES (gen_random_uuid(), $1, 'x', '+5511900000001', now())`,
        [org],
      )
      .catch((e: Error) => e);
    expect(classifyDbError(dup)).toBe("unique_violation");
    for (const phone of [
      "11900000001",
      "+0123456789",
      "+55 11 90000",
      "abc",
      "+551190000000a",
    ]) {
      const r = await c
        .query(
          `INSERT INTO customers (id, organization_id, name, phone_e164, updated_at) VALUES (gen_random_uuid(), $1, 'x', $2, now())`,
          [org, phone],
        )
        .catch((e: Error) => e);
      expect(sqlState(r), phone).toBe("23514");
    }
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobOrg = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "barbearia" },
      })
    ).id;
    await expect(mkCustomer(bobOrg, "+5511900000001")).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("RESTRICT: cliente, serviço e profissional com agendamentos não podem ser apagados", async () => {
    await insert({ start: T("13:00") });
    for (const table of ["customers", "services", "professionals"]) {
      const id = {
        customers: customer,
        services: b.serviceId,
        professionals: b.professionalId,
      }[table];
      const r = await c
        .query(`DELETE FROM ${table} WHERE id = $1`, [id])
        .catch((e: Error) => e);
      expect(classifyDbError(r), table).toBe("foreign_key_violation");
    }
  });

  it("idempotency_records: chave única por (empresa, escopo, chave) e FK composta para o agendamento", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const ins = (
      orgId: string,
      scope = "appointments.create",
      appt: string | null = null,
    ) =>
      c
        .query(
          `INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, appointment_id, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'h', $4, now(), now() + interval '24 hours')`,
          [orgId, scope, key, appt],
        )
        .catch((e: Error) => e);
    expect(await ins(org)).toHaveProperty("rowCount", 1);
    expect(classifyDbError(await ins(org))).toBe("unique_violation");
    expect(await ins(org, "outro.escopo")).toHaveProperty("rowCount", 1);
    // outra empresa pode usar a mesma chave
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobOrg = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "barbearia" },
      })
    ).id;
    expect(await ins(bobOrg)).toHaveProperty("rowCount", 1);
    // FK composta: agendamento de uma empresa não pode ser resultado de registro de outra
    const appt = (await insert({ start: T("13:00") })) as string;
    const cross = await c
      .query(
        `INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, appointment_id, created_at, expires_at)
         VALUES (gen_random_uuid(), $1, 'x', gen_random_uuid(), 'h', $2, now(), now() + interval '24 hours')`,
        [bobOrg, appt],
      )
      .catch((e: Error) => e);
    expect(sqlState(cross)).toBe("23503");
  });
});
