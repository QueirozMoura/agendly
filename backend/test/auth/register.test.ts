import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASSWORD,
  makeAuthApp,
  post,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp;
// Uma instância por teste: os limitadores de taxa (em memória) começam zerados.
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const valid = {
  email: "Ana@Example.com",
  name: "  Ana Silva ",
  password: PASSWORD,
};

describe("POST /api/auth/register", () => {
  it("cadastro válido => 202, usuário criado com e-mail normalizado e senha só em Argon2id", async () => {
    const res = await post(t, "/api/auth/register", valid);
    expect(res.statusCode).toBe(202);
    expect(res.json().message).toBeTypeOf("string");
    expect(res.headers["set-cookie"]).toBeUndefined(); // nenhuma sessão no cadastro

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: "ana@example.com" },
    });
    expect(user.name).toBe("Ana Silva");
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.credentialsVersion).toBe(0);
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it("e-mail já cadastrado => resposta IDÊNTICA (status, corpo, cabeçalhos) e nada é alterado", async () => {
    const first = await post(t, "/api/auth/register", valid);
    const before = await t.prisma.user.findUniqueOrThrow({
      where: { email: "ana@example.com" },
    });
    const second = await post(t, "/api/auth/register", {
      ...valid,
      name: "Outra Pessoa",
      password: "outra-senha-bem-longa-7Z",
    });
    const strip = (r: typeof first) => ({
      status: r.statusCode,
      body: r.json(),
      headers: {
        ...r.headers,
        date: undefined,
        "x-request-id": undefined,
        "content-length": undefined,
      },
    });
    expect(strip(second)).toEqual(strip(first));

    const after = await t.prisma.user.findUniqueOrThrow({
      where: { email: "ana@example.com" },
    });
    expect(after).toEqual(before); // nome, hash e versão intactos
    expect(await t.prisma.user.count()).toBe(1);
  });

  it("cadastros simultâneos do mesmo e-mail => todos 202 e uma única conta", async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => post(t, "/api/auth/register", valid)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it("entradas inválidas => 400 VALIDATION_ERROR com detalhes por campo", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["e-mail inválido", { ...valid, email: "nao-e-email" }, "email"],
      ["e-mail ausente", { name: "A", password: PASSWORD }, "email"],
      ["senha curta", { ...valid, password: "curta-9ch" }, "password"],
      [
        "senha longa demais",
        { ...valid, password: "a".repeat(129) },
        "password",
      ],
      ["senha comum", { ...valid, password: "password123" }, "password"],
      [
        "senha comum com outra caixa",
        { ...valid, password: "PassWord123" },
        "password",
      ],
      [
        "e-mail com caracteres não ASCII",
        { ...valid, email: "ána@exemplo.com" },
        "email",
      ],
      ["nome vazio", { ...valid, name: "   " }, "name"],
      ["senha não é texto", { ...valid, password: 1234567890 }, "password"],
    ];
    for (const [label, body, field] of cases) {
      const res = await post(t, "/api/auth/register", body);
      expect(res.statusCode, label).toBe(400);
      const err = res.json().error;
      expect(err.code, label).toBe("VALIDATION_ERROR");
      expect(
        err.details.some((d: { path: string }) => d.path === field),
        label,
      ).toBe(true);
    }
    expect(await t.prisma.user.count()).toBe(0);
  });

  it("corpo acima do limite (16 KiB) => 413 sem processar", async () => {
    const res = await post(t, "/api/auth/register", {
      ...valid,
      name: "x".repeat(20_000),
    });
    expect(res.statusCode).toBe(413);
    expect(await t.prisma.user.count()).toBe(0);
  });

  it("campos desconhecidos são rejeitados (strict), inclusive tentativas de definir flags", async () => {
    const res = await post(t, "/api/auth/register", {
      ...valid,
      emailVerifiedAt: "2020-01-01",
    });
    expect(res.statusCode).toBe(400);
    expect(await t.prisma.user.count()).toBe(0);
  });

  it("corpo vazio ou JSON malformado => 400, sem vazar detalhes internos", async () => {
    for (const body of ["", "{oops", "[]", "null"]) {
      const res = await post(t, "/api/auth/register", body);
      expect(res.statusCode, body).toBe(400);
      expect(JSON.stringify(res.json())).not.toMatch(
        /prisma|stack|node_modules/i,
      );
    }
  });

  it("limite por e-mail: a 4ª tentativa na janela => 429 com Retry-After", async () => {
    const body = { ...valid, email: "limite@example.com" };
    for (let i = 0; i < 3; i++) {
      expect((await post(t, "/api/auth/register", body)).statusCode).toBe(202);
    }
    const res = await post(t, "/api/auth/register", body);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});
