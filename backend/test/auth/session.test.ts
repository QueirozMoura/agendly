import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.ts";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "../../src/modules/auth/session.ts";
import {
  ORIGIN,
  makeAuthApp,
  post,
  registerAndLogin,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const me = (cookie?: string) =>
  t.app.inject({
    method: "GET",
    url: "/api/me",
    headers: cookie ? { cookie } : {},
  });
const expectCleared = (res: Awaited<ReturnType<typeof me>>) => {
  const c = res.cookies.find((x) => x.name === "agendly_session");
  expect(c, "cookie de sessão deve ser limpo").toBeDefined();
  expect(c?.value).toBe("");
  expect(String(res.headers["set-cookie"])).toMatch(
    /Max-Age=0|Expires=Thu, 01 Jan 1970/i,
  );
};

describe("GET /api/me", () => {
  it("com sessão válida => 200 com o usuário, sem dados sensíveis", async () => {
    const { cookie } = await registerAndLogin(t);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: {
        id: expect.any(String),
        email: "ana@example.com",
        name: "Ana",
        emailVerified: false,
      },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.json())).not.toMatch(/hash|credentials|argon2/i);
  });

  it("sem cookie, com lixo ou com token desconhecido => 401 UNAUTHENTICATED e cookie limpo", async () => {
    await registerAndLogin(t);
    for (const cookie of [
      undefined,
      "agendly_session=",
      "agendly_session=lixo",
      `agendly_session=${"A".repeat(43)}`,
    ]) {
      const res = await me(cookie);
      expect(res.statusCode, String(cookie)).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
      expectCleared(res);
    }
  });

  it("valida a sessão em UMA consulta (JOIN sessão + usuário), sem cache entre requisições", async () => {
    const { cookie } = await registerAndLogin(t);
    t.queries.length = 0;
    await me(cookie);
    await me(cookie);
    const selects = t.queries.filter((q) => /^SELECT/.test(q));
    expect(selects).toHaveLength(2); // exatamente uma por requisição
    expect(selects[0]).toMatch(/sessions/);
    expect(selects[0]).toMatch(/JOIN|LEFT JOIN/i);
    expect(selects[0]).toContain("credentials_version");
  });
});

