// Etapa 9 — computeSlots (6.2) e conversões de fuso de lib/time: função pura, sem banco.
import { describe, expect, it } from "vitest";
import {
  computeSlots,
  SLOT_GRID_MINUTES,
  type SlotInputs,
} from "../../src/modules/availability/slots.ts";
import {
  isValidLocalDate,
  localMinuteToUtc,
  localWeekday,
  utcToZonedLocal,
} from "../../src/lib/time/zone.ts";

const SP = "America/Sao_Paulo"; // UTC-3 o ano todo
const NY = "America/New_York";
const MONDAY = 1;
const SUNDAY = 0;
const at = (iso: string) => new Date(iso);
const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const LONG_BEFORE = clockAt("2030-06-01T12:00:00Z");
const JANUARY = clockAt("2030-01-02T12:00:00Z"); // antes do avanço de março

const hm = (h: number, m = 0) => h * 60 + m;
const base = (over: Partial<SlotInputs> = {}): SlotInputs => ({
  timeZone: SP,
  date: "2030-06-10",
  durationMinutes: 60,
  bufferMinutes: 0,
  workingHours: [{ weekday: MONDAY, startMinute: hm(9), endMinute: hm(12) }],
  timeOff: [],
  appointments: [],
  ...over,
});
/** Horário local ("HH:mm") de cada slot, para asserções legíveis. */
const local = (slots: Date[], tz = SP) =>
  slots.map((s) => utcToZonedLocal(s, tz).slice(11, 16));

describe("computeSlots — grade e duração", () => {
  it("gera inícios de 15 em 15 min e exige que [t, t+d) caiba inteiro no expediente", () => {
    expect(SLOT_GRID_MINUTES).toBe(15);
    const slots = computeSlots(base(), LONG_BEFORE);
    expect(local(slots)).toEqual([
      "09:00",
      "09:15",
      "09:30",
      "09:45",
      "10:00",
      "10:15",
      "10:30",
      "10:45",
      "11:00",
    ]);
    // 09:00 local em São Paulo = 12:00 UTC
    expect(slots[0]?.toISOString()).toBe("2030-06-10T12:00:00.000Z");
  });

  it("duração fora da grade: o início segue a grade, o fim não precisa", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 20,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) },
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual(["09:00", "09:15", "09:30"]); // 09:45 terminaria 10:05
  });

  it("duração igual ao expediente => um único início; maior que o expediente => nenhum", () => {
    const hours = [{ weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) }];
    expect(
      local(
        computeSlots(
          base({ durationMinutes: 60, workingHours: hours }),
          LONG_BEFORE,
        ),
      ),
    ).toEqual(["09:00"]);
    expect(
      computeSlots(
        base({ durationMinutes: 61, workingHours: hours }),
        LONG_BEFORE,
      ),
    ).toEqual([]);
  });

  it("vários intervalos no mesmo dia: cada atendimento cabe em UM intervalo (09:45 não atravessa 10:00)", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 30,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(13), endMinute: hm(14) },
          { weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) },
          { weekday: MONDAY, startMinute: hm(10), endMinute: hm(10, 30) },
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual([
      "09:00",
      "09:15",
      "09:30",

      "10:00",
      "13:00",
      "13:15",
      "13:30",
    ]);
    expect(new Set(slots.map(Number)).size).toBe(slots.length);
  });

  it("só usa o expediente do dia da semana pedido; sem expediente => nenhum slot", () => {
    const hours = [{ weekday: 2, startMinute: hm(9), endMinute: hm(12) }];
    expect(computeSlots(base({ workingHours: hours }), LONG_BEFORE)).toEqual(
      [],
    );
    expect(computeSlots(base({ workingHours: [] }), LONG_BEFORE)).toEqual([]);
  });
});

