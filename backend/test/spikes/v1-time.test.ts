// V1 — date-fns-tz: compatibilidade com date-fns 4 e comportamento de IANA/DST.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TimeZoneError,
  isValidTimeZone,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "../../src/lib/time/zone.ts";

const pkg = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../node_modules/${name}/package.json`, import.meta.url),
      "utf8",
    ),
  );

describe("V1 date-fns-tz", () => {
  it("versões instaladas satisfazem o peer dependency declarado", () => {
    expect(pkg("date-fns-tz").peerDependencies["date-fns"]).toBe(
      "^3.0.0 || ^4.0.0",
    );
    expect(pkg("date-fns").version.startsWith("4.")).toBe(true);
  });

  it("America/Sao_Paulo: UTC-3 sem horário de verão atual", () => {
    expect(
      zonedLocalToUtc("2026-10-19T09:00:00", "America/Sao_Paulo").toISOString(),
    ).toBe("2026-10-19T12:00:00.000Z");
    expect(
      utcToZonedLocal(new Date("2026-10-19T12:00:00Z"), "America/Sao_Paulo"),
    ).toBe("2026-10-19T09:00:00");
  });

  it("usa o histórico de DST da base IANA (São Paulo em janeiro de 2018 era UTC-2)", () => {
    expect(
      zonedLocalToUtc("2018-01-10T09:00:00", "America/Sao_Paulo").toISOString(),
    ).toBe("2018-01-10T11:00:00.000Z");
  });

  it("ida e volta preserva o horário local fora de transições (América do Norte, com DST)", () => {
    for (const local of ["2026-01-15T10:15:00", "2026-07-15T10:15:00"]) {
      const utc = zonedLocalToUtc(local, "America/New_York");
      expect(utcToZonedLocal(utc, "America/New_York")).toBe(local);
    }
    expect(
      zonedLocalToUtc("2026-07-15T10:15:00", "America/New_York").toISOString(),
    ).toBe("2026-07-15T14:15:00.000Z");
  });

  it("horário inexistente (lacuna do DST) é rejeitado pelo wrapper", () => {
    expect(() =>
      zonedLocalToUtc("2026-03-08T02:30:00", "America/New_York"),
    ).toThrow(TimeZoneError);
    expect(() =>
      zonedLocalToUtc("2018-11-04T00:30:00", "America/Sao_Paulo"),
    ).toThrow(TimeZoneError);
  });

  it("horário ambíguo (volta do DST) resolve para a primeira ocorrência", () => {
    expect(
      zonedLocalToUtc("2026-11-01T01:30:00", "America/New_York").toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z"); // EDT (UTC-4); a segunda ocorrência seria 06:30Z (EST)
  });

  it("fuso inválido é rejeitado (date-fns-tz sozinha devolveria Invalid Date)", () => {
    expect(isValidTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(() => zonedLocalToUtc("2026-01-01T10:00:00", "Mars/Phobos")).toThrow(
      TimeZoneError,
    );
  });
});