describe("expiração, revogação e credentials_version", () => {
  it("sessão revogada (revoked_at) => 401", async () => {
    const { cookie } = await registerAndLogin(t);
    await t.prisma.session.updateMany({ data: { revokedAt: new Date() } });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("teto absoluto de 30 dias => 401, mesmo com atividade", async () => {
    const { cookie } = await registerAndLogin(t);
    for (let i = 0; i < 4; i++) {
      t.clock.advance(SESSION_IDLE_MS - 60_000); // sempre ativo dentro da janela de inatividade
      if (
        t.clock.now().getTime() - new Date("2031-03-01T12:00:00Z").getTime() <
        SESSION_ABSOLUTE_MS
      ) {
        expect((await me(cookie)).statusCode).toBe(200);
      }
    }
    // Já passou de 28 dias; avança além dos 30.
    t.clock.advance(3 * 24 * 60 * 60 * 1000);
    const res = await me(cookie);
    expect(res.statusCode).toBe(401);
    expectCleared(res);
  });

  it("expiração por inatividade (7 dias sem uso) => 401", async () => {
    const { cookie } = await registerAndLogin(t);
    t.clock.advance(SESSION_IDLE_MS - 1000);
    expect((await me(cookie)).statusCode).toBe(200); // ainda dentro
    t.clock.advance(SESSION_IDLE_MS + 1000);
    const res = await me(cookie);
    expect(res.statusCode).toBe(401);
    expectCleared(res);
  });

  it("expiração deslizante: o uso renova a janela (last_seen_at, no máximo 1x/hora)", async () => {
    const { cookie } = await registerAndLogin(t);
    const lastSeen = async () =>
      (await t.prisma.session.findFirstOrThrow()).lastSeenAt.getTime();
    const t0 = await lastSeen();

    t.clock.advance(SESSION_TOUCH_INTERVAL_MS - 60_000); // menos de 1 h: não escreve
    await me(cookie);
    expect(await lastSeen()).toBe(t0);

    t.clock.advance(120_000); // passou de 1 h: escreve
    await me(cookie);
    const t1 = await lastSeen();
    expect(t1).toBeGreaterThan(t0);

    // Prova da renovação: 6 dias + 6 dias = 12 dias no total, mas nunca 7 dias sem uso.
    t.clock.advance(6 * 24 * 60 * 60 * 1000);
    expect((await me(cookie)).statusCode).toBe(200);
    t.clock.advance(6 * 24 * 60 * 60 * 1000);
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it("credentials_version desatualizada => 401 mesmo sem revogação e sem expiração (S8)", async () => {
    const { cookie } = await registerAndLogin(t);
    expect((await me(cookie)).statusCode).toBe(200);
    // Simula a troca de senha (Etapa 5) alterando só a versão do usuário, entre duas requisições.
    await t.prisma.user.update({
      where: { email: "ana@example.com" },
      data: { credentialsVersion: { increment: 1 } },
    });
    const session = await t.prisma.session.findFirstOrThrow();
    expect(session.revokedAt).toBeNull();
    expect(session.expiresAt.getTime()).toBeGreaterThan(
      t.clock.now().getTime(),
    );

    const res = await me(cookie);
    expect(res.statusCode).toBe(401); // a 2ª requisição falha: não há cache de sessão validada
    expectCleared(res);
  });

  it("sessão de um usuário não vale para outro (isolamento por token)", async () => {
    const a = await registerAndLogin(t, "a@example.com");
    const b = await registerAndLogin(t, "b@example.com");
    expect((await me(a.cookie)).json().user.email).toBe("a@example.com");
    expect((await me(b.cookie)).json().user.email).toBe("b@example.com");
  });

  it("o token só vale no formato exato: hash do token no banco não serve como cookie", async () => {
    const { token } = await registerAndLogin(t);
    const hash = sha256Hex(token);
    expect((await me(`agendly_session=${hash}`)).statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revoga a sessão, limpa o cookie e a sessão deixa de valer", async () => {
    const { cookie, token } = await registerAndLogin(t);
    const res = await post(t, "/api/auth/logout", {}, { cookie });
    expect(res.statusCode).toBe(204);
    expectCleared(res);

    const s = await t.prisma.session.findFirstOrThrow({
      where: { tokenHash: sha256Hex(token) },
    });
    expect(s.revokedAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("só revoga a sessão do cookie; outras sessões do mesmo usuário continuam válidas", async () => {
    const first = await registerAndLogin(t);
    const second = await post(t, "/api/auth/login", {
      email: "ana@example.com",
      password: "uma-senha-bem-longa-9X",
    });
    const secondCookie = `agendly_session=${second.cookies[0]?.value}`;
    await post(t, "/api/auth/logout", {}, { cookie: first.cookie });
    expect((await me(first.cookie)).statusCode).toBe(401);
    expect((await me(secondCookie)).statusCode).toBe(200);
  });

  it("é idempotente: sem sessão, com cookie inválido ou repetido => 204 e cookie limpo", async () => {
    const { cookie } = await registerAndLogin(t);
    for (const c of [undefined, "agendly_session=lixo", cookie, cookie]) {
      const res = await post(t, "/api/auth/logout", {}, c ? { cookie: c } : {});
      expect(res.statusCode).toBe(204);
      expectCleared(res);
    }
  });

  it("exige Origin permitido: logout cross-site não revoga nada", async () => {
    const { cookie } = await registerAndLogin(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        cookie,
      },
      payload: "{}",
    });
    expect(res.statusCode).toBe(403);
    expect((await me(cookie)).statusCode).toBe(200);
    void ORIGIN;
  });
});
