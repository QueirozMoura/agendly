// Etapa 10 — testes UNITÁRIOS (sem banco): telefone, faixa do agendamento, transições, hash canônico, "cabe no
// expediente" e esquemas de entrada.
import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/lib/phone.ts";
import { fitsWorkingHours } from "../../src/modules/availability/fit.ts";
import {
  canonicalJson,
  requestHash,
} from "../../src/modules/appointments/idempotency.ts";
import { computeAppointmentRange } from "../../src/modules/appointments/range.ts";
import {
  cancelBody,
  createAppointmentBody,
  listAppointmentsQuery,
  rescheduleBody,
} from "../../src/modules/appointments/schemas.ts";
import {
  APPOINTMENT_STATUSES,
  isActive,
  nextStatus,
  type StatusAction,
} from "../../src/modules/appointments/transitions.ts";

describe("normalizePhone (E.164)", () => {
  it.each([
    ["(11) 98765-4321", "+5511987654321"],
    ["11987654321", "+5511987654321"],
    ["11 98765 4321", "+5511987654321"],
    ["11.98765.4321", "+5511987654321"],
    ["+55 11 98765-4321", "+5511987654321"],
    ["5511987654321", "+5511987654321"],
    ["005511987654321", "+5511987654321"],
    ["(21) 2345-6789", "+552123456789"], // fixo de 10 dígitos
    ["+1 (415) 555-2671", "+14155552671"],
    ["+351 912 345 678", "+351912345678"],
    ["  +5511987654321  ", "+5511987654321"],
  ])("%s => %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "abc",
    "11 9876-54321x",
    "(11) 8765-4321 ramal 2",
    "119876543", // curto
    "0119876543210", // zero à esquerda
    "10987654321", // DDD 10 inválido
    "11887654321", // 11 dígitos sem o 9
    "+5511887654321", // idem, internacional
    "+0123456789",
    "+1234567", // < 8 dígitos
    "+1234567890123456", // > 15 dígitos
    "119876543210000",
    "++5511987654321",
    "55 (11) 8765",
  ])("rejeita %j", (input) => {
    expect(normalizePhone(input)).toBeUndefined();
  });

  it("formatos diferentes do mesmo número normalizam para o mesmo E.164 (base do P2)", () => {
    const variants = [
      "(11) 98765-4321",
      "11987654321",
      "+55 11 98765-4321",
      "5511987654321",
      "11 98765.4321",
    ];
    expect(new Set(variants.map(normalizePhone)).size).toBe(1);
  });
});

describe("normalizePhone — regras brasileiras e limites (revisão da Etapa 10)", () => {
  it.each([
    ["011 98765-4321", "+5511987654321"], // prefixo nacional "0"
    ["(011) 2345-6789", "+551123456789"],
    ["0 11 98765 4321", "+5511987654321"],
    ["+55 (11) 2345-6789", "+551123456789"],
    ["+55\u00a011\u00a098765-4321", "+5511987654321"], // espaço não separável
    ["11\t98765\n4321", "+5511987654321"],
    ["99 99999-9999", "+5599999999999"], // DDD 99
    ["11 3456-7890", "+551134567890"], // fixo começando em 3
    ["+44 20 7946 0958", "+442079460958"],
    ["+351 21 123 4567", "+351211234567"],
    ["+1 415 555 2671", "+14155552671"],
    ["+123456789012345", "+123456789012345"], // 15 dígitos (máximo E.164)
    ["+55 55 99123-4567", "+5555991234567"], // DDD 55 não confunde com o código do país
    ["55 3212-3456", "+555532123456"],
  ])("aceita %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    "1198765432", // 10 dígitos começando em 9: celular sem o dígito extra NÃO é fixo
    "1187654321", // fixo precisa começar em 2–5
    "1167654321",
    "(11) 1234-5678",
    "10 98765-4321", // DDD com zero
    "01 98765-4321",
    "+55 11 8765-4321".replace("8765-4321", "88765-4321"), // celular sem o 9
    "+55 11 98765-432", // curto
    "+55 11 98765-43210", // longo
    "+1234567890123456", // 16 dígitos
    "+12345", // curto
    "+0 123 456 789",
    "011",
    "0",
    "(11) 98765-4321 / (11) 91234-5678", // dois números
    "11 98765-4321x",
    "１１９８７６５４３２１", // dígitos de largura total
    "+55 11 9876٥-4321", // dígito árabe-índico
  ])("rejeita %j", (input) => {
    expect(normalizePhone(input)).toBeUndefined();
  });

  it("LIMITE documentado: fora do Brasil a validação é só sintática (código de país e faixa não são conferidos)", () => {
    expect(normalizePhone("+999 12345678")).toBe("+99912345678"); // +999 não é um código de país atribuído
    expect(normalizePhone("00 98765-4321")).toBe("+987654321"); // "00" = prefixo internacional (código 98, Irã), não DDD
    expect(normalizePhone("+1 000 000 0000")).toBe("+10000000000");
  });

  it("a saída é sempre compatível com o CHECK do banco e é idempotente", () => {
    const db = /^\+[1-9][0-9]{7,14}$/;
    const samples = [
      "(11) 98765-4321",
      "011 2345-6789",
      "+44 20 7946 0958",
      "5511987654321",
      "005511987654321",
      "(99) 3456-7890",
    ];
    for (const s of samples) {
      const out = normalizePhone(s) as string;
      expect(out, s).toMatch(db);
      expect(normalizePhone(out), s).toBe(out); // normalizar duas vezes não muda
    }
    // varredura: nenhum DDD válido × tipo de número produz algo que o banco recusaria
    for (let ddd = 11; ddd <= 99; ddd++) {
      if (String(ddd).includes("0")) {
        expect(normalizePhone(`${ddd}987654321`)).toBeUndefined();
        continue;
      }
      for (const n of [`${ddd}987654321`, `${ddd}23456789`, `${ddd}54321098`]) {
        const out = normalizePhone(n);
        expect(out, n).toMatch(db);
        expect(out).toBe(`+55${n}`);
      }
    }
  });
});

