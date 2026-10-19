// Recuperação de senha (3.4): critérios S1–S7 e a metade de S9 que usa redefinição.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.ts";
import type { PrismaClient } from "../../src/lib/db/client.ts";
import { AUTH_TOKEN_TTL_MS } from "../../src/modules/auth/account.ts";
import {
  Gate,
  PASSWORD,
  cookieHeader,
  latestToken,
  makeAuthApp,
  post,
  registerAndLogin,
  requestReset,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const EMAIL = "ana@example.com";
const NEW_PASSWORD = "nova-senha-bem-longa-4K";
const reset = (token: unknown, newPassword = NEW_PASSWORD) =>
  post(t, "/api/auth/reset-password", { token, newPassword });
const me = (cookie: string) =>
  t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
const login = (password: string) =>
  post(t, "/api/auth/login", { email: EMAIL, password });
const strip = (r: {
  statusCode: number;
  json(): { error?: Record<string, unknown> } & Record<string, unknown>;
  headers: Record<string, unknown>;
}) => ({
  status: r.statusCode,
  body: {
    ...r.json(),
    error: r.json().error && { ...r.json().error, requestId: undefined },
  },
  headers: {
    ...r.headers,
    date: undefined,
    "x-request-id": undefined,
    "content-length": undefined,
  },
});

describe("POST /api/auth/forgot-password", () => {
  it("S7: e-mail cadastrado e não cadastrado => mesma resposta (status, corpo, cabeçalhos)", async () => {
    await registerAndLogin(t);
    const known = await post(t, "/api/auth/forgot-password", { email: EMAIL });
    const unknown = await post(t, "/api/auth/forgot-password", {
      email: "ninguem@example.com",
    });
    expect(known.statusCode).toBe(202);
    expect(strip(unknown)).toEqual(strip(known));
  });

  it("só o usuário existente gera token + RESET_PASSWORD na mesma transação", async () => {
    await registerAndLogin(t);
    await post(t, "/api/auth/forgot-password", {
      email: "ninguem@example.com",
    });
    expect(
      await t.prisma.emailOutbox.count({
        where: { template: "RESET_PASSWORD" },
      }),
    ).toBe(0);
    await post(t, "/api/auth/forgot-password", { email: EMAIL });
    const rows = await t.prisma.emailOutbox.findMany({
      where: { template: "RESET_PASSWORD" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toEmail).toBe(EMAIL);
    const tok = await t.prisma.authToken.findFirstOrThrow({
      where: { type: "PASSWORD_RESET" },
    });
    expect(tok.expiresAt.getTime() - t.clock.now().getTime()).toBe(
      AUTH_TOKEN_TTL_MS,
    );
  });

  it("S6: o banco guarda só o hash do token (e a outbox só o cifrado)", async () => {
    await registerAndLogin(t);
    const raw = await requestReset(t, EMAIL);
    const tokens = await t.prisma.authToken.findMany({
      where: { type: "PASSWORD_RESET" },
    });
    expect(tokens.map((x) => x.tokenHash)).toEqual([sha256Hex(raw)]);
    expect(JSON.stringify(tokens)).not.toContain(raw);
    const outbox = await t.prisma.emailOutbox.findMany();
    for (const r of outbox)
      expect(Buffer.from(r.payloadEncrypted!).includes(Buffer.from(raw))).toBe(
        false,
      );
  });

  it("S4: pedir novo token invalida os anteriores", async () => {
    await registerAndLogin(t);
    const first = await requestReset(t, EMAIL);
    const second = await requestReset(t, EMAIL);
    expect(second).not.toBe(first);
    expect(
      await t.prisma.authToken.count({
        where: { type: "PASSWORD_RESET", usedAt: null },
      }),
    ).toBe(1);
    expect((await reset(first)).statusCode).toBe(400);
    expect((await reset(second)).statusCode).toBe(204);
  });

  it("limite por e-mail: a 4ª solicitação na janela => 429, e o e-mail não vaza no corpo", async () => {
    await registerAndLogin(t);
    for (let i = 0; i < 3; i++) {
      expect(
        (await post(t, "/api/auth/forgot-password", { email: EMAIL }))
          .statusCode,
      ).toBe(202);
    }
    const res = await post(t, "/api/auth/forgot-password", { email: EMAIL });
    expect(res.statusCode).toBe(429);
    expect(res.body).not.toContain(EMAIL);
  });

  it("e-mail inválido => 400", async () => {
    const res = await post(t, "/api/auth/forgot-password", { email: "x" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("sucesso: nova senha vale, a antiga não, versão +1, e as sessões anteriores caem (S5)", async () => {
    const s1 = await registerAndLogin(t);
    const s2 = await login(PASSWORD);
    const token = await requestReset(t, EMAIL);

    const res = await reset(token);
    expect(res.statusCode).toBe(204);

    expect((await me(s1.cookie)).statusCode).toBe(401);
    expect((await me(cookieHeader(s2))).statusCode).toBe(401);
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.credentialsVersion).toBe(1);
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await t.prisma.session.count({ where: { revokedAt: null } })).toBe(
      0,
    );

    // exatamente um aviso PASSWORD_CHANGED
    expect(
      await t.prisma.emailOutbox.count({
        where: { template: "PASSWORD_CHANGED", toEmail: EMAIL },
      }),
    ).toBe(1);

    // S3 (linha "login depois do commit"): a senha antiga falha; a nova gera sessão com a versão nova.
    expect((await login(PASSWORD)).statusCode).toBe(401);
    const fresh = await login(NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(
      (await t.prisma.session.findFirstOrThrow({ where: { revokedAt: null } }))
        .credentialsVersion,
    ).toBe(1);
    expect((await me(cookieHeader(fresh))).statusCode).toBe(200);
  });

  it("S4: expirado, já usado e inexistente produzem a MESMA resposta", async () => {
    await registerAndLogin(t);
    const used = await requestReset(t, EMAIL);
    expect((await reset(used)).statusCode).toBe(204);
    const expired = await requestReset(t, EMAIL);
    t.clock.advance(AUTH_TOKEN_TTL_MS + 1000);
    const responses = [
      await reset(used),
      await reset(expired),
      await reset("A".repeat(43)),
      await reset("lixo"),
    ];
    for (const r of responses) {
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("TOKEN_INVALID_OR_EXPIRED");
    }
    expect(new Set(responses.map((r) => JSON.stringify(strip(r)))).size).toBe(
      1,
    );
  });

  it("token de verificação de e-mail não serve para redefinir a senha", async () => {
    await registerAndLogin(t);
    const verification = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    expect((await reset(verification)).statusCode).toBe(400);
    expect((await login(PASSWORD)).statusCode).toBe(200); // senha intacta
  });

  it("senha nova fora da política => 400 e o token CONTINUA utilizável", async () => {
    await registerAndLogin(t);
    const token = await requestReset(t, EMAIL);
    for (const weak of ["curta", "password123", "x".repeat(129)]) {
      const r = await reset(token, weak);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect((await reset(token)).statusCode).toBe(204);
  });

  it("invalida os demais tokens de redefinição pendentes do usuário", async () => {
    await registerAndLogin(t);
    const token = await requestReset(t, EMAIL);
    // Um 2º token pendente criado por fora (ex.: corrida antiga) também deve cair.
    await t.prisma.authToken.create({
      data: {
        userId: (
          await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
        ).id,
        type: "PASSWORD_RESET",
        tokenHash: "outro-pendente",
        expiresAt: new Date(t.clock.now().getTime() + 1e6),
      },
    });
    await reset(token);
    expect(
      await t.prisma.authToken.count({
        where: { type: "PASSWORD_RESET", usedAt: null },
      }),
    ).toBe(0);
  });

  it("S1: duas redefinições simultâneas com o mesmo token => exatamente uma vence e a senha final é a dela", async () => {
    await registerAndLogin(t);
    const token = await requestReset(t, EMAIL);
    const pA = "senha-da-tentativa-A-11Q";
    const pB = "senha-da-tentativa-B-22W";
    const [a, b] = await Promise.all([reset(token, pA), reset(token, pB)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 400]);
    const winner = a.statusCode === 204 ? pA : pB;
    const loser = winner === pA ? pB : pA;
    expect((await login(loser)).statusCode).toBe(401);
    expect((await login(winner)).statusCode).toBe(200);
    expect(
      (await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } }))
        .credentialsVersion,
    ).toBe(1);
    expect(
      await t.prisma.emailOutbox.count({
        where: { template: "PASSWORD_CHANGED" },
      }),
    ).toBe(1);
  });
});

describe("S2 — falha injetada: rollback total", () => {
  type Fault =
    | "user.update"
    | "session.updateMany"
    | "emailOutbox.create"
    | "authToken.updateMany(2)";
  const faults: Fault[] = [
    "user.update",
    "session.updateMany",
    "emailOutbox.create",
  ];

  for (const where of faults) {
    it(`erro em ${where} depois do consumo do token => token, senha, versão, sessões e outbox intactos`, async () => {
      await t.close();
      const state = { fail: false };
      const boom = (): never => {
        throw new Error(`falha injetada em ${where}`);
      };
      t = await makeAuthApp({
        wrapPrisma: (p) =>
          p.$extends({
            query: {
              user: {
                async update({ args, query }) {
                  if (state.fail && where === "user.update") boom();
                  return query(args);
                },
              },
              session: {
                async updateMany({ args, query }) {
                  if (state.fail && where === "session.updateMany") boom();
                  return query(args);
                },
              },
              emailOutbox: {
                async create({ args, query }) {
                  if (state.fail && where === "emailOutbox.create") boom();
                  return query(args);
                },
              },
            },
          }) as unknown as PrismaClient,
      });
      const s = await registerAndLogin(t);
      const token = await requestReset(t, EMAIL);
      const before = await t.prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
      });
      const outboxBefore = await t.prisma.emailOutbox.count();

      state.fail = true;
      const res = await reset(token);
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");

      const after = await t.prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
      });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.credentialsVersion).toBe(0);
      expect(
        (
          await t.prisma.authToken.findFirstOrThrow({
            where: { type: "PASSWORD_RESET" },
          })
        ).usedAt,
      ).toBeNull();
      expect(
        await t.prisma.session.count({ where: { revokedAt: { not: null } } }),
      ).toBe(0);
      expect(await t.prisma.emailOutbox.count()).toBe(outboxBefore);
      expect((await me(s.cookie)).statusCode).toBe(200); // sessão anterior segue válida (coerente com o rollback)

      state.fail = false;
      expect((await reset(token)).statusCode).toBe(204); // o token continuava utilizável
      expect((await me(s.cookie)).statusCode).toBe(401);
    });
  }
});

