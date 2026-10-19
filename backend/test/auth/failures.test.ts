import { afterEach, describe, expect, it } from "vitest";
import {
  PASSWORD,
  makeAuthApp,
  post,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const SECRET_DB_PASSWORD = "s3nh4-do-banco-Muito+Secreta";
const DEAD_URL = `postgresql://agendly:${SECRET_DB_PASSWORD}@127.0.0.1:1/agendly`;

describe("falhas de banco e erros inesperados", () => {
  it("banco indisponível no login => 500 genérico, sem vazar credenciais, senha ou e-mail", async () => {
    t = await makeAuthApp({ databaseUrlOverride: DEAD_URL });
    const res = await post(t, "/api/auth/login", {
      email: "ana@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
    const out = `${res.body}${t.logs()}`;
    expect(out).not.toContain(SECRET_DB_PASSWORD);
    expect(out).not.toContain(PASSWORD);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(t.logs()).toContain("unhandled error"); // o problema foi registrado para operação
  });

  it("banco indisponível no cadastro e em /api/me => 500 genérico (não confunde com e-mail existente)", async () => {
    t = await makeAuthApp({ databaseUrlOverride: DEAD_URL });
    const reg = await post(t, "/api/auth/register", {
      email: "a@example.com",
      name: "A",
      password: PASSWORD,
    });
    expect(reg.statusCode).toBe(500);
    const meRes = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `agendly_session=${"A".repeat(43)}` },
    });
    expect(meRes.statusCode).toBe(500);
    expect(`${reg.body}${meRes.body}${t.logs()}`).not.toContain(
      SECRET_DB_PASSWORD,
    );
  });

  it("exceção inesperada com conteúdo sensível na mensagem não chega ao cliente nem ao log", async () => {
    await resetUsers();
    t = await makeAuthApp();
    const original = t.prisma.user.findUnique.bind(t.prisma.user);
    void original;
    // Força uma falha com a URL do banco (credencial conhecida pelo sanitizador) na mensagem.
    t.prisma.user.findUnique = (() => {
      throw new Error(`falha em ${DEAD_URL}`);
    }) as never;
    const res = await post(t, "/api/auth/login", {
      email: "ana@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("127.0.0.1");
    expect(t.logs()).not.toContain(SECRET_DB_PASSWORD);
  });
});

describe("logs não contêm segredos em nenhum fluxo", () => {
  it("senha, token de sessão, cookie e hashes nunca aparecem nos logs", async () => {
    await resetUsers();
    t = await makeAuthApp();
    await post(t, "/api/auth/register", {
      email: "ana@example.com",
      name: "Ana",
      password: PASSWORD,
    });
    const login = await post(t, "/api/auth/login", {
      email: "ana@example.com",
      password: PASSWORD,
    });
    const token = login.cookies[0]?.value as string;
    await post(t, "/api/auth/login", {
      email: "ana@example.com",
      password: "errada-errada-1",
    });
    await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `agendly_session=${token}` },
    });
    await post(
      t,
      "/api/auth/logout",
      {},
      { cookie: `agendly_session=${token}` },
    );
    await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `agendly_session=${token}` },
    });

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: "ana@example.com" },
    });
    const session = await t.prisma.session.findFirstOrThrow();
    const logs = t.logs();
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      PASSWORD,
      "errada-errada-1",
      token,
      user.passwordHash,
      session.tokenHash,
    ]) {
      expect(logs, secret.slice(0, 8)).not.toContain(secret);
    }
    expect(logs).not.toMatch(/agendly_session=/);
  });
});