describe("computeSlots — buffer e agendamentos (R3, 6.3)", () => {
  const appt = {
    startsAt: at("2030-06-10T13:00:00Z"), // 10:00 local
    blockedUntil: at("2030-06-10T13:40:00Z"), // 10:30 de atendimento + 10 min de buffer
  };

  it("a faixa ocupada de um agendamento é [início, blockedUntil); encostar é permitido", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 30,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(9), endMinute: hm(12) },
        ],
        appointments: [appt],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual([
      "09:00",
      "09:15",
      "09:30", // 09:30–10:00 encosta no início do agendamento
      "10:45",
      "11:00",
      "11:15",
      "11:30", // 10:30 ainda cai no buffer (até 10:40)
    ]);
  });

  it("o buffer do NOVO serviço também precisa caber antes do próximo agendamento", () => {
    const slots = computeSlots(
      base({ durationMinutes: 30, bufferMinutes: 15, appointments: [appt] }),
      LONG_BEFORE,
    );
    // 09:30 + 30 + 15 = 10:15 invade o agendamento das 10:00
    expect(local(slots)).not.toContain("09:30");
    expect(local(slots)).toContain("09:15");
    expect(local(slots)).toContain("10:45");
  });

  it("o buffer pode ultrapassar o fim do expediente (só o atendimento precisa caber)", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 30,
        bufferMinutes: 60,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) },
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("agendamento de outro dia não interfere", () => {
    const other = {
      startsAt: at("2030-06-11T13:00:00Z"),
      blockedUntil: at("2030-06-11T14:00:00Z"),
    };
    expect(
      computeSlots(base({ appointments: [other] }), LONG_BEFORE),
    ).toHaveLength(9);
  });
});

describe("computeSlots — folgas (TimeOff)", () => {
  it("remove inícios cujo [t, t+d) intersecta a folga; encostar na folga é permitido", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 30,
        timeOff: [
          {
            startsAt: at("2030-06-10T13:00:00Z"),
            endsAt: at("2030-06-10T14:00:00Z"),
          },
        ], // 10:00–11:00
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual([
      "09:00",
      "09:15",
      "09:30",
      "11:00",
      "11:15",
      "11:30",
    ]);
  });

  it("folga que cobre o dia inteiro => nenhum slot; folga em outro dia => nada muda", () => {
    expect(
      computeSlots(
        base({
          timeOff: [
            {
              startsAt: at("2030-06-10T00:00:00Z"),
              endsAt: at("2030-06-11T12:00:00Z"),
            },
          ],
        }),
        LONG_BEFORE,
      ),
    ).toEqual([]);
    expect(
      computeSlots(
        base({
          timeOff: [
            {
              startsAt: at("2030-06-12T00:00:00Z"),
              endsAt: at("2030-06-13T00:00:00Z"),
            },
          ],
        }),
        LONG_BEFORE,
      ),
    ).toHaveLength(9);
  });

  it("o buffer pode encostar/entrar na folga (R3): só [t, t+d) é conferido contra TimeOff", () => {
    const slots = computeSlots(
      base({
        durationMinutes: 30,
        bufferMinutes: 60,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) },
        ],
        timeOff: [
          {
            startsAt: at("2030-06-10T13:00:00Z"),
            endsAt: at("2030-06-10T15:00:00Z"),
          },
        ], // a partir das 10:00
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual(["09:00", "09:15", "09:30"]);
  });
});

