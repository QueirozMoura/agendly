// TRUST_PROXY: o IP usado nos rate limits não pode ser forjado pelo cliente com X-Forwarded-For.
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { toFastifyTrustProxy } from "../../src/app.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const PROXY = "10.0.0.7"; // o proxy confiável (endereço da conexão com a API)

async function ipSeenBy(
  trustProxy: number | string[] | undefined,
  xff: string,
  remoteAddress = PROXY,
): Promise<string> {
  const app = Fastify({ trustProxy: toFastifyTrustProxy(trustProxy) });
  app.get("/__ip", async (r) => r.ip);
  try {
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress,
      headers: { "x-forwarded-for": xff },
    });
    return res.body;
  } finally {
    await app.close();
  }
}

describe("toFastifyTrustProxy", () => {
  it("número vira função que confia só nos N primeiros saltos; o resto passa direto", () => {
    const fn = toFastifyTrustProxy(2) as (a: string, hop: number) => boolean;
    expect([fn("x", 0), fn("x", 1), fn("x", 2)]).toEqual([true, true, false]);
    expect(toFastifyTrustProxy(undefined)).toBe(false);
    expect(toFastifyTrustProxy(["10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
  });
});

describe("req.ip com X-Forwarded-For forjado", () => {
  it("sem proxy confiável o cabeçalho é ignorado: vale o IP da conexão", async () => {
    expect(await ipSeenBy(undefined, "6.6.6.6", "203.0.113.9")).toBe(
      "203.0.113.9",
    );
  });

  it("com 1 proxy confiável vale a entrada da DIREITA (a que o proxy anexou); a forjada à esquerda é ignorada", async () => {
    expect(await ipSeenBy(1, "6.6.6.6, 198.51.100.4")).toBe("198.51.100.4");
  });

  it("lista de proxies: a conexão só é confiável se vier de um deles", async () => {
    expect(await ipSeenBy(["10.0.0.0/8"], "6.6.6.6, 198.51.100.4")).toBe(
      "198.51.100.4",
    );
    // a conexão NÃO vem de um proxy listado: o cabeçalho inteiro é ignorado
    expect(await ipSeenBy(["10.0.0.0/8"], "198.51.100.4", "203.0.113.9")).toBe(
      "203.0.113.9",
    );
  });
});

describe("rate limit não é contornado trocando o X-Forwarded-For", () => {
  it("o 11º pedido do mesmo IP real recebe 429, mesmo com um IP forjado diferente a cada tentativa", async () => {
    await resetUsers();
    t = await makeAuthApp({ trustProxy: 1 });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/auth/forgot-password",
        remoteAddress: PROXY,
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
          // o cliente tenta fingir ser outro IP a cada tentativa; o proxy anexa o IP real (198.51.100.4)
          "x-forwarded-for": `9.9.9.${i}, 198.51.100.4`,
        },
        payload: JSON.stringify({ email: `pessoa${i}@example.com` }),
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
