// Etapa 10 — hierarquia de locks e timeouts nos fluxos de agendamento: L9 COMPLETO (cobertura), ordem N1→N2→N3→N4 nas
// consultas emitidas, ordenação de vários profissionais, L10 (lock_timeout => 503 e nada gravado) e "cancelar não
// trava o profissional". Postgres real. A ordem emitida prova a ordem PRETENDIDA, não a ausência de deadlock.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../src/lib/db/client.ts";
import {
  rescheduleAppointment,
  type AppointmentScope,
} from "../../src/modules/appointments/service.ts";
import { databaseUrl } from "../../tools/database-url.ts";
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

const input = (hhmm: string, over: Record<string, unknown> = {}) => ({
  ...b,
  startsAt: at(MONDAY, hhmm),
  customer: newCustomer(1),
  ...over,
});
const make = (hhmm: string, over: Record<string, unknown> = {}) =>
  bookOk(t, ana, input(hhmm, over) as never);

// Padrões das consultas emitidas (texto do log de queries do Prisma)
const P = {
  customerInsert: /INSERT INTO customers/,
  customerLock: /FROM customers[\s\S]*FOR NO KEY UPDATE/,
  professionalLock: /FROM professionals[\s\S]*FOR NO KEY UPDATE/,
  idempotency: /INSERT INTO idempotency_records/,
  appointmentInsert: /INSERT INTO "public"\."appointments"/,
  appointmentLock: /FROM appointments[\s\S]*FOR NO KEY UPDATE/,
  appointmentUpdate: /UPDATE "public"\."appointments"/,
};
const first = (re: RegExp) => t.queries.findIndex((q) => re.test(q));