describe("computeAppointmentRange (6.1, V8)", () => {
  const start = new Date("2031-03-03T13:00:00.000Z");
  it("ends_at = início + duração; blocked_until = ends_at + buffer", () => {
    const r = computeAppointmentRange(start, 45, 15);
    expect(r.startsAt.toISOString()).toBe("2031-03-03T13:00:00.000Z");
    expect(r.endsAt.toISOString()).toBe("2031-03-03T13:45:00.000Z");
    expect(r.blockedUntil.toISOString()).toBe("2031-03-03T14:00:00.000Z");
  });
  it("buffer zero: blocked_until = ends_at; duração fora da grade é aceita", () => {
    const r = computeAppointmentRange(start, 20, 0);
    expect(r.endsAt.toISOString()).toBe("2031-03-03T13:20:00.000Z");
    expect(r.blockedUntil.getTime()).toBe(r.endsAt.getTime());
  });
  it("não altera a data de entrada e valida os parâmetros", () => {
    const before = start.getTime();
    computeAppointmentRange(start, 30, 5);
    expect(start.getTime()).toBe(before);
    for (const [d, b] of [
      [0, 0],
      [-1, 0],
      [1.5, 0],
      [30, -1],
      [30, 0.5],
    ] as const)
      expect(() => computeAppointmentRange(start, d, b)).toThrow(RangeError);
  });
});

describe("transições de status (função única)", () => {
  const ACTIONS: StatusAction[] = [
    "confirm",
    "complete",
    "no_show",
    "cancel",
    "reactivate",
  ];
  const VALID: Record<string, string> = {
    "SCHEDULED confirm": "CONFIRMED",
    "SCHEDULED complete": "COMPLETED",
    "SCHEDULED no_show": "NO_SHOW",
    "SCHEDULED cancel": "CANCELLED",
    "CONFIRMED complete": "COMPLETED",
    "CONFIRMED no_show": "NO_SHOW",
    "CONFIRMED cancel": "CANCELLED",
    "CANCELLED reactivate": "SCHEDULED",
  };

  it("matriz completa: só as transições da tabela são válidas (5 status × 5 ações)", () => {
    for (const from of APPOINTMENT_STATUSES)
      for (const action of ACTIONS)
        expect(nextStatus(from, action), `${from} ${action}`).toBe(
          VALID[`${from} ${action}`],
        );
  });

  it("COMPLETED e NO_SHOW são terminais; confirmar um confirmado e reativar um ativo são inválidos", () => {
    for (const from of ["COMPLETED", "NO_SHOW"] as const)
      for (const action of ACTIONS)
        expect(nextStatus(from, action)).toBeUndefined();
    expect(nextStatus("CONFIRMED", "confirm")).toBeUndefined();
    expect(nextStatus("SCHEDULED", "reactivate")).toBeUndefined();
  });

  it("somente SCHEDULED e CONFIRMED são ativos (bloqueiam horário)", () => {
    expect(APPOINTMENT_STATUSES.filter(isActive)).toEqual([
      "SCHEDULED",
      "CONFIRMED",
    ]);
  });
});

