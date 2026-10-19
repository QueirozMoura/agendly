import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/config/env.ts";

const valid = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("loadEnv", () => {
  it("aplica padrões e aceita ambiente válido", () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejeita DATABASE_URL ausente", () => {
    expect(() => loadEnv({})).toThrow(EnvError);
  });

  it("rejeita PORT inválida sem vazar valores na mensagem", () => {
    const run = () => loadEnv({ ...valid, PORT: "abc-segredo" });
    expect(run).toThrow(/PORT/);
    expect(run).not.toThrow(/segredo/);
  });
});

describe("server.ts com ambiente inválido", () => {
  it("encerra com código 1 e não sobe", () => {
    const r = spawnSync(process.execPath, ["src/server.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: "0",
        DATABASE_URL: "nao-e-url",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
    expect(r.stderr).not.toContain("nao-e-url");
  });
});
