import { describe, expect, it } from "vitest";
import {
  collectSecrets,
  sanitizeError,
  sanitizeText,
} from "../src/lib/logger.ts";

const URL_WITH_PASSWORD =
  "postgresql://agendly:s3nh4-Muito+Secreta@db.local:5432/agendly";

describe("sanitizeText", () => {
  it("remove usuário e senha de URLs", () => {
    const out = sanitizeText(`falha em ${URL_WITH_PASSWORD}`);
    expect(out).not.toContain("s3nh4");
    expect(out).toContain("db.local:5432/agendly");
  });

  it("remove password=, token: e Bearer", () => {
    const out = sanitizeText("password=abc123 token: xyz789 Bearer eyJhbGci");
    expect(out).not.toMatch(/abc123|xyz789|eyJhbGci/);
  });

  it("remove segredos conhecidos mesmo fora de qualquer padrão", () => {
    const secrets = collectSecrets({ DATABASE_URL: URL_WITH_PASSWORD });
    expect(
      sanitizeText("senha inválida: s3nh4-Muito+Secreta", secrets),
    ).not.toContain("s3nh4");
  });
});

describe("sanitizeError", () => {
  it("preserva tipo, code e mensagem operacional", () => {
    const err = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      {
        code: "ECONNREFUSED",
        errno: -111,
        syscall: "connect",
      },
    );
    expect(sanitizeError(err)).toMatchObject({
      type: "Error",
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      message: "connect ECONNREFUSED 127.0.0.1:5432",
    });
  });

  it("descarta propriedades arbitrárias (detail, connectionString)", () => {
    const err = Object.assign(new Error("falhou"), {
      detail: "Key (email)=(pessoa@exemplo.com) already exists",
      connectionString: URL_WITH_PASSWORD,
    });
    const json = JSON.stringify(sanitizeError(err));
    expect(json).not.toMatch(/pessoa@exemplo|s3nh4|connectionString/);
  });

  it("sanitiza stack, cause e AggregateError", () => {
    const inner = new Error(`erro em ${URL_WITH_PASSWORD}`);
    const err = new Error("externo", { cause: inner });
    const agg = new AggregateError([new Error("password=zzz999")], "agregado");
    const json = JSON.stringify([sanitizeError(err), sanitizeError(agg)]);
    expect(json).not.toMatch(/s3nh4|zzz999/);
    expect(json).toContain("externo");
  });

  it("trata valores lançados que não são Error", () => {
    expect(JSON.stringify(sanitizeError(`token=segredo1`))).not.toContain(
      "segredo1",
    );
    expect(
      JSON.stringify(sanitizeError({ password: "segredo2" })),
    ).not.toContain("segredo2");
  });
});
