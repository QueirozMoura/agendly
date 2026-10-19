// Verificação de e-mail (3.3), reenvio e aviso de conta existente; outbox transacional no cadastro (O5/O6).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.ts";
import type { PrismaClient } from "../../src/lib/db/client.ts";
import { runOutboxCycle } from "../../src/jobs/outbox-worker.ts";
import { AUTH_TOKEN_TTL_MS } from "../../src/modules/auth/account.ts";
import {
  PASSWORD,
  TEST_KEYRING,
  cookieHeader,
  latestToken,
  makeAuthApp,
  post,
  registerAndLogin,
  requestReset,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  RecordingLogger,
  ScriptedSender,
  BASE_URL,
} from "../support/outbox.ts";

let t: AuthTestApp;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const EMAIL = "ana@example.com";
const register = (email = EMAIL) =>
  post(t, "/api/auth/register", { email, name: "Ana", password: PASSWORD });
const verify = (token: unknown) => post(t, "/api/auth/verify-email", { token });
const invalid = (res: {
  statusCode: number;
  json(): { error: { code: string } };
}) => {
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe("TOKEN_INVALID_OR_EXPIRED");
};

describe("cadastro: token + e-mail na mesma transação", () => {
  it("e-mail novo => 1 usuário, 1 token de verificação (só hash) e 1 VERIFY_EMAIL cifrado", async () => {
    await register();
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    const tokens = await t.prisma.authToken.findMany({
      where: { userId: user.id },
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: "EMAIL_VERIFICATION",
      usedAt: null,
    });
    expect(tokens[0]!.expiresAt.getTime() - t.clock.now().getTime()).toBe(
      AUTH_TOKEN_TTL_MS,
    );

    const outbox = await t.prisma.emailOutbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      template: "VERIFY_EMAIL",
      toEmail: EMAIL,
      status: "PENDING",
      keyId: "t1",
    });

    const raw = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    expect(tokens[0]!.tokenHash).toBe(sha256Hex(raw)); // S6: o banco guarda só o hash
    expect(JSON.stringify(tokens)).not.toContain(raw);
    expect(
      Buffer.from(outbox[0]!.payloadEncrypted!).includes(Buffer.from(raw)),
    ).toBe(false); // cifrado
  });

  it("e-mail já cadastrado => só ACCOUNT_EXISTS (1 linha), conta e tokens intactos", async () => {
    await register();
    const before = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    const res = await register();
    expect(res.statusCode).toBe(202);
    const rows = await t.prisma.emailOutbox.findMany({
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => r.template)).toEqual([
      "VERIFY_EMAIL",
      "ACCOUNT_EXISTS",
    ]);
    expect(await t.prisma.authToken.count()).toBe(1);
    expect(
      await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } }),
    ).toEqual(before);
  });

  it("O5: rollback do cadastro (falha ao enfileirar) => nenhum usuário, token nem linha na outbox", async () => {
    await t.close();
    let fail = true;
    t = await makeAuthApp({
      wrapPrisma: (p) =>
        p.$extends({
          query: {
            emailOutbox: {
              async create({ args, query }) {
                const result = await query(args); // a linha chega a ser inserida na transação...
                if (fail)
                  throw new Error("falha injetada depois do INSERT da outbox");
                return result;
              },
            },
          },
        }) as unknown as PrismaClient,
    });
    const res = await register();
    expect(res.statusCode).toBe(500);
    expect(await t.prisma.user.count()).toBe(0);
    expect(await t.prisma.authToken.count()).toBe(0);
    expect(await t.prisma.emailOutbox.count()).toBe(0); // ...e some junto com o resto

    fail = false;
    expect((await register()).statusCode).toBe(202); // commit => exatamente uma linha
    expect(await t.prisma.emailOutbox.count()).toBe(1);
  });

  it("O6: com o provedor totalmente fora do ar a API segue respondendo; as mensagens ficam PENDING", async () => {
    const sender = new ScriptedSender();
    sender.behavior = async () => {
      throw new Error("provedor fora do ar");
    };
    await register();
    // O laço tenta e falha; o cadastro, o login e a consulta de sessão não dependem dele.
    await runOutboxCycle({
      prisma: t.prisma,
      keyring: TEST_KEYRING,
      sender,
      clock: t.clock,
      logger: new RecordingLogger(),
      baseUrl: BASE_URL,
    });
    expect(sender.calls).toHaveLength(1);
    const { cookie } = await registerAndLogin(t, "outra@example.com");
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/api/me",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    const rows = await t.prisma.emailOutbox.findMany();
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
  });
});