describe("S3/S9 — login concorrente com a redefinição (barreiras)", () => {
  it("login leu hash+V antes do commit e cria a sessão DEPOIS: a sessão cai na 1ª requisição (401)", async () => {
    await t.close();
    const gate = new Gate();
    t = await makeAuthApp({
      wrapPrisma: (p) =>
        p.$extends({
          query: {
            session: {
              async create({ args, query }) {
                await gate.pass();
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient,
    });
    await post(t, "/api/auth/register", {
      email: EMAIL,
      name: "Ana",
      password: PASSWORD,
    });
    const token = await requestReset(t, EMAIL);

    const pendingLogin = login(PASSWORD); // lê o usuário (hash antigo, V=0) e para antes de criar a sessão
    await gate.reached;
    expect((await reset(token)).statusCode).toBe(204); // redefinição confirma nesse intervalo
    gate.release();
    const res = await pendingLogin;

    expect(res.statusCode).toBe(200); // o login foi concluído com a senha que valia quando ele leu
    const session = await t.prisma.session.findFirstOrThrow();
    expect(session.credentialsVersion).toBe(0);
    expect(session.revokedAt).toBeNull(); // a revogação do passo 5 não a enxergou...
    expect((await me(cookieHeader(res))).statusCode).toBe(401); // ...quem fecha a janela é a versão
  });

  it("sessão criada ENQUANTO a redefinição está em andamento (invisível ao passo 5) cai após o commit", async () => {
    await t.close();
    const gate = new Gate();
    t = await makeAuthApp({
      wrapPrisma: (p) =>
        p.$extends({
          query: {
            emailOutbox: {
              async create({ args, query }) {
                if (
                  (args.data as { template?: string }).template ===
                  "PASSWORD_CHANGED"
                )
                  await gate.pass(); // passo 6
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient,
    });
    await post(t, "/api/auth/register", {
      email: EMAIL,
      name: "Ana",
      password: PASSWORD,
    });
    const token = await requestReset(t, EMAIL);

    const pendingReset = reset(token); // executa os passos 1–5 e para antes do 6, com o lock do usuário
    await gate.reached;
    const res = await login(PASSWORD); // não bloqueia (FOR NO KEY UPDATE × FOR KEY SHARE) e vê a senha antiga
    expect(res.statusCode).toBe(200);
    gate.release();
    expect((await pendingReset).statusCode).toBe(204);

    const session = await t.prisma.session.findFirstOrThrow();
    expect(session.revokedAt).toBeNull(); // o passo 5 não a viu
    expect((await me(cookieHeader(res))).statusCode).toBe(401); // a versão a invalida
  });
});
