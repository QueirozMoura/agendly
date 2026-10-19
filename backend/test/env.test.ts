import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/config/env.ts";

const KEY_B64 = Buffer.alloc(32, 5).toString("base64");
const PROD_KEYS = {
  OUTBOX_ENCRYPTION_KEYS: `k1:${KEY_B64}`,
  OUTBOX_CURRENT_KEY_ID: "k1",
};
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

describe("loadEnv: origens e proxy", () => {
  it("padrão de desenvolvimento: origem do Vite e TRUST_PROXY desligado", () => {
    const env = loadEnv(valid);
    expect(env.ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it("normaliza, remove duplicatas e aceita várias origens", () => {
    const env = loadEnv({
      ...valid,
      ALLOWED_ORIGINS:
        "https://app.exemplo.com/, http://localhost:5173 ,https://app.exemplo.com",
      TRUST_PROXY: "true",
    });
    expect(env.ALLOWED_ORIGINS).toEqual([
      "https://app.exemplo.com",
      "http://localhost:5173",
    ]);
    expect(env.TRUST_PROXY).toBe(true);
  });

  it("em produção ALLOWED_ORIGINS é obrigatória", () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: "production" })).toThrow(
      /ALLOWED_ORIGINS/,
    );
    expect(
      loadEnv({
        ...valid,
        ...PROD_KEYS,
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://a.com",
      }).NODE_ENV,
    ).toBe("production");
  });

  it("rejeita origem inválida, protocolo não-HTTP e TRUST_PROXY fora de true/false", () => {
    for (const bad of ["nao-e-url", "ftp://a.com", "https://a.com,xx"]) {
      expect(() => loadEnv({ ...valid, ALLOWED_ORIGINS: bad })).toThrow(
        /ALLOWED_ORIGINS/,
      );
    }
    expect(() => loadEnv({ ...valid, TRUST_PROXY: "sim" })).toThrow(
      /TRUST_PROXY/,
    );
  });
});

describe("O10 — chave de cifragem da outbox", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://a.com",
  };

  it("em produção a chave corrente é obrigatória (a API não inicia sem ela)", () => {
    expect(() => loadEnv(prod)).toThrow(/OUTBOX_ENCRYPTION_KEYS/);
    expect(() =>
      loadEnv({ ...prod, OUTBOX_ENCRYPTION_KEYS: `k1:${KEY_B64}` }),
    ).toThrow(/OUTBOX/);
    expect(() =>
      loadEnv({ ...prod, ...PROD_KEYS, OUTBOX_CURRENT_KEY_ID: "k2" }),
    ).toThrow(/OUTBOX/);
  });

  it("chave malformada (tamanho errado, base64 inválido, id duplicado) => erro sem vazar o valor", () => {
    for (const keys of [
      "k1:curta",
      `k1:${Buffer.alloc(16).toString("base64")}`,
      `k1:${KEY_B64},k1:${KEY_B64}`,
      "semdoispontos",
      `k1:${KEY_B64}:extra`,
    ]) {
      const run = () =>
        loadEnv({
          ...prod,
          OUTBOX_ENCRYPTION_KEYS: keys,
          OUTBOX_CURRENT_KEY_ID: "k1",
        });
      expect(run).toThrow(/OUTBOX_ENCRYPTION_KEYS/);
      expect(run).not.toThrow(new RegExp(KEY_B64.slice(0, 12)));
    }
  });

  it("aceita várias chaves (rotação) com uma corrente; em dev há uma chave fixa", () => {
    const k2 = Buffer.alloc(32, 6).toString("base64");
    const env = loadEnv({
      ...prod,
      OUTBOX_ENCRYPTION_KEYS: `k1:${KEY_B64},k2:${k2}`,
      OUTBOX_CURRENT_KEY_ID: "k2",
    });
    expect(env.OUTBOX_KEYRING.currentId).toBe("k2");
    expect(env.OUTBOX_KEYRING.get("k1")).toBeDefined();
    expect(loadEnv(valid).OUTBOX_KEYRING.currentId).toBe("dev");
  });

  it("APP_BASE_URL: padrão é a 1ª origem permitida; inválida é rejeitada", () => {
    expect(loadEnv(valid).APP_BASE_URL).toBe("http://localhost:5173");
    expect(
      loadEnv({ ...valid, APP_BASE_URL: "https://app.exemplo.com/x" })
        .APP_BASE_URL,
    ).toBe("https://app.exemplo.com");
    expect(() => loadEnv({ ...valid, APP_BASE_URL: "nao-url" })).toThrow(
      /APP_BASE_URL/,
    );
  });
});

describe("server.ts com ambiente inválido", () => {
  it("encerra com código 1 e não sobe", () => {
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PORT: "0",
          DATABASE_URL: "nao-e-url",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
    expect(r.stderr).not.toContain("nao-e-url");
  });
});