describe("computeSlots — fuso e virada de dia", () => {
  it("o mesmo expediente local vira instantes UTC diferentes por fuso (inclusive meia hora)", () => {
    const hours = [{ weekday: MONDAY, startMinute: hm(9), endMinute: hm(10) }];
    const first = (tz: string) =>
      computeSlots(
        base({ timeZone: tz, workingHours: hours }),
        LONG_BEFORE,
      )[0]?.toISOString();
    expect(first("America/Sao_Paulo")).toBe("2030-06-10T12:00:00.000Z");
    expect(first("America/New_York")).toBe("2030-06-10T13:00:00.000Z"); // EDT
    expect(first("Asia/Kolkata")).toBe("2030-06-10T03:30:00.000Z"); // +05:30
    expect(first("Asia/Tokyo")).toBe("2030-06-10T00:00:00.000Z");
  });

  it("expediente até 24:00: o último atendimento termina na meia-noite seguinte", () => {
    const slots = computeSlots(
      base({
        workingHours: [
          { weekday: MONDAY, startMinute: hm(22), endMinute: 1440 },
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual(["22:00", "22:15", "22:30", "22:45", "23:00"]);
  });

  it("folga que atravessa a meia-noite afeta os dois dias", () => {
    const timeOff = [
      {
        startsAt: at("2030-06-11T02:30:00Z"),
        endsAt: at("2030-06-11T03:30:00Z"),
      },
    ]; // 23:30–00:30 local
    const night = computeSlots(
      base({
        timeOff,
        workingHours: [
          { weekday: MONDAY, startMinute: hm(22), endMinute: 1440 },
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(night)).toEqual(["22:00", "22:15", "22:30"]);
    const morning = computeSlots(
      base({
        date: "2030-06-11",
        timeOff,
        workingHours: [{ weekday: 2, startMinute: 0, endMinute: hm(2) }],
      }),
      LONG_BEFORE,
    );
    expect(local(morning)).toEqual(["00:30", "00:45", "01:00"]); // a folga acaba às 00:30 e o último início é 01:00
  });

  it("agendamento que atravessa a meia-noite bloqueia o início do dia seguinte", () => {
    const slots = computeSlots(
      base({
        date: "2030-06-11",
        workingHours: [{ weekday: 2, startMinute: 0, endMinute: hm(2) }],
        durationMinutes: 30,
        appointments: [
          {
            startsAt: at("2030-06-11T02:30:00Z"),
            blockedUntil: at("2030-06-11T03:40:00Z"),
          }, // até 00:40 local
        ],
      }),
      LONG_BEFORE,
    );
    expect(local(slots)).toEqual(["00:45", "01:00", "01:15", "01:30"]);
  });

  it("horário de verão (avanço, 10/03/2030 em Nova York): a hora inexistente não gera slots", () => {
    const slots = computeSlots(
      base({
        timeZone: NY,
        date: "2030-03-10",
        workingHours: [{ weekday: SUNDAY, startMinute: 0, endMinute: hm(6) }],
      }),
      JANUARY,
    );
    const times = local(slots, NY);
    expect(times).toHaveLength(17); // 5 h reais de expediente - 1 h de atendimento = 4 h => 17 inícios
    expect(times.filter((t) => t.startsWith("02:"))).toEqual([]);
    expect(times.slice(6, 10)).toEqual(["01:30", "01:45", "03:00", "03:15"]);
    expect(times.at(-1)).toBe("05:00");
  });

  it("horário de verão (recuo, 03/11/2030): a hora repetida gera slots nas duas ocorrências", () => {
    const slots = computeSlots(
      base({
        timeZone: NY,
        date: "2030-11-03",
        workingHours: [{ weekday: SUNDAY, startMinute: 0, endMinute: hm(4) }],
      }),
      LONG_BEFORE,
    );
    const times = local(slots, NY);
    expect(times).toHaveLength(17); // 5 h reais de expediente
    expect(times.filter((t) => t === "01:30")).toHaveLength(2);
    expect(new Set(slots.map(Number)).size).toBe(17);
  });

  it("expediente que começa na lacuna do horário de verão abre no primeiro horário existente", () => {
    const slots = computeSlots(
      base({
        timeZone: NY,
        date: "2030-03-10",
        durationMinutes: 30,
        workingHours: [
          { weekday: SUNDAY, startMinute: hm(2, 30), endMinute: hm(4) },
        ],
      }),
      JANUARY,
    );
    expect(local(slots, NY)).toEqual(["03:00", "03:15", "03:30"]);
  });
});

describe("computeSlots — antecedência (R7, 6.7)", () => {
  // 'agora' = 09:50 local (12:50 UTC) do dia consultado
  const now = clockAt("2030-06-10T12:50:00Z");

  it("nunca devolve o passado nem o instante exato de 'agora'", () => {
    expect(local(computeSlots(base(), now))).toEqual([
      "10:00",
      "10:15",
      "10:30",
      "10:45",
      "11:00",
    ]);
    const exact = clockAt("2030-06-10T13:00:00Z"); // agora = 10:00 exato
    expect(local(computeSlots(base(), exact))[0]).toBe("10:15");
  });

  it("antecedência mínima desloca a fronteira; dia inteiramente passado => vazio", () => {
    expect(local(computeSlots(base({ minNoticeMinutes: 60 }), now))[0]).toBe(
      "11:00",
    );
    expect(computeSlots(base(), clockAt("2030-06-11T12:00:00Z"))).toEqual([]);
  });

  it("antecedência máxima em dias limita o horizonte", () => {
    const early = clockAt("2030-06-09T12:00:00Z"); // 1 dia antes
    expect(computeSlots(base({ maxAdvanceDays: 2 }), early)).toHaveLength(9);
    // limite = 2030-06-10T13:00Z (10:00 local): só 09:00–10:00 cabe até lá
    const limited = computeSlots(
      base({ maxAdvanceDays: 1 }),
      clockAt("2030-06-09T13:00:00Z"),
    );
    expect(local(limited)).toEqual([
      "09:00",
      "09:15",
      "09:30",
      "09:45",
      "10:00",
    ]);
    expect(computeSlots(base({ maxAdvanceDays: 0 }), early)).toEqual([]);
  });
});

describe("computeSlots — pureza e validação de entrada", () => {
  it("não altera as entradas e é determinística", () => {
    const input = base({
      timeOff: [
        {
          startsAt: at("2030-06-10T13:00:00Z"),
          endsAt: at("2030-06-10T14:00:00Z"),
        },
      ],
    });
    const snapshot = structuredClone(input);
    const a = computeSlots(input, LONG_BEFORE);
    const b = computeSlots(input, LONG_BEFORE);
    expect(a).toEqual(b);
    expect(input).toEqual(snapshot);
  });

  it("rejeita dia, duração, buffer e antecedência inválidos", () => {
    for (const bad of [
      { date: "2030-02-30" },
      { date: "10/06/2030" },
      { durationMinutes: 0 },
      { durationMinutes: 1.5 },
      { bufferMinutes: -1 },
      { minNoticeMinutes: -5 },
    ])
      expect(
        () => computeSlots(base(bad), LONG_BEFORE),
        JSON.stringify(bad),
      ).toThrow(RangeError);
    expect(() =>
      computeSlots(base({ timeZone: "Marte/Olimpo" }), LONG_BEFORE),
    ).toThrow();
  });
});

describe("lib/time — helpers de calendário e fuso da Etapa 9", () => {
  it("isValidLocalDate e localWeekday", () => {
    expect(isValidLocalDate("2030-06-10")).toBe(true);
    for (const bad of ["2030-13-01", "2030-02-29", "2030-6-1", "", "x"])
      expect(isValidLocalDate(bad), bad).toBe(false);
    expect(localWeekday("2030-06-09")).toBe(0);
    expect(localWeekday("2030-06-10")).toBe(1);
    expect(localWeekday("2030-06-15")).toBe(6);
  });

  it("localMinuteToUtc: minuto 1440 é a meia-noite seguinte; lacuna avança; fuso inválido lança", () => {
    expect(localMinuteToUtc("2030-06-10", 1440, SP).toISOString()).toBe(
      "2030-06-11T03:00:00.000Z",
    );
    expect(localMinuteToUtc("2030-06-10", 0, SP).toISOString()).toBe(
      "2030-06-10T03:00:00.000Z",
    );
    // 02:30 não existe em 10/03/2030 em Nova York: vale 03:00 EDT = 07:00Z
    expect(localMinuteToUtc("2030-03-10", hm(2, 30), NY).toISOString()).toBe(
      "2030-03-10T07:00:00.000Z",
    );
    expect(() => localMinuteToUtc("2030-06-10", 0, "Marte/Olimpo")).toThrow();
  });
});
