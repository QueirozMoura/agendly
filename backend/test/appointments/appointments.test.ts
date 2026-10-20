// Etapa 10 — INTEGRAÇÃO (Postgres real, API completa): criar, consultar, remarcar, transições, reativar, clientes,
// slots, idempotência (6.4), R4 (TimeOff/WorkingHours × agendamentos) e snapshots. Relógio: TestClock
// (2031-03-01T12:00Z = sábado 09:00 em America/Sao_Paulo, UTC-3). Concorrência está em concurrency.test.ts.
import { randomUUID } from "node:crypto";
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
  makeService,
  newCustomer,
  type AppointmentJson,
  type Bookable,
} from "../support/booking.ts";

let t: AuthTestApp;
let ana: TestUser;
let b: Bookable;
const HOUR = 3_600_000;

beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
  ana = await signupVerified(t, "ana@example.com");
  expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(201);
  // Corte: 30 min + 10 min de buffer; expediente segunda a sexta, 08:00–18:00
  b = await makeBookable(t, ana, {
    name: "Corte",
    durationMinutes: 30,
    bufferMinutes: 10,
    priceCents: 5000,
  });
});
afterEach(() => t.close());

const input = (hhmm: string, over: Record<string, unknown> = {}) => ({
  professionalId: b.professionalId,
  serviceId: b.serviceId,
  startsAt: at(MONDAY, hhmm),
  customer: newCustomer(1),
  ...over,
});
const make = (hhmm: string, over: Record<string, unknown> = {}) =>
  bookOk(t, ana, input(hhmm, over) as never);
const tryBook = (hhmm: string, over: Record<string, unknown> = {}) =>
  book(t, ana, input(hhmm, over) as never);
const code = (r: { json: () => { error: { code: string } } }) =>
  r.json().error.code;
const act = (id: string, action: string, body: unknown, user = ana) =>
  api(t, "POST", `/api/appointments/${id}/${action}`, user, body);
const get = async (id: string) =>
  (await api(t, "GET", `/api/appointments/${id}`, ana)).json()
    .appointment as AppointmentJson;
const row = (id: string) =>
  t.prisma.appointment.findUniqueOrThrow({ where: { id } });
/** Leva o relógio para segunda-feira 09:00 locais (12:00Z), o que torna 09:00 e antes passado. */
const advanceToMonday = () => t.clock.advance(2 * 24 * HOUR);
const timeOff = (
  startsAt: string,
  endsAt: string,
  professionalId = b.professionalId,
) => api(t, "POST", "/api/time-off", ana, { professionalId, startsAt, endsAt });