describe("POST /api/auth/verify-email", () => {
  it("token válido => 204, e-mail verificado; /api/me reflete", async () => {
    const { cookie } = await registerAndLogin(t);
    const token = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    const res = await verify(token);
    expect(res.statusCode).toBe(204);
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.emailVerifiedAt?.toISOString()).toBe(
      t.clock.now().toISOString(),
    );
    const me = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(me.json().user.emailVerified).toBe(true);
    expect((await t.prisma.authToken.findFirstOrThrow()).usedAt).not.toBeNull();
  });

  it("não altera credentials_version nem derruba sessões", async () => {
    const { cookie } = await registerAndLogin(t);
    await verify(await latestToken(t, "VERIFY_EMAIL", EMAIL));
    expect(
      (await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } }))
        .credentialsVersion,
    ).toBe(0);
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/api/me",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("uso único, expirado, inexistente, lixo e token de OUTRO tipo => a MESMA resposta 400", async () => {
    await register();
    const token = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    expect((await verify(token)).statusCode).toBe(204);
    const responses = [
      await verify(token), // já usado
      await verify("A".repeat(43)), // inexistente
      await verify("lixo"), // lixo
      await verify(await requestReset(t, EMAIL)), // token de redefinição no endpoint de verificação
    ];
    responses.forEach(invalid);
    const strip = (r: (typeof responses)[number]) => ({
      ...r.json().error,
      requestId: undefined,
    });
    expect(new Set(responses.map((r) => JSON.stringify(strip(r)))).size).toBe(
      1,
    );

    // expirado
    await register("expira@example.com");
    const t2 = await latestToken(t, "VERIFY_EMAIL", "expira@example.com");
    t.clock.advance(AUTH_TOKEN_TTL_MS + 1000);
    invalid(await verify(t2));
    expect(
      (
        await t.prisma.user.findUniqueOrThrow({
          where: { email: "expira@example.com" },
        })
      ).emailVerifiedAt,
    ).toBeNull();
  });

  it("duas verificações simultâneas com o mesmo token => exatamente uma tem sucesso", async () => {
    await register();
    const token = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    const results = await Promise.all([
      verify(token),
      verify(token),
      verify(token),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400, 400]);
  });

  it("corpo inválido => 400 VALIDATION_ERROR (campo extra, token ausente)", async () => {
    for (const body of [{}, { token: "x", extra: 1 }, { token: 5 }]) {
      const res = await post(t, "/api/auth/verify-email", body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("o token vai no corpo e exige Origin/JSON (CSRF); GET não existe", async () => {
    const get = await t.app.inject({
      method: "GET",
      url: "/api/auth/verify-email?token=x",
    });
    expect(get.statusCode).toBe(404);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { "content-type": "application/json" },
      payload: '{"token":"x"}',
    });
    expect(noOrigin.statusCode).toBe(403);
  });
});

describe("POST /api/auth/resend-verification", () => {
  it("exige sessão", async () => {
    const res = await post(t, "/api/auth/resend-verification", {});
    expect(res.statusCode).toBe(401);
  });

  it("não verificado: novo link e o anterior deixa de valer; um único pendente por vez", async () => {
    const { cookie } = await registerAndLogin(t);
    const first = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    const res = await post(t, "/api/auth/resend-verification", {}, { cookie });
    expect(res.statusCode).toBe(202);
    const second = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    expect(second).not.toBe(first);
    const pending = await t.prisma.authToken.count({
      where: { type: "EMAIL_VERIFICATION", usedAt: null },
    });
    expect(pending).toBe(1);
    invalid(await verify(first));
    expect((await verify(second)).statusCode).toBe(204);
  });

  it("já verificado: resposta idêntica e nenhum e-mail novo", async () => {
    const { cookie } = await registerAndLogin(t);
    const notYet = await post(
      t,
      "/api/auth/resend-verification",
      {},
      { cookie },
    );
    await verify(await latestToken(t, "VERIFY_EMAIL", EMAIL));
    const outboxBefore = await t.prisma.emailOutbox.count();
    const done = await post(t, "/api/auth/resend-verification", {}, { cookie });
    expect(done.statusCode).toBe(notYet.statusCode);
    expect(done.json()).toEqual(notYet.json());
    expect(await t.prisma.emailOutbox.count()).toBe(outboxBefore);
  });

  it("limite por usuário: a 4ª solicitação na janela => 429", async () => {
    const { cookie } = await registerAndLogin(t);
    for (let i = 0; i < 3; i++) {
      expect(
        (await post(t, "/api/auth/resend-verification", {}, { cookie }))
          .statusCode,
      ).toBe(202);
    }
    const res = await post(t, "/api/auth/resend-verification", {}, { cookie });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/logout-all", () => {
  it("revoga todas as sessões do usuário, limpa o cookie e não toca em outros usuários nem na versão", async () => {
    const a1 = await registerAndLogin(t, "a@example.com");
    const a2 = await post(t, "/api/auth/login", {
      email: "a@example.com",
      password: PASSWORD,
    });
    const b = await registerAndLogin(t, "b@example.com");
    const res = await post(
      t,
      "/api/auth/logout-all",
      {},
      { cookie: a1.cookie },
    );
    expect(res.statusCode).toBe(204);
    expect(res.cookies[0]?.value).toBe("");
    const me = (cookie: string) =>
      t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect((await me(a1.cookie)).statusCode).toBe(401);
    expect((await me(cookieHeader(a2))).statusCode).toBe(401);
    expect((await me(b.cookie)).statusCode).toBe(200);
    expect(
      (
        await t.prisma.user.findUniqueOrThrow({
          where: { email: "a@example.com" },
        })
      ).credentialsVersion,
    ).toBe(0);
  });

  it("sem sessão => 401", async () => {
    expect((await post(t, "/api/auth/logout-all", {})).statusCode).toBe(401);
  });
});
