// Etapa 10 — ESTRESSE COM INVARIANTE (L4, L6, L7). Evidência por AMOSTRAGEM, não prova de ausência de deadlock (6.5).
// O pool da API roda com `deadlock_timeout = 50ms`, o que faz qualquer espera cíclica virar 40P01 em milissegundos.
// A semente é fixa por teste e aparece nas mensagens de falha, para reproduzir a mesma sequência de operações.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitsWorkingHours } from "../../src/modules/availability/fit.ts";
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
  at,
  makeProfessional,
  makeService,
  newCustomer,
} from "../support/booking.ts";

const LOW_DEADLOCK_TIMEOUT = `${databaseUrl(TEST_DB)}?options=-c%20deadlock_timeout%3D50ms`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let t: AuthTestApp;
let ana: TestUser;
let pros: string[];
let services: string[];
const DAYS = [
  "2031-03-03",
  "2031-03-04",
  "2031-03-05",
  "2031-03-06",
  "2031-03-07",
]; // segunda a sexta

beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp({ databaseUrlOverride: LOW_DEADLOCK_TIMEOUT });
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
  services = [
    await makeService(t, ana, {
      name: "Corte",
      durationMinutes: 30,
      bufferMinutes: 10,
    }),
    await makeService(t, ana, {
      name: "Barba",
      durationMinutes: 45,
      bufferMinutes: 0,
    }),
  ];
  pros = [];
  for (const name of ["Carla", "Davi", "Eva"]) {
    const id = await makeProfessional(t, ana, undefined, { name });
    await api(t, "PUT", `/api/professionals/${id}/services`, ana, {
      serviceIds: services,
    });
    pros.push(id);
  }
});
afterEach(() => t.close());

it("sanidade do ambiente: o pool da API usa deadlock_timeout de 50 ms", async () => {
  const rows = await t.prisma.$queryRaw<
    { deadlock_timeout: string }[]
  >`SHOW deadlock_timeout`;
  expect(rows[0]?.deadlock_timeout).toBe("50ms");
});

type Res = {
  statusCode: number;
  json: () => Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
};
interface Tracked {
  id: string;
  version: number;
}