describe("criação (painel)", () => {
  it("cria com cliente novo: faixa = início + duração; bloqueio = + buffer; snapshots; origem PANEL; versão 1", async () => {
    const res = await tryBook("10:00");
    expect(res.statusCode).toBe(201);
    expect(res.headers["idempotent-replay"]).toBeUndefined();
    const a = res.json().appointment as AppointmentJson;
    expect(a).toMatchObject({
      professionalId: b.professionalId,
      serviceId: b.serviceId,
      startsAt: "2031-03-03T13:00:00.000Z",
      endsAt: "2031-03-03T13:30:00.000Z",
      blockedUntil: "2031-03-03T13:40:00.000Z",
      status: "SCHEDULED",
      service: {
        name: "Corte",
        durationMinutes: 30,
        bufferMinutes: 10,
        priceCents: 5000,
      },
      source: "PANEL",
      cancelledAt: null,
      cancelReason: null,
      version: 1,
      customer: { name: "Cliente 1" },
    });
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const stored = await row(a.id);
    expect(stored.organizationId).toBe(org.id);
    expect(stored.createdByUserId).toBe(ana.userId);
    expect(JSON.stringify(res.json())).not.toContain(org.id);
    expect(
      await t.prisma.customer.findUniqueOrThrow({
        where: { id: a.customer.id },
      }),
    ).toMatchObject({
      organizationId: org.id,
      phoneE164: "+5511988881001",
      email: null,
    });
  });

  it("cliente existente pelo id; telefone já cadastrado (em outro formato) REUSA o cliente e NÃO sobrescreve os dados", async () => {
    const first = await make("10:00", {
      customer: newCustomer(1, { email: "orig@example.com", notes: "nota" }),
    });
    const byId = await make("11:00", {
      customer: undefined,
      customerId: first.customer.id,
    });
    expect(byId.customer.id).toBe(first.customer.id);
    const samePhone = await make("12:00", {
      customer: {
        name: "Outro Nome",
        phone: "+55 11 98888-1001",
        email: "novo@example.com",
      },
    });
    expect(samePhone.customer).toEqual(first.customer);
    expect(await t.prisma.customer.count()).toBe(1);
    expect(
      await t.prisma.customer.findUniqueOrThrow({
        where: { id: first.customer.id },
      }),
    ).toMatchObject({
      name: "Cliente 1",
      email: "orig@example.com",
      notes: "nota",
    });
  });

  it("editar o serviço depois NÃO muda agendamentos existentes; os novos usam os valores novos (6.3)", async () => {
    const a = await make("10:00");
    const patch = await api(t, "PATCH", `/api/services/${b.serviceId}`, ana, {
      name: "Corte premium",
      durationMinutes: 60,
      bufferMinutes: 0,
      priceCents: 9000,
    });
    expect(patch.statusCode).toBe(200);
    expect(await get(a.id)).toMatchObject({
      endsAt: a.endsAt,
      blockedUntil: a.blockedUntil,
      service: {
        name: "Corte",
        durationMinutes: 30,
        bufferMinutes: 10,
        priceCents: 5000,
      },
    });
    const novo = await make("14:00", { customer: newCustomer(2) });
    expect(novo).toMatchObject({
      endsAt: "2031-03-03T18:00:00.000Z",
      blockedUntil: "2031-03-03T18:00:00.000Z",
      service: { name: "Corte premium", durationMinutes: 60, priceCents: 9000 },
    });
  });

  it("o buffer pode ultrapassar o fim do expediente (R3), mas o atendimento não", async () => {
    const svc = await makeService(t, ana, {
      name: "Longo",
      durationMinutes: 30,
      bufferMinutes: 120,
    });
    const pro = await makeProfessional(t, ana, svc, { name: "Davi" });
    const edge = { professionalId: pro, serviceId: svc };
    const ok = await bookOk(t, ana, {
      ...edge,
      startsAt: at(MONDAY, "17:30"),
      customer: newCustomer(1),
    });
    expect(ok.endsAt).toBe("2031-03-03T21:00:00.000Z"); // 18:00 local
    expect(ok.blockedUntil).toBe("2031-03-03T23:00:00.000Z"); // 20:00 local, depois do expediente
    const over = await book(t, ana, {
      ...edge,
      startsAt: at(MONDAY, "17:45"),
      customer: newCustomer(2),
    });
    expect(over.statusCode).toBe(409);
    expect(code(over)).toBe("PROFESSIONAL_UNAVAILABLE");
  });

  it("validação de entrada => 400 e NADA é gravado (nem cliente, nem registro de idempotência)", async () => {
    const uuid = randomUUID();
    const bads: Array<Record<string, unknown>> = [
      { startsAt: at(MONDAY, "10:10") }, // fora da grade de 15 min
      { startsAt: "2031-03-03T10:00:30-03:00" }, // segundos
      { startsAt: "2031-03-03T10:00:00.500-03:00" }, // milissegundos
      { startsAt: "2031-03-03T10:00:00" }, // sem fuso
      { customer: undefined }, // sem cliente
      { customerId: uuid }, // customer + customerId
      { professionalId: "x" },
      { organizationId: uuid },
      { status: "CONFIRMED" },
      { endsAt: at(MONDAY, "11:00") },
      { customer: { name: "A", phone: "123" } },
    ];
    for (const bad of bads) {
      const res = await api(
        t,
        "POST",
        "/api/appointments",
        ana,
        { ...input("10:00"), ...bad },
        { "idempotency-key": randomUUID() },
      );
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(code(res)).toBe("VALIDATION_ERROR");
    }
    expect(await t.prisma.appointment.count()).toBe(0);
    expect(await t.prisma.customer.count()).toBe(0);
    expect(await t.prisma.idempotencyRecord.count()).toBe(0);
  });

  it("Idempotency-Key é obrigatório e precisa ser UUID => 400 IDEMPOTENCY_KEY_INVALID", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { "idempotency-key": "abc" },
      { "idempotency-key": "" },
    ]) {
      const res = await api(
        t,
        "POST",
        "/api/appointments",
        ana,
        input("10:00"),
        headers,
      );
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe("IDEMPOTENCY_KEY_INVALID");
    }
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it("passado e futuro distante (R7): 'agora', antes de agora => 422 STARTS_AT_IN_PAST; além de 730 dias => 422 STARTS_AT_TOO_FAR", async () => {
    advanceToMonday(); // agora = segunda 09:00 local
    for (const hhmm of ["09:00", "08:30", "08:00"]) {
      const res = await tryBook(hhmm);
      expect(res.statusCode, hhmm).toBe(422);
      expect(code(res)).toBe("STARTS_AT_IN_PAST");
    }
    expect(await t.prisma.appointment.count()).toBe(0);
    expect((await tryBook("09:15")).statusCode).toBe(201); // o primeiro horário futuro
    const far = await tryBook("10:00", { startsAt: at("2033-03-07", "10:00") }); // segunda, 735 dias à frente
    expect(far.statusCode).toBe(422);
    expect(code(far)).toBe("STARTS_AT_TOO_FAR");
  });

  it("expediente e folga: fora do expediente ou domingo => 409 PROFESSIONAL_UNAVAILABLE; folga que intersecta idem; encostar é permitido", async () => {
    for (const startsAt of [
      at(MONDAY, "07:30"),
      at(MONDAY, "17:45"),
      at("2031-03-09", "10:00"),
    ]) {
      const res = await tryBook("10:00", { startsAt });
      expect(res.statusCode, startsAt).toBe(409);
      expect(code(res)).toBe("PROFESSIONAL_UNAVAILABLE");
    }
    expect(
      (await timeOff(at(MONDAY, "10:00"), at(MONDAY, "11:00"))).statusCode,
    ).toBe(201);
    for (const hhmm of ["09:45", "10:00", "10:45"]) {
      const res = await tryBook(hhmm);
      expect(res.statusCode, hhmm).toBe(409);
      expect(code(res)).toBe("PROFESSIONAL_UNAVAILABLE");
    }
    await make("09:30"); // termina às 10:00: encosta no início da folga
    await make("11:00", { customer: newCustomer(2) }); // começa quando a folga acaba
    expect(await t.prisma.appointment.count()).toBe(2);
  });

  it("serviço sem vínculo/inativo => 422; profissional inativo => 409; inexistentes e de OUTRA empresa => 404 idêntico", async () => {
    const ghost = randomUUID();
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobB = await makeBookable(t, bob);
    const semVinculo = await makeService(t, ana, { name: "Barba" });
    const unlinked = await tryBook("10:00", { serviceId: semVinculo });
    expect(unlinked.statusCode).toBe(422);
    expect(code(unlinked)).toBe("SERVICE_NOT_AVAILABLE");

    const norm = (r: Awaited<ReturnType<typeof tryBook>>) => ({
      s: r.statusCode,
      e: { ...r.json().error, requestId: 0 },
    });
    const [proGhost, proForeign, svcGhost, svcForeign] = [
      await tryBook("10:00", { professionalId: ghost }),
      await tryBook("10:00", { professionalId: bobB.professionalId }),
      await tryBook("10:00", { serviceId: ghost }),
      await tryBook("10:00", { serviceId: bobB.serviceId }),
    ] as const;
    for (const r of [proGhost, proForeign, svcGhost, svcForeign])
      expect(r.statusCode).toBe(404);
    expect(norm(proGhost)).toEqual(norm(proForeign));
    expect(norm(svcGhost)).toEqual(norm(svcForeign));

    await api(t, "PATCH", `/api/services/${b.serviceId}`, ana, {
      active: false,
    });
    expect(code(await tryBook("10:00"))).toBe("SERVICE_NOT_AVAILABLE");
    await api(t, "PATCH", `/api/services/${b.serviceId}`, ana, {
      active: true,
    });
    await api(t, "PATCH", `/api/professionals/${b.professionalId}`, ana, {
      active: false,
    });
    const inactive = await tryBook("10:00");
    expect(inactive.statusCode).toBe(409);
    expect(code(inactive)).toBe("PROFESSIONAL_UNAVAILABLE");
    expect(
      await t.prisma.appointment.count({
        where: { professionalId: b.professionalId },
      }),
    ).toBe(0);
  });

  it("customerId de outra empresa ou inexistente => 404 idêntico e nada é criado", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobB = await makeBookable(t, bob);
    const bobAppt = await bookOk(t, bob, {
      ...bobB,
      startsAt: at(MONDAY, "10:00"),
      customer: newCustomer(9),
    });
    const norm = (r: Awaited<ReturnType<typeof tryBook>>) => ({
      s: r.statusCode,
      e: { ...r.json().error, requestId: 0 },
    });
    const foreign = await tryBook("10:00", {
      customer: undefined,
      customerId: bobAppt.customer.id,
    });
    const ghost = await tryBook("10:00", {
      customer: undefined,
      customerId: randomUUID(),
    });
    expect(foreign.statusCode).toBe(404);
    expect(norm(foreign)).toEqual(norm(ghost));
    expect(
      await t.prisma.appointment.count({
        where: { professionalId: b.professionalId },
      }),
    ).toBe(0);
  });

  it("conflitos: sobreposição e buffer => 409 SLOT_UNAVAILABLE; encostar e outro profissional passam; cancelado libera; falha faz rollback do cliente", async () => {
    await make("10:00"); // [10:00, 10:30), bloqueia até 10:40
    const customers = await t.prisma.customer.count();
    for (const hhmm of ["10:00", "10:15", "10:30", "09:30"]) {
      const res = await tryBook(hhmm, {
        customer: newCustomer(50 + Number(hhmm.slice(3))),
      });
      expect(res.statusCode, hhmm).toBe(409);
      expect(code(res)).toBe("SLOT_UNAVAILABLE");
    }
    expect(await t.prisma.customer.count()).toBe(customers); // o cliente novo da tentativa falha não ficou
    expect(await t.prisma.idempotencyRecord.count()).toBe(1); // só a do sucesso
    await make("09:15", { customer: newCustomer(2) }); // [09:15, 09:45) + 10 = 09:55: não invade o das 10:00
    await make("10:45", { customer: newCustomer(3) }); // depois de blocked_until (10:40)
    const other = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    await bookOk(t, ana, {
      ...b,
      professionalId: other,
      startsAt: at(MONDAY, "10:00"),
      customer: newCustomer(4),
    });
    const first = await t.prisma.appointment.findFirstOrThrow({
      where: {
        startsAt: new Date(at(MONDAY, "10:00")),
        professionalId: b.professionalId,
      },
    });
    expect(
      (await act(first.id, "cancel", { version: first.version })).statusCode,
    ).toBe(200);
    await make("10:00", { customer: newCustomer(5) }); // o horário foi liberado pelo cancelamento
  });
});

