// Utilitários de data/hora na timezone da empresa e de dinheiro (unitários).
import { describe, expect, it } from "vitest";
import { centsToInput, formatCents, parseReaisToCents } from "../lib/money";
import {
  formatDateTime,
  timeOptions,
  utcIsoToZonedLocal,
  zonedLocalToUtcIso,
} from "../lib/time";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";

describe("zonedLocalToUtcIso", () => {
  it("converte hora local da empresa para UTC (São Paulo é UTC-3, sem horário de verão)", () => {
    expect(zonedLocalToUtcIso("2031-03-03T10:00", SP)).toBe(
      "2031-03-03T13:00:00.000Z",
    );
    expect(zonedLocalToUtcIso("2031-12-25T00:00", SP)).toBe(
      "2031-12-25T03:00:00.000Z",
    );
    expect(zonedLocalToUtcIso("2031-03-03T23:45", SP)).toBe(
      "2031-03-04T02:45:00.000Z",
    );
  });

  it("respeita o horário de verão (Nova York, 10/03/2030 e 03/11/2030)", () => {
    expect(zonedLocalToUtcIso("2030-03-09T12:00", NY)).toBe(
      "2030-03-09T17:00:00.000Z",
    ); // EST (-5)
    expect(zonedLocalToUtcIso("2030-03-11T12:00", NY)).toBe(
      "2030-03-11T16:00:00.000Z",
    ); // EDT (-4)
    expect(zonedLocalToUtcIso("2030-11-03T12:00", NY)).toBe(
      "2030-11-03T17:00:00.000Z",
    ); // EDT ainda? 03/11 12:00 já é EST
  });

  it("horário inexistente (lacuna do avanço) é recusado; ambíguo (recuo) usa a primeira ocorrência", () => {
    expect(zonedLocalToUtcIso("2030-03-10T02:30", NY)).toBeNull();
    expect(zonedLocalToUtcIso("2030-03-10T03:00", NY)).toBe(
      "2030-03-10T07:00:00.000Z",
    );
    expect(zonedLocalToUtcIso("2030-11-03T01:30", NY)).toBe(
      "2030-11-03T05:30:00.000Z",
    ); // 1ª ocorrência (EDT)
  });

  it("recusa formato e datas inválidas", () => {
    for (const bad of [
      "",
      "2031-03-03",
      "2031-03-03 10:00",
      "2031-02-30T10:00",
      "2031-13-01T10:00",
      "2031-03-03T24:00",
      "2031-03-03T10:60",
      "abc",
    ])
      expect(zonedLocalToUtcIso(bad, SP), bad).toBeNull();
  });

  it("ida e volta: utcIsoToZonedLocal desfaz a conversão", () => {
    for (const local of [
      "2031-03-03T10:00",
      "2031-06-15T00:15",
      "2031-12-31T23:45",
    ]) {
      const iso = zonedLocalToUtcIso(local, SP) as string;
      expect(utcIsoToZonedLocal(iso, SP)).toBe(local);
    }
    expect(utcIsoToZonedLocal("2030-03-10T07:00:00.000Z", NY)).toBe(
      "2030-03-10T03:00",
    );
  });
});

describe("formatação", () => {
  it("formatDateTime mostra dia da semana, data e hora na timezone da empresa (pt-BR)", () => {
    const text = formatDateTime("2031-03-03T13:00:00.000Z", SP);
    expect(text).toMatch(/seg/i);
    expect(text).toContain("03/03/2031");
    expect(text).toContain("10:00");
    expect(formatDateTime("2031-03-03T13:00:00.000Z", "Asia/Tokyo")).toContain(
      "22:00",
    );
  });

  it("timeOptions: início 00:00–23:45 e fim 00:15–24:00, em passos de 15 min", () => {
    const start = timeOptions("start");
    const end = timeOptions("end");
    expect([start[0], start.at(-1), start.length]).toEqual([
      "00:00",
      "23:45",
      96,
    ]);
    expect([end[0], end.at(-1), end.length]).toEqual(["00:15", "24:00", 96]);
  });
});

describe("dinheiro", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["0", 0],
    ["50", 5000],
    ["50,5", 5050],
    ["50,50", 5050],
    ["0,99", 99],
    ["1.234,56", 123456],
    ["1000000", 100000000],
  ])("parseReaisToCents(%j) = %j", (input, expected) => {
    expect(parseReaisToCents(input)).toBe(expected);
  });

  it.each([
    "abc",
    "50,555",
    "50.5",
    "-5",
    "1,234.56",
    "R$ 50",
    "5 0",
    "50,",
    ",50",
    "1.23.456",
  ])("parseReaisToCents(%j) é inválido", (input) => {
    expect(parseReaisToCents(input)).toBeUndefined();
  });

  it("formatCents e centsToInput", () => {
    expect(formatCents(5000).replace(/\s/g, " ")).toBe("R$ 50,00");
    expect(formatCents(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
    expect(centsToInput(5050)).toBe("50,50");
    expect(centsToInput(null)).toBe("");
    expect(parseReaisToCents(centsToInput(123456))).toBe(123456);
  });
});

