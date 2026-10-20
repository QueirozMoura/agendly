import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/config/env.ts";

const KEY_B64 = Buffer.alloc(32, 5).toString("base64");
const PROD_KEYS = {
  OUTBOX_ENCRYPTION_KEYS: `k1:${KEY_B64}`,
  OUTBOX_CURRENT_KEY_ID: "k1",
};
// Valor fictício só para exercitar o formato; montado em partes para não
// parecer uma credencial real a scanners de segredos.
const FORMAT_ONLY_KEY = `re_${"chave_ficticia"}_${"de_teste_formato"}`;
const PROD_EMAIL = {
  RESEND_API_KEY: "re_chave_de_teste_nao_real",
  EMAIL_FROM: "Agendly <no-reply@example.com>",
};
const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  NODE_ENV: "development",
};

describe("REQUIRE_EMAIL_VERIFICATION", () => {
  it("padrão: exigido em TODOS os ambientes (desenvolvimento, teste e produção)", () => {
    expect(loadEnv(valid).REQUIRE_EMAIL_VERIFICATION).toBe(true);
    expect(
      loadEnv({ ...valid, NODE_ENV: "test" }).REQUIRE_EMAIL_VERIFICATION,
    ).toBe(true);
    expect(
      loadEnv({
        ...valid,
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://app.example.com",
        TRUST_PROXY: "false",
        ...PROD_KEYS,
        ...PROD_EMAIL,
      }).REQUIRE_EMAIL_VERIFICATION,
    ).toBe(true);
  });

  it("só um `false` explícito fora de produção dispensa; qualquer outro valor é recusado ou exige", () => {
    expect(
      loadEnv({ ...valid, REQUIRE_EMAIL_VERIFICATION: "false" })
        .REQUIRE_EMAIL_VERIFICATION,
    ).toBe(false);
    for (const bad of ["", "FALSE", "0", "no", " false"]) {
      expect(() =>
        loadEnv({ ...valid, REQUIRE_EMAIL_VERIFICATION: bad }),
      ).toThrow(EnvError);
    }
  });

  it("pode ser exigido explicitamente fora de produção; valor inválido é recusado", () => {
    expect(
      loadEnv({ ...valid, REQUIRE_EMAIL_VERIFICATION: "true" })
        .REQUIRE_EMAIL_VERIFICATION,
    ).toBe(true);
    expect(() =>
      loadEnv({ ...valid, REQUIRE_EMAIL_VERIFICATION: "talvez" }),
    ).toThrow(EnvError);
  });

  it("em produção, desligar a verificação é recusado", () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://app.example.com",
        ...PROD_KEYS,
        ...PROD_EMAIL,
        TRUST_PROXY: "false",
        REQUIRE_EMAIL_VERIFICATION: "false",
      }),
    ).toThrow(/REQUIRE_EMAIL_VERIFICATION/);
  });
});

describe("HTTPS em produção (ALLOWED_ORIGINS e APP_BASE_URL)", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    TRUST_PROXY: "false",
    ...PROD_KEYS,
    ...PROD_EMAIL,
  };

  it("produção recusa origem ou URL pública em HTTP, inclusive localhost e misturas", () => {
    for (const origins of [
      "http://app.exemplo.com",
      "http://localhost:5173",
      "https://app.exemplo.com,http://localhost:5173",
    ])
      expect(
        () => loadEnv({ ...prod, ALLOWED_ORIGINS: origins }),
        origins,
      ).toThrow(/ALLOWED_ORIGINS/);
    expect(() =>
      loadEnv({
        ...prod,
        ALLOWED_ORIGINS: "https://app.exemplo.com",
        APP_BASE_URL: "http://app.exemplo.com",
      }),
    ).toThrow(/APP_BASE_URL/);
  });

  it("produção com HTTPS passa e os links usam a base HTTPS", () => {
    const env = loadEnv({
      ...prod,
      ALLOWED_ORIGINS: "https://app.exemplo.com",
    });
    expect(env.APP_BASE_URL).toBe("https://app.exemplo.com");
    expect(
      loadEnv({
        ...prod,
        ALLOWED_ORIGINS: "https://app.exemplo.com",
        APP_BASE_URL: "https://links.exemplo.com/",
      }).APP_BASE_URL,
    ).toBe("https://links.exemplo.com");
  });

  it("desenvolvimento e teste continuam aceitando HTTP local", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const env = loadEnv({
        ...valid,
        NODE_ENV,
        ALLOWED_ORIGINS: "http://localhost:5173",
        APP_BASE_URL: "http://localhost:5173",
      });
      expect(env.APP_BASE_URL).toBe("http://localhost:5173");
    }
  });
});