describe("L9 (completo) e ordem N1 → N2 → N3 → N4 nas consultas emitidas", () => {
  it("criar com cliente NOVO: cliente (INSERT + trava) → profissional → idempotência → INSERT do agendamento", async () => {
    t.queries.length = 0;
    expect((await book(t, ana, input("10:00") as never)).statusCode).toBe(201);
    const order = [
      P.customerInsert,
      P.customerLock,
      P.professionalLock,
      P.idempotency,
      P.appointmentInsert,
    ].map(first);
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((x, y) => x - y)); // estritamente nessa ordem
    expect(new Set(order).size).toBe(order.length);
  });

  it("criar com cliente existente (customerId): trava do cliente → profissional → idempotência → INSERT", async () => {
    const first1 = await make("09:00");
    t.queries.length = 0;
    expect(
      (
        await book(
          t,
          ana,
          input("11:00", {
            customer: undefined,
            customerId: first1.customer.id,
          }) as never,
        )
      ).statusCode,
    ).toBe(201);
    const order = [
      P.customerLock,
      P.professionalLock,
      P.idempotency,
      P.appointmentInsert,
    ].map(first);
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(t.queries.some((q) => P.customerInsert.test(q))).toBe(false); // sem INSERT de cliente
  });

  it("remarcar e reativar: profissional (N2) → linha do agendamento (N4) → UPDATE; não toca cliente nem idempotência", async () => {
    const a = await make("10:00");
    t.queries.length = 0;
    expect(
      (
        await api(t, "POST", `/api/appointments/${a.id}/reschedule`, ana, {
          startsAt: at(MONDAY, "14:00"),
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const order = [
      P.professionalLock,
      P.appointmentLock,
      P.appointmentUpdate,
    ].map(first);
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(
      t.queries.some((q) => P.customerLock.test(q) || P.idempotency.test(q)),
    ).toBe(false);

    await api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, {
      version: 2,
    });
    t.queries.length = 0;
    expect(
      (
        await api(t, "POST", `/api/appointments/${a.id}/reactivate`, ana, {
          version: 3,
        })
      ).statusCode,
    ).toBe(200);
    const re = [P.professionalLock, P.appointmentLock, P.appointmentUpdate].map(
      first,
    );
    expect(re).toEqual([...re].sort((x, y) => x - y));
    expect(re.every((i) => i >= 0)).toBe(true);
  });

  it("cancelar/confirmar/concluir/não compareceu: SÓ a linha do agendamento — nenhuma trava de profissional, cliente ou idempotência", async () => {
    const ids = [
      await make("09:00"),
      await make("10:00", { customer: newCustomer(2) }),
      await make("11:00", { customer: newCustomer(3) }),
      await make("12:00", { customer: newCustomer(4) }),
    ];
    const calls: Array<[string, string]> = [
      ["confirm", ids[0]!.id],
      ["complete", ids[1]!.id],
      ["no-show", ids[2]!.id],
      ["cancel", ids[3]!.id],
    ];
    t.clock.advance(2 * 24 * 3_600_000 + 6 * 3_600_000); // segunda 15:00 locais: todos já terminaram
    for (const [action, id] of calls) {
      t.queries.length = 0;
      expect(
        (
          await api(t, "POST", `/api/appointments/${id}/${action}`, ana, {
            version: 1,
          })
        ).statusCode,
        action,
      ).toBe(200);
      expect(
        t.queries.some(
          (q) =>
            P.professionalLock.test(q) ||
            P.customerLock.test(q) ||
            P.idempotency.test(q),
        ),
        action,
      ).toBe(false);
      expect(
        t.queries.some((q) => P.appointmentUpdate.test(q)),
        action,
      ).toBe(true);
    }
  });

  it("nenhuma escrita em appointments/customers/idempotência acontece antes da trava de profissional ou de cliente que a protege", async () => {
    // cobre falhas também: uma criação que falha por conflito trava e escreve na mesma ordem, e faz rollback
    await make("10:00");
    t.queries.length = 0;
    expect(
      (
        await book(
          t,
          ana,
          input("10:15", { customer: newCustomer(2) }) as never,
        )
      ).statusCode,
    ).toBe(409);
    expect(first(P.professionalLock)).toBeGreaterThan(first(P.customerLock));
    // o INSERT que viola a exclusão não chega ao log; o que importa é que a trava veio antes e que houve rollback
  });
});

describe("remarcar entre profissionais: as travas N2 são adquiridas em ordem crescente de id (nos dois sentidos)", () => {
  let prisma: PrismaClient;
  let log: Array<{ query: string; params: string }>;
  beforeEach(() => {
    log = [];
    prisma = createPrismaClient(databaseUrl(TEST_DB), {
      log: [{ emit: "event", level: "query" }],
    });
    (
      prisma as unknown as {
        $on(
          e: "query",
          cb: (x: { query: string; params: string }) => void,
        ): void;
      }
    ).$on("query", (e) => log.push({ query: e.query, params: e.params }));
  });
  afterEach(() => prisma.$disconnect());

  it("A→B e B→A emitem o SELECT … FOR NO KEY UPDATE do menor id primeiro", async () => {
    const other = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    const [lo, hi] = [b.professionalId, other].sort() as [string, string];
    const scope: AppointmentScope = {
      organizationId: orgId,
      userId: ana.userId,
      timezone: "America/Sao_Paulo",
    };
    const deps = { prisma, clock: t.clock };
    const a = await make("10:00", { professionalId: lo });
    for (const [from, to, version, hhmm] of [
      [lo, hi, 1, "11:00"],
      [hi, lo, 2, "12:00"],
    ] as const) {
      log.length = 0;
      const moved = await rescheduleAppointment(deps, scope, a.id, {
        startsAt: new Date(at(MONDAY, hhmm)),
        professionalId: to,
        version,
      });
      expect(moved.professionalId).toBe(to);
      const locked = log
        .filter((l) =>
          /FROM professionals[\s\S]*FOR NO KEY UPDATE/.test(l.query),
        )
        .map((l) => JSON.parse(l.params).at(-1) as string);
      expect(locked, `${from} → ${to}`).toEqual([lo, hi]);
    }
  });
});

describe("L10 — lock_timeout nos fluxos de agendamento: 503 TEMPORARILY_BUSY e nada gravado", () => {
  async function hold(sql: string, id: string) {
    const c = await rawClient(TEST_DB);
    await c.query("BEGIN");
    await c.query(sql, [id]);
    return {
      release: async () => {
        await c.query("ROLLBACK");
        await c.end();
      },
    };
  }
  const profLock =
    "SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE";
  const busy = (r: {
    statusCode: number;
    headers: Record<string, unknown>;
    json: () => { error: { code: string } };
  }) => {
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("1");
    expect(r.json().error.code).toBe("TEMPORARILY_BUSY");
  };

  it("criar e remarcar esperam a trava do profissional, estouram em ~2 s e não gravam NADA (nem cliente, nem idempotência)", async () => {
    const a = await make("09:00");
    const customers = await t.prisma.customer.count();
    const snapshot = await t.prisma.appointment.findMany({
      orderBy: { id: "asc" },
    });
    const held = await hold(profLock, b.professionalId);
    try {
      const started = Date.now();
      const [create, move] = await Promise.all([
        book(t, ana, input("11:00", { customer: newCustomer(9) }) as never),
        api(t, "POST", `/api/appointments/${a.id}/reschedule`, ana, {
          startsAt: at(MONDAY, "14:00"),
          version: 1,
        }),
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
      expect(Date.now() - started).toBeLessThan(5500);
      busy(create);
      busy(move);
    } finally {
      await held.release();
    }
    expect(await t.prisma.customer.count()).toBe(customers);
    expect(await t.prisma.idempotencyRecord.count()).toBe(1); // só a do agendamento inicial
    expect(
      await t.prisma.appointment.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(snapshot);
    // liberada a trava, as mesmas operações funcionam
    expect(
      (
        await book(
          t,
          ana,
          input("11:00", { customer: newCustomer(9) }) as never,
        )
      ).statusCode,
    ).toBe(201);
  }, 30_000);

  it("criar por customerId espera a trava do CLIENTE (N1) => 503; a linha do agendamento presa faz cancelar esperar => 503", async () => {
    const a = await make("09:00");
    const heldCustomer = await hold(
      "SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE",
      a.customer.id,
    );
    try {
      busy(
        await book(
          t,
          ana,
          input("11:00", {
            customer: undefined,
            customerId: a.customer.id,
          }) as never,
        ),
      );
    } finally {
      await heldCustomer.release();
    }
    const heldRow = await hold(
      "SELECT id FROM appointments WHERE id = $1 FOR NO KEY UPDATE",
      a.id,
    );
    try {
      busy(
        await api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, {
          version: 1,
        }),
      );
    } finally {
      await heldRow.release();
    }
    expect(
      (await t.prisma.appointment.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe("SCHEDULED");
    expect(
      (
        await api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
  }, 30_000);

  it("a trava do profissional NÃO impede cancelar/confirmar (não ocupam horário) nem criar em outro profissional", async () => {
    const a = await make("09:00");
    const davi = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    const held = await hold(profLock, b.professionalId);
    try {
      const started = Date.now();
      expect(
        (
          await api(t, "POST", `/api/appointments/${a.id}/confirm`, ana, {
            version: 1,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, {
            version: 2,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await bookOk(
            t,
            ana,
            input("10:00", {
              professionalId: davi,
              customer: newCustomer(2),
            }) as never,
          )
        ).professionalId,
      ).toBe(davi);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await held.release();
    }
  });
});

describe("ruído de log e sanidade", () => {
  it("fluxos felizes e de erro de negócio não geram LockOrderViolation/LockCoverageViolation", async () => {
    const a = await make("10:00");
    await book(t, ana, input("10:15", { customer: newCustomer(2) }) as never); // 409
    await api(t, "POST", `/api/appointments/${a.id}/reschedule`, ana, {
      startsAt: at(MONDAY, "11:00"),
      version: 9,
    }); // 409
    await api(t, "POST", `/api/appointments/${randomUUID()}/cancel`, ana, {
      version: 1,
    }); // 404
    expect(t.logs()).not.toMatch(
      /LockOrderViolation|LockCoverageViolation|40P01/,
    );
  });
});