describe("consulta", () => {
  it("GET por id e listagem por período com filtros; id malformado/inexistente => 404 idêntico", async () => {
    const a = await make("10:00");
    const c2 = await make("11:00", { customer: newCustomer(2) });
    const tue = await make("10:00", {
      customer: newCustomer(3),
      startsAt: at("2031-03-04", "10:00"),
    });
    expect(await get(a.id)).toEqual(a);
    const list = async (q: string) =>
      (
        (await api(t, "GET", `/api/appointments?${q}`, ana)).json()
          .appointments as AppointmentJson[]
      ).map((x) => x.id);
    const day = `from=${encodeURIComponent(at(MONDAY, "00:00"))}&to=${encodeURIComponent(at("2031-03-04", "00:00"))}`;
    expect(await list(day)).toEqual([a.id, c2.id]); // ordenado por início; terça fica de fora
    expect(
      await list(
        `from=${encodeURIComponent(at(MONDAY, "00:00"))}&to=${encodeURIComponent(at("2031-03-05", "00:00"))}`,
      ),
    ).toEqual([a.id, c2.id, tue.id]);
    expect(await list(`${day}&customerId=${c2.customer.id}`)).toEqual([c2.id]);
    expect(await list(`${day}&status=CANCELLED`)).toEqual([]);
    expect(await list(`${day}&professionalId=${randomUUID()}`)).toEqual([]);
    // sobreposição parcial com o período entra (começa antes de `from`, termina depois)
    expect(
      await list(
        `from=${encodeURIComponent(at(MONDAY, "10:15"))}&to=${encodeURIComponent(at(MONDAY, "10:20"))}`,
      ),
    ).toEqual([a.id]);
    for (const q of [
      "",
      `from=${encodeURIComponent(at(MONDAY, "00:00"))}`,
      `${day}&organizationId=${randomUUID()}`,
    ])
      expect(
        (await api(t, "GET", `/api/appointments?${q}`, ana)).statusCode,
        q,
      ).toBe(400);
    const ghost = await api(t, "GET", `/api/appointments/${randomUUID()}`, ana);
    const bad = await api(t, "GET", "/api/appointments/malformado", ana);
    expect([ghost.statusCode, bad.statusCode]).toEqual([404, 404]);
    expect(ghost.json().error.code).toBe(bad.json().error.code);
  });
});