describe("provedor de e-mail (RESEND_API_KEY + EMAIL_FROM)", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://a.com",
    TRUST_PROXY: "false",
    ...PROD_KEYS,
  };

  it("em produção os dois são obrigatórios; a mensagem lista só nomes", () => {
    expect(() => loadEnv(prod)).toThrow(/RESEND_API_KEY, EMAIL_FROM/);
    for (const half of [
      { RESEND_API_KEY: PROD_EMAIL.RESEND_API_KEY },
      { EMAIL_FROM: PROD_EMAIL.EMAIL_FROM },
    ]) {
      let message = "";
      try {
        loadEnv({ ...prod, ...half });
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toMatch(/RESEND_API_KEY/);
      expect(message).not.toContain(PROD_EMAIL.RESEND_API_KEY);
    }
    expect(loadEnv({ ...prod, ...PROD_EMAIL }).EMAIL_PROVIDER).toEqual({
      apiKey: PROD_EMAIL.RESEND_API_KEY,
      from: PROD_EMAIL.EMAIL_FROM,
    });
  });

  it("branco, remetente sem @ ou com quebra de linha são recusados", () => {
    for (const bad of [
      { RESEND_API_KEY: "   ", EMAIL_FROM: PROD_EMAIL.EMAIL_FROM },
      { ...PROD_EMAIL, EMAIL_FROM: "sem-arroba" },
      { ...PROD_EMAIL, EMAIL_FROM: "a@b.com\nBcc: x@y.com" },
    ]) {
      expect(() => loadEnv({ ...prod, ...bad })).toThrow(EnvError);
    }
  });

  it("EMAIL_FROM: aceita endereço simples e `Nome <endereço>`; recusa valores obviamente inválidos", () => {
    for (const ok of [
      "no-reply@example.com",
      "Agendly <no-reply@example.com>",
      "Salão Ana & Cia <contato@mail.exemplo.com.br>",
      "a.b+tag@sub.example.co",
    ])
      expect(
        loadEnv({ ...prod, ...PROD_EMAIL, EMAIL_FROM: ok }).EMAIL_PROVIDER
          ?.from,
        ok,
      ).toBe(ok);
    for (const bad of [
      "x@",
      "@example.com",
      "x@y",
      "x@y.c",
      "x@@example.com",
      "x y@example.com",
      ".x@example.com",
      "x..y@example.com",
      "x@-example.com",
      "x@example..com",
      "<no-reply@example.com>",
      "Agendly <>",
      "Agendly <x@>",
      "Agendly no-reply@example.com",
      'Ag"endly <no-reply@example.com>',
      "Agendly <no-reply@example.com> extra",
      "a@example.com, b@example.com",
      "a@b.com\nBcc: x@y.com",
    ])
      expect(
        () => loadEnv({ ...prod, ...PROD_EMAIL, EMAIL_FROM: bad }),
        JSON.stringify(bad),
      ).toThrow(/EMAIL_FROM/);
  });

  it("RESEND_API_KEY: exige o formato re_… (só o formato; não prova que a chave é válida); o valor nunca vai na mensagem", () => {
    for (const bad of [
      "chave-sem-prefixo-0123456789",
      "re_curta",
      "re_com espaço 0123456789abcdef",
      '"re_0123456789abcdef0123"',
      "RE_0123456789abcdef0123",
    ]) {
      let message = "";
      try {
        loadEnv({ ...prod, ...PROD_EMAIL, RESEND_API_KEY: bad });
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message, JSON.stringify(bad)).toMatch(/RESEND_API_KEY/);
      expect(message).not.toContain(bad.trim());
    }
    expect(
      loadEnv({
        ...prod,
        ...PROD_EMAIL,
        RESEND_API_KEY: FORMAT_ONLY_KEY,
      }).EMAIL_PROVIDER?.apiKey,
    ).toBe(FORMAT_ONLY_KEY);
    // fora de produção também: configuração malformada não vira envio falho em silêncio
    expect(() =>
      loadEnv({
        ...valid,
        RESEND_API_KEY: "lixo",
        EMAIL_FROM: PROD_EMAIL.EMAIL_FROM,
      }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it("fora de produção: nenhum => console; os dois => provedor; só um => erro", () => {
    expect(loadEnv(valid).EMAIL_PROVIDER).toBeUndefined();
    expect(loadEnv({ ...valid, ...PROD_EMAIL }).EMAIL_PROVIDER).toBeDefined();
    expect(() =>
      loadEnv({ ...valid, RESEND_API_KEY: PROD_EMAIL.RESEND_API_KEY }),
    ).toThrow(/EMAIL_FROM/);
  });
});

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
      TRUST_PROXY: "1",
    });
    expect(env.ALLOWED_ORIGINS).toEqual([
      "https://app.exemplo.com",
      "http://localhost:5173",
    ]);
    expect(env.TRUST_PROXY).toBe(1);
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
        ...PROD_EMAIL,
        ALLOWED_ORIGINS: "https://a.com",
        TRUST_PROXY: "false",
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

describe("NODE_ENV obrigatório (configuração segura por padrão)", () => {
  const withoutNodeEnv = { DATABASE_URL: valid.DATABASE_URL };

  it("ausente, vazio ou fora de development/test/production: a inicialização falha, sem assumir um ambiente", () => {
    expect(() => loadEnv(withoutNodeEnv)).toThrow(EnvError);
    expect(() => loadEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
    for (const bad of ["", "prod", "Production", "staging"]) {
      expect(() => loadEnv({ ...withoutNodeEnv, NODE_ENV: bad })).toThrow(
        /NODE_ENV/,
      );
    }
  });

  it("os três valores válidos são aceitos", () => {
    for (const ok of ["development", "test"] as const)
      expect(loadEnv({ ...withoutNodeEnv, NODE_ENV: ok }).NODE_ENV).toBe(ok);
  });
});

describe("TRUST_PROXY (rate limit não pode ser contornado com X-Forwarded-For)", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://a.com",
    ...PROD_KEYS,
    ...PROD_EMAIL,
  };

  it("fora de produção o padrão é nenhum proxy", () => {
    expect(loadEnv(valid).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...valid, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });

  it("em produção a variável é obrigatória (esquecê-la atrás de um proxy dividiria o IP do proxy entre todos)", () => {
    expect(() => loadEnv(prod)).toThrow(/TRUST_PROXY/);
    expect(loadEnv({ ...prod, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...prod, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
  });

  it("aceita número de saltos (1–10) e listas de IPs/CIDRs", () => {
    expect(loadEnv({ ...valid, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(
      loadEnv({ ...valid, TRUST_PROXY: "127.0.0.1, 10.0.0.0/8, ::1, fd00::/8" })
        .TRUST_PROXY,
    ).toEqual(["127.0.0.1", "10.0.0.0/8", "::1", "fd00::/8"]);
  });

  it("recusa 'true' (confiar em qualquer X-Forwarded-For), zero, excesso de saltos e listas malformadas", () => {
    for (const bad of [
      "true",
      "0",
      "11",
      "-1",
      "1.5",
      "10.0.0.0/33",
      "10.0.0.0/8/8",
      "nao-e-ip",
      "127.0.0.1,",
      "::/129",
    ])
      expect(() => loadEnv({ ...valid, TRUST_PROXY: bad }), bad).toThrow(
        /TRUST_PROXY/,
      );
  });
});

describe("O10 — chave de cifragem da outbox", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://a.com",
    TRUST_PROXY: "false",
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
      ...PROD_EMAIL,
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