// ── Conversão local ⇄ UTC: regras de borda e verificação contra um "oráculo" de força bruta ──
describe("zonedLocalToUtcIso — horário de verão e fusos exóticos", () => {
  const cases: Array<[string, string, string, string | null]> = [
    // [descrição, timezone, hora local, UTC esperado (null = inexistente ⇒ recusado)]
    [
      "São Paulo, início do horário de verão à meia-noite (04/11/2018): 00:00–00:59 não existem",
      "America/Sao_Paulo",
      "2018-11-04T00:30",
      null,
    ],
    [
      "São Paulo, 1º horário depois da lacuna",
      "America/Sao_Paulo",
      "2018-11-04T01:00",
      "2018-11-04T03:00:00.000Z",
    ],
    [
      "São Paulo, fim do horário de verão (17/02/2019): 23:30 do dia 16 ocorre DUAS vezes; vale a 1ª (-02:00)",
      "America/Sao_Paulo",
      "2019-02-16T23:30",
      "2019-02-17T01:30:00.000Z",
    ],
    [
      "Nova York, avanço: 02:30 não existe",
      "America/New_York",
      "2030-03-10T02:30",
      null,
    ],
    [
      "Nova York, recuo: 01:30 ocorre duas vezes; vale a 1ª (EDT, -04:00)",
      "America/New_York",
      "2030-11-03T01:30",
      "2030-11-03T05:30:00.000Z",
    ],
    [
      "Nova York, depois do recuo (02:00 já é EST)",
      "America/New_York",
      "2030-11-03T02:00",
      "2030-11-03T07:00:00.000Z",
    ],
    [
      "Nova York, 00:00 do dia do recuo existe (EDT)",
      "America/New_York",
      "2030-11-03T00:00",
      "2030-11-03T04:00:00.000Z",
    ],
    [
      "Lord Howe (+11 ⇄ +10:30; passo de 30 min): ambíguo 01:45 no recuo (vale a 2ª, compatível com o backend)",
      "Australia/Lord_Howe",
      "2030-04-07T01:45",
      "2030-04-06T15:15:00.000Z",
    ],
    [
      "Lord Howe: 02:15 não existe no avanço (02:00 → 02:30)",
      "Australia/Lord_Howe",
      "2030-10-06T02:15",
      null,
    ],
    [
      "Sydney, recuo: 02:30 ocorre duas vezes; vale a 2ª (+10, compatível com o backend)",
      "Australia/Sydney",
      "2030-04-07T02:30",
      "2030-04-06T16:30:00.000Z",
    ],
    [
      "Sydney, avanço: 02:30 não existe",
      "Australia/Sydney",
      "2030-10-06T02:30",
      null,
    ],
    [
      "Kathmandu (+05:45, sem horário de verão)",
      "Asia/Kathmandu",
      "2031-03-03T10:00",
      "2031-03-03T04:15:00.000Z",
    ],
    [
      "Kolkata (+05:30)",
      "Asia/Kolkata",
      "2031-03-03T00:00",
      "2031-03-02T18:30:00.000Z",
    ],
    [
      "Londres, verão (+01:00) e inverno",
      "Europe/London",
      "2031-07-01T12:00",
      "2031-07-01T11:00:00.000Z",
    ],
    ["UTC", "UTC", "2031-03-03T10:00", "2031-03-03T10:00:00.000Z"],
  ];
  it.each(cases)("%s", (_d, tz, local, expected) => {
    expect(zonedLocalToUtcIso(local, tz)).toBe(expected);
  });

  it("limites de dia, mês e ano: 00:00, 23:45, virada de ano, 29/02 em ano bissexto e inexistente em ano comum", () => {
    expect(zonedLocalToUtcIso("2031-12-31T23:45", SP)).toBe(
      "2032-01-01T02:45:00.000Z",
    );
    expect(zonedLocalToUtcIso("2031-01-01T00:00", SP)).toBe(
      "2031-01-01T03:00:00.000Z",
    );
    expect(zonedLocalToUtcIso("2028-02-29T12:00", SP)).toBe(
      "2028-02-29T15:00:00.000Z",
    );
    expect(zonedLocalToUtcIso("2031-02-29T12:00", SP)).toBeNull();
    expect(zonedLocalToUtcIso("2031-04-31T12:00", SP)).toBeNull();
  });

  it("aceita segundos do datetime-local (e os preserva); recusa segundos inválidos", () => {
    expect(zonedLocalToUtcIso("2031-03-03T10:00:30", SP)).toBe(
      "2031-03-03T13:00:30.000Z",
    );
    expect(zonedLocalToUtcIso("2031-03-03T10:00:60", SP)).toBeNull();
  });

  it("não depende da timezone do navegador: o resultado é o mesmo qualquer que seja `TZ`", () => {
    // O processo do teste pode rodar com qualquer TZ; os valores acima são fixos. Aqui só se confirma que a conversão
    // usa a timezone PEDIDA: a mesma hora local dá instantes diferentes em fusos diferentes.
    const sp = zonedLocalToUtcIso("2031-03-03T10:00", SP);
    const ny = zonedLocalToUtcIso("2031-03-03T10:00", NY);
    const tk = zonedLocalToUtcIso("2031-03-03T10:00", "Asia/Tokyo");
    expect(new Set([sp, ny, tk]).size).toBe(3);
    expect([sp, ny, tk]).toEqual([
      "2031-03-03T13:00:00.000Z",
      "2031-03-03T15:00:00.000Z",
      "2031-03-03T01:00:00.000Z",
    ]);
  });

  it("dados inesperados da API não quebram a tela: instante inválido vira texto vazio/cru", () => {
    expect(utcIsoToZonedLocal("lixo", SP)).toBe("");
    expect(formatDateTime("lixo", SP)).toBe("lixo");
  });
});