/** Gera e dispara `n` operações aleatórias em paralelo. `kinds` escolhe o que entra (L4 usa um subconjunto de L7). */
async function runLoad(seed: number, n: number, kinds: readonly string[]) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const hhmm = () =>
    `${String(8 + Math.floor(rnd() * 10)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
  const known: Tracked[] = [];
  const usedKeys: Array<{ key: string; body: Record<string, unknown> }> = [];
  const outcomes: Array<{ kind: string; status: number }> = [];

  const create = async (): Promise<Res> => {
    const body = {
      professionalId: pick(pros),
      serviceId: pick(services),
      startsAt: at(pick(DAYS), hhmm()),
      customer: newCustomer(1 + Math.floor(rnd() * 6)),
    };
    const reuse = rnd() < 0.15 && usedKeys.length > 0;
    const prior = reuse ? pick(usedKeys) : undefined;
    const key = prior?.key ?? randomUUID();
    const payload = prior ? (rnd() < 0.5 ? prior.body : body) : body;
    if (!prior) usedKeys.push({ key, body });
    const res = (await api(t, "POST", "/api/appointments", ana, payload, {
      "idempotency-key": key,
    })) as Res;
    if (res.statusCode === 201)
      known.push({ id: res.json().appointment.id, version: 1 });
    return res;
  };
  const withKnown = async (fn: (a: Tracked) => Promise<Res>): Promise<Res> =>
    known.length ? fn(pick(known)) : create();

  const ops: Record<string, () => Promise<Res>> = {
    create,
    "create-existing-customer": create,
    reschedule: () =>
      withKnown(
        (a) =>
          api(t, "POST", `/api/appointments/${a.id}/reschedule`, ana, {
            startsAt: at(pick(DAYS), hhmm()),
            version: a.version,
            ...(rnd() < 0.5 ? { professionalId: pick(pros) } : {}),
          }) as Promise<Res>,
      ),
    cancel: () =>
      withKnown(
        (a) =>
          api(t, "POST", `/api/appointments/${a.id}/cancel`, ana, {
            version: a.version,
          }) as Promise<Res>,
      ),
    confirm: () =>
      withKnown(
        (a) =>
          api(t, "POST", `/api/appointments/${a.id}/confirm`, ana, {
            version: a.version,
          }) as Promise<Res>,
      ),
    complete: () =>
      withKnown(
        (a) =>
          api(t, "POST", `/api/appointments/${a.id}/complete`, ana, {
            version: a.version,
          }) as Promise<Res>,
      ),
    reactivate: () =>
      withKnown(
        (a) =>
          api(t, "POST", `/api/appointments/${a.id}/reactivate`, ana, {
            version: a.version,
          }) as Promise<Res>,
      ),
    "timeoff-create": () => {
      const day = pick(DAYS);
      const h = 8 + Math.floor(rnd() * 9);
      return api(t, "POST", "/api/time-off", ana, {
        professionalId: pick(pros),
        startsAt: at(
          day,
          `${String(h).padStart(2, "0")}:${pick(["00", "30"])}`,
        ),
        endsAt: at(
          day,
          `${String(h + 1 + Math.floor(rnd() * 2)).padStart(2, "0")}:00`,
        ),
      }) as Promise<Res>;
    },
    "workinghours-update": async () => {
      const pro = pick(pros);
      const list = (
        await api(t, "GET", `/api/working-hours?professionalId=${pro}`, ana)
      ).json().workingHours as Array<{ id: string; weekday: number }>;
      const target = pick(list);
      return api(t, "PATCH", `/api/working-hours/${target.id}`, ana, {
        endTime: pick(["16:00", "17:00", "17:30", "18:00", "19:00"]),
        startTime: pick(["07:00", "08:00", "09:00", "10:00"]),
      }) as Promise<Res>;
    },
    "customer-edit": async () => {
      const c = await t.prisma.customer.findMany({
        select: { id: true },
        take: 6,
      });
      if (!c.length) return create();
      return api(t, "PATCH", `/api/customers/${pick(c).id}`, ana, {
        notes: `n${Math.floor(rnd() * 1000)}`,
      }) as Promise<Res>;
    },
    "professional-services": () =>
      api(t, "PUT", `/api/professionals/${pick(pros)}/services`, ana, {
        serviceIds: rnd() < 0.8 ? services : [services[0]!],
      }) as Promise<Res>,
  };
  for (const k of kinds)
    if (!ops[k]) throw new Error(`operação desconhecida: ${k}`);

  const all = Array.from({ length: n }, async () => {
    await sleep(Math.floor(rnd() * 25)); // entrelaçamento irregular
    const kind = pick(kinds);
    const res = await ops[kind]!();
    outcomes.push({ kind, status: res.statusCode });
    return res;
  });
  const results = await Promise.all(all);
  return { results, outcomes, known };
}

/** Invariantes de 6.5 / L4, avaliadas direto no banco depois da carga. */
async function assertInvariants(label: string) {
  const c = await rawClient(TEST_DB);
  try {
    const overlap = await c.query(`
      SELECT a.id FROM appointments a JOIN appointments b
        ON a.professional_id = b.professional_id AND a.id < b.id
       AND a.status IN ('SCHEDULED','CONFIRMED') AND b.status IN ('SCHEDULED','CONFIRMED')
       AND tstzrange(a.starts_at, a.blocked_until, '[)') && tstzrange(b.starts_at, b.blocked_until, '[)')`);
    expect(overlap.rowCount, `${label}: ativos sobrepostos`).toBe(0);

    const now = t.clock.now();
    const offConflict = await c.query(
      `SELECT a.id FROM appointments a JOIN time_off o ON o.professional_id = a.professional_id
        WHERE a.status IN ('SCHEDULED','CONFIRMED') AND a.ends_at > $1
          AND a.starts_at < o.ends_at AND a.ends_at > o.starts_at`,
      [now],
    );
    expect(offConflict.rowCount, `${label}: ativo dentro de folga`).toBe(0);

    const active = await c.query(
      `SELECT id, professional_id, starts_at, ends_at FROM appointments WHERE status IN ('SCHEDULED','CONFIRMED') AND ends_at > $1`,
      [now],
    );
    const hours = await c.query(
      `SELECT professional_id, weekday, start_minute, end_minute FROM working_hours`,
    );
    const byPro = new Map<
      string,
      Array<{ weekday: number; startMinute: number; endMinute: number }>
    >();
    for (const h of hours.rows)
      byPro.set(h.professional_id, [
        ...(byPro.get(h.professional_id) ?? []),
        {
          weekday: h.weekday,
          startMinute: h.start_minute,
          endMinute: h.end_minute,
        },
      ]);
    const outside = active.rows.filter(
      (r) =>
        !fitsWorkingHours(
          { startsAt: r.starts_at, endsAt: r.ends_at },
          "America/Sao_Paulo",
          byPro.get(r.professional_id) ?? [],
        ),
    );
    expect(
      outside.map((r) => r.id),
      `${label}: ativo fora do expediente`,
    ).toEqual([]);

    const dupKey = await c.query(
      `SELECT appointment_id FROM idempotency_records WHERE appointment_id IS NOT NULL GROUP BY appointment_id HAVING count(*) > 1`,
    );
    expect(
      dupKey.rowCount,
      `${label}: mais de uma chave para o mesmo agendamento`,
    ).toBe(0);
    const orphan = await c.query(
      `SELECT 1 FROM idempotency_records WHERE appointment_id IS NULL OR response_status IS NULL`,
    );
    expect(
      orphan.rowCount,
      `${label}: registro de idempotência sem resultado (estado "em andamento" persistido)`,
    ).toBe(0);
  } finally {
    await c.end();
  }
}

const CLEAN_LOGS =
  /LockOrderViolation|LockCoverageViolation|40P01|TEMPORARILY_BUSY|55P03/;

describe("L4 — estresse com invariante: criar/cancelar/remarcar × TimeOff × WorkingHours", () => {
  it.each([4101, 4102])(
    "semente %i: nenhum ativo sobreposto, dentro de folga ou fora do expediente; zero 40P01",
    async (seed) => {
      const { results, outcomes } = await runLoad(seed, 160, [
        "create",
        "create",
        "create",
        "cancel",
        "reschedule",
        "timeoff-create",
        "workinghours-update",
        "reactivate",
      ]);
      const bad = results.filter(
        (r) => ![200, 201, 400, 404, 409, 422].includes(r.statusCode),
      );
      expect(
        bad.map((r) => r.statusCode),
        `semente ${seed}`,
      ).toEqual([]);
      expect(
        outcomes.filter((o) => o.kind === "create" && o.status === 201).length,
      ).toBeGreaterThan(10); // a carga fez trabalho
      expect(outcomes.some((o) => o.status === 409)).toBe(true); // e houve contenção/conflito de verdade
      expect(t.logs()).not.toMatch(CLEAN_LOGS);
      await assertInvariants(`L4 semente ${seed}`);
    },
    120_000,
  );
});

describe("L6 — remarcações cruzadas simultâneas (A→B e B→A)", () => {
  it("muitas repetições com início em ordem aleatória => ambas passam, sem 40P01 e sem violação do guard", async () => {
    const rnd = mulberry32(6001);
    const [A, B] = [pros[0]!, pros[1]!];
    for (let round = 0; round < 14; round++) {
      const day = DAYS[round % DAYS.length]!;
      const hour = Math.floor(round / DAYS.length); // (dia, hora) únicos por rodada
      const mk = async (pro: string, n: number) => {
        const res = await api(
          t,
          "POST",
          "/api/appointments",
          ana,
          {
            professionalId: pro,
            serviceId: services[0],
            startsAt: at(day, `${String(8 + hour).padStart(2, "0")}:00`),
            customer: newCustomer(round * 2 + n),
          },
          { "idempotency-key": randomUUID() },
        );
        expect(res.statusCode).toBe(201);
        return res.json().appointment as { id: string };
      };
      const x = await mk(A, 1);
      const y = await mk(B, 2);
      const time = `${13 + hour}:00`;
      const fire = (id: string, to: string, startsAt: string, delay: number) =>
        sleep(delay).then(() =>
          api(t, "POST", `/api/appointments/${id}/reschedule`, ana, {
            startsAt,
            professionalId: to,
            version: 1,
          }),
        );
      const jobs = [
        () => fire(x.id, B, at(day, time), Math.floor(rnd() * 12)),
        () => fire(y.id, A, at(day, time), Math.floor(rnd() * 12)),
      ];
      if (rnd() < 0.5) jobs.reverse();
      const [r1, r2] = await Promise.all(jobs.map((j) => j()));
      expect([r1!.statusCode, r2!.statusCode], `rodada ${round}`).toEqual([
        200, 200,
      ]);
      expect(
        (await t.prisma.appointment.findUniqueOrThrow({ where: { id: x.id } }))
          .professionalId,
      ).toBe(B);
      expect(
        (await t.prisma.appointment.findUniqueOrThrow({ where: { id: y.id } }))
          .professionalId,
      ).toBe(A);
    }
    expect(t.logs()).not.toMatch(CLEAN_LOGS);
    await assertInvariants("L6");
  }, 120_000);

  it("cruzadas para o MESMO horário de destino: ambas não cabem em B/A ao mesmo tempo => nunca dois ativos sobrepostos", async () => {
    const [A, B] = [pros[0]!, pros[1]!];
    for (let round = 0; round < 8; round++) {
      const day = DAYS[round % DAYS.length]!;
      const hour = Math.floor(round / DAYS.length);
      const mk = async (pro: string, n: number) =>
        (
          await api(
            t,
            "POST",
            "/api/appointments",
            ana,
            {
              professionalId: pro,
              serviceId: services[0],
              startsAt: at(day, `${String(8 + hour * 2).padStart(2, "0")}:00`),
              customer: newCustomer(300 + round * 2 + n),
            },
            { "idempotency-key": randomUUID() },
          )
        ).json().appointment as { id: string };
      const x = await mk(A, 1);
      const y = await mk(B, 2);
      // x vai para B às 09:00 e y (que já está em B) também quer as 09:00 => no máximo um vence
      const [r1, r2] = await Promise.all([
        api(t, "POST", `/api/appointments/${x.id}/reschedule`, ana, {
          startsAt: at(day, `${String(9 + hour * 2).padStart(2, "0")}:00`),
          professionalId: B,
          version: 1,
        }),
        api(t, "POST", `/api/appointments/${y.id}/reschedule`, ana, {
          startsAt: at(day, `${String(9 + hour * 2).padStart(2, "0")}:00`),
          version: 1,
        }),
      ]);
      expect([r1.statusCode, r2.statusCode].sort(), `rodada ${round}`).toEqual([
        200, 409,
      ]);
    }
    expect(t.logs()).not.toMatch(CLEAN_LOGS);
    await assertInvariants("L6b");
  }, 120_000);
});

describe("L7 — carga mista aleatória de TODAS as operações de 6.5", () => {
  const ALL = [
    "create",
    "create",
    "create",
    "create-existing-customer",
    "reschedule",
    "reschedule",
    "cancel",
    "confirm",
    "complete",
    "reactivate",
    "timeoff-create",
    "workinghours-update",
    "customer-edit",
    "professional-services",
  ] as const;

  it.each([7101, 7102])(
    "semente %i: só respostas de negócio (200/201/400/404/409/422); zero 40P01, zero LockOrderViolation, zero 503",
    async (seed) => {
      const { results, outcomes } = await runLoad(seed, 220, ALL);
      const statuses = new Set(results.map((r) => r.statusCode));
      for (const s of statuses)
        expect(
          [200, 201, 204, 400, 404, 409, 422],
          `semente ${seed}: status ${s}`,
        ).toContain(s);
      // cobertura da carga: cada família de operação foi exercitada ao menos uma vez
      const kinds = new Set(outcomes.map((o) => o.kind));
      for (const k of [
        "create",
        "reschedule",
        "cancel",
        "timeoff-create",
        "workinghours-update",
        "customer-edit",
      ])
        expect(kinds.has(k), k).toBe(true);
      expect(outcomes.filter((o) => o.status === 201).length).toBeGreaterThan(
        10,
      );
      // replays e reuso de chave aconteceram sem criar duplicatas (invariante abaixo)
      expect(
        results.some(
          (r) =>
            r.headers["idempotent-replay"] === "true" || r.statusCode === 409,
        ),
      ).toBe(true);
      expect(t.logs()).not.toMatch(CLEAN_LOGS);
      await assertInvariants(`L7 semente ${seed}`);
    },
    180_000,
  );
});