describe("hash canônico de idempotência (6.4, teste 7)", () => {
  it("ordem das chaves não muda o hash; valores diferentes mudam", () => {
    const h = (body: unknown) =>
      requestHash({ method: "POST", route: "/api/appointments", body });
    const a = h({ a: 1, b: { y: 2, x: 1 } });
    expect(a).toBe(h({ b: { x: 1, y: 2 }, a: 1 }));
    expect(a).not.toBe(h({ a: 2, b: { x: 1, y: 2 } }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("método e rota fazem parte do hash; Date vira ISO UTC; undefined vira null", () => {
    const base = {
      method: "POST",
      route: "/r",
      body: { d: new Date("2031-03-03T13:00:00Z") },
    };
    expect(requestHash(base)).not.toBe(requestHash({ ...base, method: "PUT" }));
    expect(requestHash(base)).not.toBe(requestHash({ ...base, route: "/s" }));
    expect(
      canonicalJson({ d: new Date("2031-03-03T10:00:00-03:00"), u: undefined }),
    ).toBe('{"d":"2031-03-03T13:00:00.000Z","u":null}');
  });
  it("arrays preservam a ordem; funções não são aceitas", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("fitsWorkingHours (6.2 item 3; usado por criar/remarcar e por R4)", () => {
  const SP = "America/Sao_Paulo";
  const monday = (h: [number, number]) => ({
    weekday: 1,
    startMinute: h[0] * 60,
    endMinute: h[1] * 60,
  });
  const at = (iso: string) => new Date(iso);
  const fit = (
    hours: ReturnType<typeof monday>[],
    s: string,
    e: string,
    tz = SP,
  ) => fitsWorkingHours({ startsAt: at(s), endsAt: at(e) }, tz, hours);

  it("cabe inteiro num intervalo; encostar nas bordas é permitido; ultrapassar não", () => {
    const hours = [monday([8, 12])];
    expect(fit(hours, "2031-03-03T11:00:00Z", "2031-03-03T12:00:00Z")).toBe(
      true,
    );
    expect(fit(hours, "2031-03-03T14:00:00Z", "2031-03-03T15:00:00Z")).toBe(
      true,
    );
    expect(fit(hours, "2031-03-03T14:30:00Z", "2031-03-03T15:30:00Z")).toBe(
      false,
    );
    expect(fit(hours, "2031-03-03T10:30:00Z", "2031-03-03T11:30:00Z")).toBe(
      false,
    );
  });
  it("não atravessa dois intervalos nem muda de dia da semana", () => {
    const hours = [monday([8, 12]), monday([12, 18])];
    expect(fit(hours, "2031-03-03T14:30:00Z", "2031-03-03T15:30:00Z")).toBe(
      false,
    );
    expect(fit(hours, "2031-03-04T14:00:00Z", "2031-03-04T15:00:00Z")).toBe(
      false,
    );
  });
  it("expediente até 24:00 comporta atendimento que termina na meia-noite", () => {
    const hours = [{ weekday: 1, startMinute: 22 * 60, endMinute: 1440 }];
    expect(fit(hours, "2031-03-04T01:00:00Z", "2031-03-04T02:00:00Z")).toBe(
      true,
    );
    expect(fit(hours, "2031-03-04T02:30:00Z", "2031-03-04T03:30:00Z")).toBe(
      false,
    );
  });
  it("horário de verão (Nova York, 10/03/2030): usa o relógio local e a duração real", () => {
    const NY = "America/New_York";
    const hours = [{ weekday: 0, startMinute: 0, endMinute: 360 }];
    expect(fit(hours, "2030-03-10T09:00:00Z", "2030-03-10T10:00:00Z", NY)).toBe(
      true,
    );
    expect(fit(hours, "2030-03-10T09:30:00Z", "2030-03-10T10:30:00Z", NY)).toBe(
      false,
    );
  });
});

describe("esquemas de entrada", () => {
  const uuid = "00000000-0000-7000-8000-000000000001";
  const base = {
    professionalId: uuid,
    serviceId: uuid,
    startsAt: "2031-03-03T10:00:00-03:00",
  };

  it("criação: cliente por id OU novo (nunca os dois, nunca nenhum); telefone vira E.164; e-mail minúsculo", () => {
    const ok = createAppointmentBody.safeParse({
      ...base,
      customer: {
        name: " Ana ",
        phone: "(11) 98765-4321",
        email: "ANA@Example.COM",
      },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.customer).toEqual({
        name: "Ana",
        phone: "+5511987654321",
        email: "ana@example.com",
        notes: null,
      });
      expect(ok.data.startsAt.toISOString()).toBe("2031-03-03T13:00:00.000Z");
    }
    expect(
      createAppointmentBody.safeParse({ ...base, customerId: uuid }).success,
    ).toBe(true);
    expect(createAppointmentBody.safeParse(base).success).toBe(false);
    expect(
      createAppointmentBody.safeParse({
        ...base,
        customerId: uuid,
        customer: { name: "A", phone: "11987654321" },
      }).success,
    ).toBe(false);
  });

  it("criação: campos proibidos e inválidos => rejeitados", () => {
    const customer = { name: "A", phone: "11987654321" };
    for (const extra of [
      { organizationId: uuid },
      { status: "CONFIRMED" },
      { endsAt: "2031-03-03T11:00:00-03:00" },
      { blockedUntil: "2031-03-03T11:00:00-03:00" },
      { source: "PUBLIC" },
      { createdByUserId: uuid },
      { id: uuid },
      { startsAt: "2031-03-03T10:00:00" },
      { startsAt: "amanhã" },
      { professionalId: "x" },
      { customer: { name: "", phone: "11987654321" } },
      { customer: { name: "A", phone: "123" } },
      { customer: { name: "A", phone: "11987654321", email: "não é e-mail" } },
      {
        customer: { name: "A", phone: "11987654321", notes: "x".repeat(1001) },
      },
      { customer: { ...customer, organizationId: uuid } },
    ])
      expect(
        createAppointmentBody.safeParse({ ...base, customer, ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
  });

  it("remarcar/cancelar exigem version >= 1 inteira; remarcar aceita profissional opcional", () => {
    const s = "2031-03-03T10:00:00-03:00";
    expect(rescheduleBody.safeParse({ startsAt: s, version: 1 }).success).toBe(
      true,
    );
    expect(
      rescheduleBody.safeParse({
        startsAt: s,
        version: 1,
        professionalId: uuid,
      }).success,
    ).toBe(true);
    for (const version of [0, -1, 1.5, "1", undefined])
      expect(rescheduleBody.safeParse({ startsAt: s, version }).success).toBe(
        false,
      );
    expect(
      cancelBody.safeParse({ version: 2, reason: "  desistiu " }).data,
    ).toEqual({
      version: 2,
      reason: "desistiu",
    });
    expect(
      cancelBody.safeParse({ version: 2, reason: "" }).data?.reason,
    ).toBeNull();
    expect(
      cancelBody.safeParse({ version: 2, reason: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      cancelBody.safeParse({ version: 2, status: "CANCELLED" }).success,
    ).toBe(false);
  });

  it("listagem: intervalo obrigatório, fim > início e no máximo 93 dias", () => {
    const q = (from: string, to: string, extra = {}) =>
      listAppointmentsQuery.safeParse({ from, to, ...extra });
    expect(q("2031-03-01T00:00:00Z", "2031-03-08T00:00:00Z").success).toBe(
      true,
    );
    expect(q("2031-03-08T00:00:00Z", "2031-03-01T00:00:00Z").success).toBe(
      false,
    );
    expect(q("2031-03-01T00:00:00Z", "2031-03-01T00:00:00Z").success).toBe(
      false,
    );
    expect(q("2031-01-01T00:00:00Z", "2031-06-01T00:00:00Z").success).toBe(
      false,
    );
    expect(
      q("2031-03-01T00:00:00Z", "2031-03-08T00:00:00Z", { status: "X" })
        .success,
    ).toBe(false);
    expect(
      q("2031-03-01T00:00:00Z", "2031-03-08T00:00:00Z", { organizationId: "x" })
        .success,
    ).toBe(false);
  });
});