describe("zonedLocalToUtcIso × oráculo de força bruta (todos os horários de 15 em 15 min nos dias de transição)", () => {
  const ZONES = [
    "America/Sao_Paulo",
    "America/New_York",
    "America/Los_Angeles",
    "America/Havana",
    "America/Santiago",
    "America/St_Johns",
    "Europe/London",
    "Europe/Berlin",
    "Africa/Cairo",
    "Asia/Tehran",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Pacific/Chatham",
    "Pacific/Apia",
    "UTC",
  ];

  /** Coleta todos os instantes UTC válidos dentro da ampla janela de 72h (-36h a +36h da meia-noite UTC) para cada hora local. */
  function oracleDay(day: string, tz: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const start =
      Date.UTC(
        Number(day.slice(0, 4)),
        Number(day.slice(5, 7)) - 1,
        Number(day.slice(8, 10)),
      ) -
      36 * 3600_000;
    for (let t = start; t <= start + 72 * 3600_000; t += 15 * 60_000) {
      const iso = new Date(t).toISOString();
      const local = utcIsoToZonedLocal(iso, tz);
      if (local.startsWith(day)) {
        const existing = map.get(local);
        if (!existing) map.set(local, [iso]);
        else existing.push(iso);
      }
    }
    return map;
  }

  /** Dias em que o deslocamento da timezone muda (+ o dia anterior e o seguinte), mais dias de controle fixos. */
  function transitionDays(tz: string): string[] {
    const days = new Set<string>([
      "2030-01-15",
      "2030-06-15",
      "2030-11-04",
      "2018-11-04",
      "2019-02-16",
      "2019-02-17",
    ]);
    const offset = (ms: number) => {
      const iso = new Date(ms).toISOString();
      return (
        Date.parse(`${utcIsoToZonedLocal(iso, tz)}:00Z`) -
        Math.floor(ms / 60000) * 60000
      );
    };
    for (const year of [2018, 2019, 2020, 2030]) {
      for (
        let d = Date.UTC(year, 0, 1);
        d < Date.UTC(year + 1, 0, 1);
        d += 86_400_000
      )
        if (offset(d) !== offset(d + 86_400_000))
          for (const k of [-1, 0, 1])
            days.add(new Date(d + k * 86_400_000).toISOString().slice(0, 10));
    }
    return [...days];
  }

  it.each(ZONES)(
    "%s: coincide com o oráculo (inexistente ⇒ null; ambíguo ⇒ candidato válido)",
    (tz) => {
      let checked = 0;
      let nonexistent = 0;
      let ambiguous = 0;
      for (const day of transitionDays(tz)) {
        const truth = oracleDay(day, tz);
        for (let m = 0; m < 24 * 60; m += 15) {
          const local = `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          const candidates = truth.get(local) ?? [];
          const actual = zonedLocalToUtcIso(local, tz);
          if (candidates.length === 0) {
            expect(actual, `${tz} ${local} inexistente`).toBeNull();
            nonexistent++;
          } else {
            expect(candidates, `${tz} ${local} candidato`).toContain(actual);
            if (candidates.length > 1) ambiguous++;
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(96 * 3);
      if (
        tz !== "UTC" &&
        tz !== "Asia/Kolkata" &&
        tz !== "Asia/Kathmandu" &&
        tz !== "Asia/Tehran"
      ) {
        expect(
          nonexistent,
          `${tz}: nenhuma hora inexistente exercitada`,
        ).toBeGreaterThan(0);
        expect(
          ambiguous,
          `${tz}: nenhuma hora ambígua exercitada`,
        ).toBeGreaterThan(0);
      }
    },
  );
});