describe("remarcar", () => {
  it("mesmo profissional: recalcula a faixa com os snapshots, incrementa a versão e mantém o status", async () => {
    const a = await make("10:00");
    await act(a.id, "confirm", { version: 1 });
    await api(t, "PATCH", `/api/services/${b.serviceId}`, ana, {
      durationMinutes: 90,
      bufferMinutes: 0,
    }); // não pode afetar
    const res = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "14:00"),
      version: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().appointment).toMatchObject({
      status: "CONFIRMED",
      startsAt: "2031-03-03T17:00:00.000Z",
      endsAt: "2031-03-03T17:30:00.000Z",
      blockedUntil: "2031-03-03T17:40:00.000Z",
      version: 3,
      service: { durationMinutes: 30, bufferMinutes: 10 },
    });
    // deslocar para cima da própria faixa antiga não conflita consigo mesmo
    expect(
      (
        await act(a.id, "reschedule", {
          startsAt: at(MONDAY, "14:15"),
          version: 3,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("versão desatualizada => 409 STALE_VERSION e nada muda", async () => {
    const a = await make("10:00");
    expect(
      (
        await act(a.id, "reschedule", {
          startsAt: at(MONDAY, "11:00"),
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const stale = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "12:00"),
      version: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe("STALE_VERSION");
    expect(await row(a.id)).toMatchObject({
      version: 2,
      startsAt: new Date(at(MONDAY, "11:00")),
    });
  });

  it("para outro profissional: precisa estar ativo e oferecer o serviço; de outra empresa => 404", async () => {
    const a = await make("10:00");
    const davi = await makeProfessional(t, ana, b.serviceId, { name: "Davi" });
    const semServico = await makeProfessional(t, ana, undefined, {
      name: "Eva",
    });
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobPro = (await makeBookable(t, bob)).professionalId;

    const unlinked = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "10:00"),
      professionalId: semServico,
      version: 1,
    });
    expect(unlinked.statusCode).toBe(422);
    expect(code(unlinked)).toBe("SERVICE_NOT_AVAILABLE");
    expect(
      (
        await act(a.id, "reschedule", {
          startsAt: at(MONDAY, "10:00"),
          professionalId: bobPro,
          version: 1,
        })
      ).statusCode,
    ).toBe(404);
    await api(t, "PATCH", `/api/professionals/${davi}`, ana, { active: false });
    const inactive = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "10:00"),
      professionalId: davi,
      version: 1,
    });
    expect(inactive.statusCode).toBe(409);
    expect(code(inactive)).toBe("PROFESSIONAL_UNAVAILABLE");
    await api(t, "PATCH", `/api/professionals/${davi}`, ana, { active: true });
    const moved = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "10:00"),
      professionalId: davi,
      version: 1,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().appointment).toMatchObject({
      professionalId: davi,
      version: 2,
    });
    expect((await row(a.id)).professionalId).toBe(davi);
  });

  it("conflito, expediente, folga, passado e grade => erro e o agendamento fica exatamente como estava", async () => {
    const a = await make("10:00");
    await make("15:00", { customer: newCustomer(2) });
    await timeOff(at(MONDAY, "12:00"), at(MONDAY, "13:00"));
    const before = await row(a.id);
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ startsAt: at(MONDAY, "15:15") }, 409, "SLOT_UNAVAILABLE"],
      [{ startsAt: at(MONDAY, "14:45") }, 409, "SLOT_UNAVAILABLE"], // o buffer do novo invade as 15:00
      [{ startsAt: at(MONDAY, "12:30") }, 409, "PROFESSIONAL_UNAVAILABLE"],
      [{ startsAt: at(MONDAY, "18:00") }, 409, "PROFESSIONAL_UNAVAILABLE"],
      [{ startsAt: at(MONDAY, "10:10") }, 400, "VALIDATION_ERROR"],
      [{ startsAt: at("2031-02-28", "10:00") }, 422, "STARTS_AT_IN_PAST"],
    ];
    for (const [body, status, errCode] of cases) {
      const res = await act(a.id, "reschedule", { version: 1, ...body });
      expect([res.statusCode, code(res)], JSON.stringify(body)).toEqual([
        status,
        errCode,
      ]);
    }
    expect(await row(a.id)).toEqual(before);
  });

  it("só agendamentos ATIVOS podem ser remarcados; id de outra empresa/inexistente => 404", async () => {
    const a = await make("10:00");
    await act(a.id, "cancel", { version: 1 });
    const res = await act(a.id, "reschedule", {
      startsAt: at(MONDAY, "11:00"),
      version: 2,
    });
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "INVALID_STATUS_TRANSITION",
    ]);
    const done = await make("11:00", { customer: newCustomer(2) });
    t.clock.advance(2 * 24 * HOUR + 3 * HOUR); // segunda 12:00 locais: o atendimento das 11:00 já terminou
    await act(done.id, "complete", { version: 1 });
    expect(
      code(
        await act(done.id, "reschedule", {
          startsAt: at(MONDAY, "15:00"),
          version: 2,
        }),
      ),
    ).toBe("INVALID_STATUS_TRANSITION");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    for (const id of [a.id, randomUUID(), "malformado"])
      expect(
        (
          await act(
            id,
            "reschedule",
            { startsAt: at(MONDAY, "11:00"), version: 1 },
            bob,
          )
        ).statusCode,
        id,
      ).toBe(404);
  });
});

describe("transições de status", () => {
  it("confirmar, concluir, não compareceu: incrementam a versão; terminais não saem do lugar", async () => {
    const a = await make("10:00");
    const n = await make("11:00", { customer: newCustomer(2) });
    const c1 = await act(a.id, "confirm", { version: 1 });
    expect(c1.json().appointment).toMatchObject({
      status: "CONFIRMED",
      version: 2,
    });
    expect(code(await act(a.id, "confirm", { version: 2 }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    t.clock.advance(2 * 24 * HOUR + 3 * HOUR); // segunda 12:00 locais: os dois atendimentos já terminaram
    expect(
      (await act(a.id, "complete", { version: 2 })).json().appointment,
    ).toMatchObject({ status: "COMPLETED", version: 3 });
    for (const action of ["confirm", "complete", "no-show", "cancel"]) {
      const res = await act(a.id, action, { version: 3 });
      expect([res.statusCode, code(res)], action).toEqual([
        409,
        "INVALID_STATUS_TRANSITION",
      ]);
    }
    expect(await row(a.id)).toMatchObject({ status: "COMPLETED", version: 3 });
    expect(
      (await act(n.id, "no-show", { version: 1 })).json().appointment.status,
    ).toBe("NO_SHOW");
  });

  it("cancelar registra cancelled_at (relógio) e motivo, libera o horário e não apaga a linha", async () => {
    const a = await make("10:00");
    const res = await act(a.id, "cancel", {
      version: 1,
      reason: "  cliente desistiu ",
    });
    expect(res.json().appointment).toMatchObject({
      status: "CANCELLED",
      cancelReason: "cliente desistiu",
      cancelledAt: t.clock.now().toISOString(),
      version: 2,
    });
    expect(await t.prisma.appointment.count()).toBe(1);
    await make("10:00", { customer: newCustomer(2) });
  });

  it("versão desatualizada ou ausente; corpo inválido; passado é permitido para concluir/cancelar", async () => {
    const a = await make("10:00");
    const stale = await act(a.id, "cancel", { version: 7 });
    expect([stale.statusCode, code(stale)]).toEqual([409, "STALE_VERSION"]);
    for (const body of [
      {},
      { version: 0 },
      { version: "1" },
      { version: 1, status: "X" },
    ])
      expect(
        (await act(a.id, "confirm", body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    expect((await row(a.id)).status).toBe("SCHEDULED");
    t.clock.advance(5 * 24 * HOUR); // depois do horário
    expect((await act(a.id, "complete", { version: 1 })).statusCode).toBe(200);
  });

  it("de outra empresa ou inexistente => 404 idêntico", async () => {
    const a = await make("10:00");
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const foreign = await act(a.id, "cancel", { version: 1 }, bob);
    const ghost = await act(randomUUID(), "cancel", { version: 1 }, bob);
    expect(foreign.statusCode).toBe(404);
    expect({ ...foreign.json().error, requestId: 0 }).toEqual({
      ...ghost.json().error,
      requestId: 0,
    });
    expect((await row(a.id)).status).toBe("SCHEDULED");
  });
});

describe("reativar cancelado", () => {
  it("revalida e reativa: status SCHEDULED, limpa cancelamento, versão +1", async () => {
    const a = await make("10:00");
    await act(a.id, "cancel", { version: 1, reason: "x" });
    const res = await act(a.id, "reactivate", { version: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json().appointment).toMatchObject({
      status: "SCHEDULED",
      cancelledAt: null,
      cancelReason: null,
      version: 3,
      startsAt: a.startsAt,
    });
    expect(code(await act(a.id, "reactivate", { version: 3 }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
  });

  it("horário ocupado nesse meio tempo => 409 SLOT_UNAVAILABLE e continua cancelado", async () => {
    const a = await make("10:00");
    await act(a.id, "cancel", { version: 1 });
    await make("10:15", { customer: newCustomer(2) });
    const res = await act(a.id, "reactivate", { version: 2 });
    expect([res.statusCode, code(res)]).toEqual([409, "SLOT_UNAVAILABLE"]);
    expect(await row(a.id)).toMatchObject({ status: "CANCELLED", version: 2 });
  });

  it("no passado => 422; folga criada depois => 409; versão desatualizada => 409 STALE_VERSION", async () => {
    const a = await make("10:00");
    await act(a.id, "cancel", { version: 1 });
    expect(code(await act(a.id, "reactivate", { version: 1 }))).toBe(
      "STALE_VERSION",
    );
    await timeOff(at(MONDAY, "10:00"), at(MONDAY, "10:30")); // permitido: o agendamento está cancelado
    const blocked = await act(a.id, "reactivate", { version: 2 });
    expect([blocked.statusCode, code(blocked)]).toEqual([
      409,
      "PROFESSIONAL_UNAVAILABLE",
    ]);
    t.clock.advance(3 * 24 * HOUR);
    const past = await act(a.id, "reactivate", { version: 2 });
    expect([past.statusCode, code(past)]).toEqual([422, "STARTS_AT_IN_PAST"]);
  });
});

describe("clientes", () => {
  it("GET e PATCH: edita nome, e-mail, observações e telefone; telefone repetido => 409; e-mail/observações podem ser limpos", async () => {
    const a = await make("10:00", {
      customer: newCustomer(1, { email: "a@example.com", notes: "n" }),
    });
    const other = await make("11:00", { customer: newCustomer(2) });
    const url = (id: string) => `/api/customers/${id}`;
    expect(
      (await api(t, "GET", url(a.customer.id), ana)).json().customer,
    ).toMatchObject({
      name: "Cliente 1",
      phone: "+5511988881001",
      email: "a@example.com",
      notes: "n",
    });
    const patched = await api(t, "PATCH", url(a.customer.id), ana, {
      name: " Ana Maria ",
      phone: "(21) 99999-0000",
      email: null,
      notes: "",
    });
    expect(patched.json().customer).toMatchObject({
      name: "Ana Maria",
      phone: "+5521999990000",
      email: null,
      notes: null,
    });
    const taken = await api(t, "PATCH", url(a.customer.id), ana, {
      phone: "11 98888-1002",
    });
    expect([taken.statusCode, code(taken)]).toEqual([
      409,
      "CUSTOMER_PHONE_TAKEN",
    ]);
    expect(
      (
        await t.prisma.customer.findUniqueOrThrow({
          where: { id: a.customer.id },
        })
      ).phoneE164,
    ).toBe("+5521999990000");
    for (const body of [
      {},
      { name: "" },
      { phone: "abc" },
      { email: "x" },
      { organizationId: randomUUID() },
      { id: randomUUID() },
    ])
      expect(
        (await api(t, "PATCH", url(other.customer.id), ana, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    // agendamentos já criados refletem o nome atual do cliente
    expect((await get(a.id)).customer.name).toBe("Ana Maria");
  });
});

describe("slots (leitura sem lock)", () => {
  const slots = async (q: Record<string, string>) => {
    const res = await api(
      t,
      "GET",
      `/api/availability/slots?${new URLSearchParams(q)}`,
      ana,
    );
    return res;
  };
  const q = (over: Record<string, string> = {}) => ({
    professionalId: b.professionalId,
    serviceId: b.serviceId,
    date: MONDAY,
    ...over,
  });
  const locals = (list: string[]) =>
    list.map((iso) =>
      new Date(new Date(iso).getTime() - 3 * HOUR).toISOString().slice(11, 16),
    );

  it("grade de 15 min dentro do expediente, descontando agendamento (com buffer) e folga", async () => {
    await make("10:00");
    await timeOff(at(MONDAY, "14:00"), at(MONDAY, "15:00"));
    const res = await slots(q());
    expect(res.statusCode).toBe(200);
    const list = locals(res.json().slots);
    expect(list[0]).toBe("08:00");
    expect(list.at(-1)).toBe("17:30");
    expect(list).toContain("09:15"); // 09:15–09:45 (+10 = 09:55) não invade as 10:00
    for (const hhmm of ["09:30", "09:45", "10:00", "10:30"])
      expect(list, hhmm).not.toContain(hhmm);
    expect(list).toContain("10:45");
    for (const hhmm of ["13:45", "14:00", "14:30"])
      expect(list, hhmm).not.toContain(hhmm); // 13:45–14:15 intersecta a folga
    expect(list).toContain("13:15"); // termina 13:45: encosta no início da folga
    expect(list).toContain("15:00");
  });

  it("todo slot devolvido é aceito pela criação (extremos e meio); um horário não devolvido é recusado", async () => {
    await make("10:00");
    const list = (await slots(q())).json().slots as string[];
    for (const iso of [
      list[0]!,
      list[Math.floor(list.length / 2)]!,
      list.at(-1)!,
    ]) {
      const res = await bookOk(t, ana, {
        ...b,
        startsAt: iso,
        customer: newCustomer(Math.floor(Math.random() * 1e6) % 9000),
      });
      expect(res.startsAt).toBe(iso);
    }
    expect(
      (await tryBook("10:00", { customer: newCustomer(70) })).statusCode,
    ).toBe(409);
  });

  it("não devolve o passado; inativos, sem vínculo ou sem expediente => lista vazia; dia sem expediente => vazio", async () => {
    advanceToMonday();
    const list = locals((await slots(q())).json().slots);
    expect(list[0]).toBe("09:15");
    expect((await slots(q({ date: "2031-03-09" }))).json().slots).toEqual([]); // domingo
    const semServico = await makeService(t, ana, { name: "Barba" });
    expect((await slots(q({ serviceId: semServico }))).json().slots).toEqual(
      [],
    );
    await api(t, "PATCH", `/api/services/${b.serviceId}`, ana, {
      active: false,
    });
    expect((await slots(q())).json().slots).toEqual([]);
  });

  it("validação e isolamento: parâmetros inválidos => 400; profissional/serviço inexistentes ou de outra empresa => 404", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobB = await makeBookable(t, bob);
    for (const bad of [
      { date: "2031-13-01" } as Record<string, string>,
      { date: "03/03/2031" },
      { professionalId: "x" },
      { organizationId: randomUUID() },
    ])
      expect((await slots(q(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    expect(
      (await slots(q({ professionalId: bobB.professionalId }))).statusCode,
    ).toBe(404);
    expect((await slots(q({ serviceId: bobB.serviceId }))).statusCode).toBe(
      404,
    );
    expect((await slots(q({ professionalId: randomUUID() }))).statusCode).toBe(
      404,
    );
  });
});

describe("R4 — TimeOff × agendamentos ativos futuros (rejeita com a lista; nada é cancelado)", () => {
  it("folga que intersecta [starts_at, ends_at) => 409 com a lista completa; nenhuma folga criada; agendamentos intactos (L11)", async () => {
    const a = await make("10:00");
    const c2 = await make("10:45", { customer: newCustomer(2) });
    const before = await t.prisma.appointment.findMany({
      orderBy: { id: "asc" },
    });
    const res = await timeOff(at(MONDAY, "10:15"), at(MONDAY, "11:00"));
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe("TIMEOFF_CONFLICTS_WITH_APPOINTMENTS");
    const conflicts = res.json().error.details.conflicts as Array<{
      id: string;
      customer: { name: string };
      serviceName: string;
      status: string;
    }>;
    expect(conflicts.map((x) => x.id)).toEqual([a.id, c2.id]);
    expect(res.json().error.details).toMatchObject({
      totalCount: 2,
      truncated: false,
    });
    expect(conflicts[0]).toMatchObject({
      customer: { name: "Cliente 1" },
      serviceName: "Corte",
      status: "SCHEDULED",
    });
    expect(await t.prisma.timeOff.count()).toBe(0);
    expect(
      await t.prisma.appointment.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(before);
  });

  it("buffer não conta (R3): folga só sobre o buffer ou encostada passa; cancelado, concluído e já terminado não conflitam", async () => {
    const a = await make("10:00"); // atendimento até 10:30; buffer até 10:40
    expect(
      (await timeOff(at(MONDAY, "10:30"), at(MONDAY, "10:40"))).statusCode,
    ).toBe(201);
    expect(
      (await timeOff(at(MONDAY, "09:00"), at(MONDAY, "10:00"))).statusCode,
    ).toBe(201);
    const c = await make("11:00", { customer: newCustomer(2) });
    await act(c.id, "cancel", { version: 1 });
    const d = await make("12:00", { customer: newCustomer(3) });
    const e = await make("13:00", { customer: newCustomer(4) });
    // concluído / não compareceu só existem depois do fim; aqui o status é posto direto para isolar a regra de R4
    await t.prisma.appointment.update({
      where: { id: d.id },
      data: { status: "COMPLETED" },
    });
    await t.prisma.appointment.update({
      where: { id: e.id },
      data: { status: "NO_SHOW" },
    });
    expect(
      (await timeOff(at(MONDAY, "11:00"), at(MONDAY, "14:00"))).statusCode,
    ).toBe(201);
    expect(
      (await timeOff(at(MONDAY, "10:20"), at(MONDAY, "10:25"))).statusCode,
    ).toBe(409); // sobre o atendimento
    t.clock.advance(3 * 24 * HOUR); // 'a' já terminou
    expect(
      (await timeOff(at(MONDAY, "10:20"), at(MONDAY, "10:25"))).statusCode,
    ).toBe(201);
    expect((await row(a.id)).status).toBe("SCHEDULED");
  });

  it("alterar uma folga existente para cima de um agendamento => 409 e a folga fica como estava", async () => {
    await make("10:00");
    const off = (await timeOff(at(MONDAY, "12:00"), at(MONDAY, "13:00"))).json()
      .timeOff;
    const res = await api(t, "PATCH", `/api/time-off/${off.id}`, ana, {
      startsAt: at(MONDAY, "09:00"),
    });
    expect([res.statusCode, code(res)]).toEqual([
      409,
      "TIMEOFF_CONFLICTS_WITH_APPOINTMENTS",
    ]);
    expect(
      (
        await t.prisma.timeOff.findUniqueOrThrow({ where: { id: off.id } })
      ).startsAt.toISOString(),
    ).toBe("2031-03-03T15:00:00.000Z");
    // remover uma folga nunca conflita
    expect(
      (await api(t, "DELETE", `/api/time-off/${off.id}`, ana, {})).statusCode,
    ).toBe(204);
  });
});

describe("R4 — WorkingHours × agendamentos ativos futuros", () => {
  const hours = async (weekday = 1) =>
    (
      (
        await api(
          t,
          "GET",
          `/api/working-hours?professionalId=${b.professionalId}`,
          ana,
        )
      ).json().workingHours as Array<{ id: string; weekday: number }>
    ).find((h) => h.weekday === weekday)!;

  it("reduzir/mover/remover o expediente que deixaria agendamento de fora => 409 com a lista; ampliar ou reduzir sem afetar passa", async () => {
    const early = await make("09:00");
    const late = await make("17:00", { customer: newCustomer(2) });
    const mon = await hours(1);
    const url = `/api/working-hours/${mon.id}`;
    const conflict = async (
      body: unknown,
      method: "PATCH" | "DELETE" = "PATCH",
    ) => {
      const res = await api(t, method, url, ana, body);
      expect([res.statusCode, code(res)]).toEqual([
        409,
        "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
      ]);
      return (res.json().error.details.conflicts as Array<{ id: string }>).map(
        (x) => x.id,
      );
    };
    expect(await conflict({ endTime: "17:15" })).toEqual([late.id]);
    expect(await conflict({ startTime: "09:15" })).toEqual([early.id]);
    expect(await conflict({ startTime: "10:00", endTime: "12:00" })).toEqual([
      early.id,
      late.id,
    ]);
    expect(await conflict({ weekday: 6 })).toEqual([early.id, late.id]); // mover para sábado tira a segunda
    expect(await conflict({}, "DELETE")).toEqual([early.id, late.id]);
    expect(await row(late.id)).toMatchObject({
      status: "SCHEDULED",
      version: 1,
    });
    const unchanged = await t.prisma.workingHours.findUniqueOrThrow({
      where: { id: mon.id },
    });
    expect([
      unchanged.startMinute,
      unchanged.endMinute,
      unchanged.weekday,
    ]).toEqual([480, 1080, 1]);

    expect(
      (
        await api(t, "PATCH", url, ana, {
          startTime: "09:00",
          endTime: "17:30",
        })
      ).statusCode,
    ).toBe(200); // cabe exatamente
    expect(
      (
        await api(t, "PATCH", url, ana, {
          startTime: "07:00",
          endTime: "20:00",
        })
      ).statusCode,
    ).toBe(200); // ampliar
    expect(
      (
        await api(
          t,
          "DELETE",
          `/api/working-hours/${(await hours(2)).id}`,
          ana,
          {},
        )
      ).statusCode,
    ).toBe(204); // outro dia
    // criar novo intervalo nunca conflita
    expect(
      (
        await api(t, "POST", "/api/working-hours", ana, {
          professionalId: b.professionalId,
          weekday: 6,
          startTime: "08:00",
          endTime: "12:00",
        })
      ).statusCode,
    ).toBe(201);
  });

  it("o buffer não entra (R3), dois intervalos que cobrem o agendamento, cancelados e já terminados não conflitam", async () => {
    const svc = await makeService(t, ana, {
      name: "Longo",
      durationMinutes: 30,
      bufferMinutes: 120,
    });
    const pro = await makeProfessional(t, ana, svc, {
      name: "Davi",
      hours: [
        ["08:00", "12:00"],
        ["12:00", "18:00"],
      ],
      weekdays: [1],
    });
    const a = await bookOk(t, ana, {
      professionalId: pro,
      serviceId: svc,
      startsAt: at(MONDAY, "17:30"),
      customer: newCustomer(1),
    });
    expect(a.blockedUntil).toBe("2031-03-03T23:00:00.000Z");
    const list = (
      await api(t, "GET", `/api/working-hours?professionalId=${pro}`, ana)
    ).json().workingHours as Array<{ id: string; startTime: string }>;
    const second = list.find((h) => h.startTime === "12:00")!;
    const first = list.find((h) => h.startTime === "08:00")!;
    expect(
      (
        await api(t, "PATCH", `/api/working-hours/${second.id}`, ana, {
          endTime: "17:30",
        })
      ).statusCode,
    ).toBe(409); // o atendimento sai de fora
    expect(
      (
        await api(t, "PATCH", `/api/working-hours/${second.id}`, ana, {
          endTime: "18:00",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await api(t, "DELETE", `/api/working-hours/${first.id}`, ana, {}))
        .statusCode,
    ).toBe(204); // a manhã não afeta o das 17:30
    await act(a.id, "cancel", { version: 1 });
    expect(
      (await api(t, "DELETE", `/api/working-hours/${second.id}`, ana, {}))
        .statusCode,
    ).toBe(204); // cancelado: nada a proteger
  });
});

describe("idempotência (6.4)", () => {
  const post = (body: unknown, key: string, user = ana) =>
    api(t, "POST", "/api/appointments", user, body, { "idempotency-key": key });

  it("1. mesma chave + mesmo pedido => mesmo status e corpo, Idempotent-Replay, e UM agendamento (mesmo se ele mudou depois)", async () => {
    const key = randomUUID();
    const first = await post(input("10:00"), key);
    expect(first.statusCode).toBe(201);
    const a = first.json().appointment as AppointmentJson;
    await act(a.id, "confirm", { version: 1 });
    const replay = await post(input("10:00"), key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json()).toEqual(first.json()); // a resposta ORIGINAL (versão 1, SCHEDULED)
    expect(await t.prisma.appointment.count()).toBe(1);
    expect(await t.prisma.customer.count()).toBe(1);
    expect(await t.prisma.idempotencyRecord.count()).toBe(1);
    const record = await t.prisma.idempotencyRecord.findFirstOrThrow();
    expect(record).toMatchObject({
      scope: "appointments.create",
      key,
      appointmentId: a.id,
      responseStatus: 201,
    });
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(
      24 * HOUR,
    );
  });

  it("2. mesma chave + payload diferente => 409 IDEMPOTENCY_KEY_REUSED, mensagem genérica sem dados do original", async () => {
    const key = randomUUID();
    const first = await post(
      input("10:00", { customer: newCustomer(1, { name: "Maria Secreta" }) }),
      key,
    );
    expect(first.statusCode).toBe(201);
    for (const other of [
      input("11:00"),
      input("10:00", { customer: newCustomer(2) }),
    ]) {
      const res = await post(other, key);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe("IDEMPOTENCY_KEY_REUSED");
      const text = JSON.stringify(res.json());
      expect(text).not.toMatch(/Maria|Secreta|\+55|10:00|13:00|appointment/i);
      expect(text).not.toContain(first.json().appointment.id);
    }
    expect(await t.prisma.appointment.count()).toBe(1);
  });

  it("3. a mesma chave em duas empresas é independente", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    await createOrg(t, bob, "barbearia");
    const bobB = await makeBookable(t, bob);
    const key = randomUUID();
    const mine = await post(input("10:00"), key);
    const theirs = await post(
      { ...bobB, startsAt: at(MONDAY, "10:00"), customer: newCustomer(1) },
      key,
      bob,
    );
    expect([mine.statusCode, theirs.statusCode]).toEqual([201, 201]);
    expect(mine.json().appointment.id).not.toBe(theirs.json().appointment.id);
    expect(await t.prisma.idempotencyRecord.count()).toBe(2);
  });

  it("5. falha (conflito de horário) NÃO consome a chave: depois de liberar o horário, a mesma chave funciona", async () => {
    const taken = await make("10:00");
    const key = randomUUID();
    const fail = await post(input("10:15", { customer: newCustomer(2) }), key);
    expect([fail.statusCode, code(fail)]).toEqual([409, "SLOT_UNAVAILABLE"]);
    expect(await t.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    await act(taken.id, "cancel", { version: 1 });
    const retry = await post(input("10:15", { customer: newCustomer(2) }), key);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replay"]).toBeUndefined(); // foi uma operação nova
  });

  it("6. registro vencido => operação nova: payload diferente com a mesma chave reivindica o registro; o mesmo pedido continua dando 409 SLOT_UNAVAILABLE (não duplica)", async () => {
    const key = randomUUID();
    const first = await post(input("10:00"), key);
    expect(first.statusCode).toBe(201);
    const c = await rawClient(TEST_DB);
    try {
      await c.query(
        "UPDATE idempotency_records SET expires_at = now() - interval '1 minute'",
      );
    } finally {
      await c.end();
    }
    const same = await post(input("10:00"), key);
    expect([same.statusCode, code(same)]).toEqual([409, "SLOT_UNAVAILABLE"]);
    const novo = await post(input("11:00", { customer: newCustomer(2) }), key);
    expect(novo.statusCode).toBe(201);
    expect(novo.headers["idempotent-replay"]).toBeUndefined();
    const record = await t.prisma.idempotencyRecord.findFirstOrThrow();
    expect(record.appointmentId).toBe(novo.json().appointment.id);
    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await t.prisma.idempotencyRecord.count()).toBe(1);
    expect(await t.prisma.appointment.count()).toBe(2);
  });

  it("7. ordem das chaves do JSON e formato do telefone não mudam o hash => é replay", async () => {
    const key = randomUUID();
    const a = JSON.stringify({
      professionalId: b.professionalId,
      serviceId: b.serviceId,
      startsAt: at(MONDAY, "10:00"),
      customer: { name: "Ana", phone: "(11) 98765-4321" },
    });
    const reordered = JSON.stringify({
      customer: { phone: "+55 11 98765 4321", name: "Ana" },
      startsAt: "2031-03-03T13:00:00Z", // mesmo instante, outro offset
      serviceId: b.serviceId,
      professionalId: b.professionalId,
    });
    const r1 = await post(a, key);
    const r2 = await post(reordered, key);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r2.headers["idempotent-replay"]).toBe("true");
    expect(await t.prisma.appointment.count()).toBe(1);
  });

  it("9. a limpeza remove só o vencido há mais que a margem; vigentes e recém-vencidos ficam", async () => {
    await make("10:00");
    const org = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "salao-da-ana" },
      })
    ).id;
    const c = await rawClient(TEST_DB);
    try {
      const insert = (offset: string) =>
        c.query(
          `INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, 'appointments.create', gen_random_uuid(), 'h', now(), now() + $2::interval)`,
          [org, offset],
        );
      await insert("-30 minutes"); // vencido há 30 min: dentro da margem de 1 h
      await insert("-2 hours"); // vencido há 2 h: elegível
      await insert("-25 hours"); // elegível
      await insert("1 hour"); // vigente
    } finally {
      await c.end();
    }
    const result = await runMaintenance({
      prisma: t.prisma,
      clock: t.clock,
      logger: { info: () => undefined },
    });
    expect(result.idempotency).toBe(2);
    expect(await t.prisma.idempotencyRecord.count()).toBe(3); // a do agendamento + vigente + recém-vencido
    expect(
      (
        await runMaintenance({
          prisma: t.prisma,
          clock: t.clock,
          logger: { info: () => undefined },
        })
      ).idempotency,
    ).toBe(0);
  });
});
