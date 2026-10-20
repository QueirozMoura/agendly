// Verificação de e-mail como condição para criar empresa (R10): fluxo completo, expiração, reenvio e tentativas de contornar.
// O envio real (Resend) NÃO é exercitado aqui: a mensagem é lida da outbox; o sender tem testes próprios com fetch falso.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { AUTH_TOKEN_TTL_MS } from "../../src/modules/auth/account.ts";
import {
  ALWAYS_VERIFIED_ACTIONS,
  emailPolicyAllows,
} from "../../src/modules/auth/email-policy.ts";
import { can } from "../../src/modules/auth/permissions.ts";
import {
  PASSWORD,
  TEST_KEYRING,
  latestToken,
  makeAuthApp,
  post,
  requestReset,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  api,
  createOrg,
  orgInput,
  signupUnverified,
  signupVerified,
} from "../support/orgs.ts";

let t: AuthTestApp;
beforeEach(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterEach(() => t.close());

const EMAIL = "bia@example.com";
const verify = (token: string) => post(t, "/api/auth/verify-email", { token });

describe("fluxo completo: cadastro → bloqueio → verificação → criação", () => {
  it("não verificada não cria; depois do link, cria; /api/me acompanha o estado real", async () => {
    const bia = await signupUnverified(t, EMAIL);
    const me = () => api(t, "GET", "/api/me", bia);
    expect((await me()).json().user).toMatchObject({
      emailVerified: false,
      emailVerificationRequired: true,
    });

    const blocked = await createOrg(t, bia, "salao-da-bia");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("EMAIL_NOT_VERIFIED");

    expect(
      (await verify(await latestToken(t, "VERIFY_EMAIL", EMAIL))).statusCode,
    ).toBe(204);
    expect((await me()).json().user.emailVerified).toBe(true);
    expect((await createOrg(t, bia, "salao-da-bia")).statusCode).toBe(201);
  });

  it("o login também informa a regra efetiva", async () => {
    await signupUnverified(t, EMAIL);
    const res = await post(t, "/api/auth/login", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(res.json().user).toMatchObject({
      emailVerified: false,
      emailVerificationRequired: true,
    });
  });
});

describe("expiração e reenvio", () => {
  it("link expirado não verifica nem libera a criação; o reenvio emite um novo e invalida o vencido", async () => {
    const bia = await signupUnverified(t, EMAIL);
    const expired = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    t.clock.advance(AUTH_TOKEN_TTL_MS + 1);

    expect((await verify(expired)).statusCode).toBe(400);
    expect((await createOrg(t, bia, "salao-da-bia")).statusCode).toBe(403);

    const resend = await post(
      t,
      "/api/auth/resend-verification",
      {},
      { cookie: bia.cookie },
    );
    expect(resend.statusCode).toBe(202);
    const fresh = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    expect(fresh).not.toBe(expired);
    expect((await verify(expired)).statusCode).toBe(400);
    expect((await verify(fresh)).statusCode).toBe(204);
    expect((await createOrg(t, bia, "salao-da-bia")).statusCode).toBe(201);
  });

  it("o token vale até o último instante da validade", async () => {
    await signupUnverified(t, EMAIL);
    const token = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    t.clock.advance(AUTH_TOKEN_TTL_MS - 1000);
    expect((await verify(token)).statusCode).toBe(204);
  });

  it("verificar com o token de OUTRO usuário não libera quem o tentou", async () => {
    const ana = await signupUnverified(t, "ana@example.com");
    await signupUnverified(t, EMAIL);
    const tokenDaBia = await latestToken(t, "VERIFY_EMAIL", EMAIL);
    // a rota é pública e o token identifica a conta dona: a sessão da Ana não influencia
    await post(
      t,
      "/api/auth/verify-email",
      { token: tokenDaBia },
      { cookie: ana.cookie },
    );
    expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(403);
    expect(
      (
        await t.prisma.user.findUniqueOrThrow({
          where: { email: "ana@example.com" },
        })
      ).emailVerifiedAt,
    ).toBeNull();
  });
});

describe("recuperação de senha não verifica o e-mail", () => {
  it("redefinir a senha por e-mail não libera a criação de empresa (outra prova de posse não vale como verificação)", async () => {
    await signupUnverified(t, EMAIL);
    const reset = await requestReset(t, EMAIL);
    const res = await post(t, "/api/auth/reset-password", {
      token: reset,
      newPassword: "outra-senha-bem-longa-7Y",
    });
    expect(res.statusCode).toBe(204);
    const login = await post(t, "/api/auth/login", {
      email: EMAIL,
      password: "outra-senha-bem-longa-7Y",
    });
    expect(login.statusCode).toBe(200);
    const user = {
      email: EMAIL,
      cookie: `${login.cookies[0]?.name}=${login.cookies[0]?.value}`,
      userId: "",
    };
    expect((await createOrg(t, user, "salao-da-bia")).statusCode).toBe(403);
  });
});

describe("tentativas de contornar a verificação", () => {
  it("query, corpo, cabeçalhos e cookies forjados não dispensam a regra", async () => {
    const bia = await signupUnverified(t, EMAIL);
    const attempts = [
      api(
        t,
        "POST",
        "/api/organizations?requireEmailVerification=false&emailVerified=true",
        bia,
        orgInput("a1"),
      ),
      api(t, "POST", "/api/organizations", bia, {
        ...orgInput("a2"),
        emailVerified: true,
      }),
      api(t, "POST", "/api/organizations", bia, {
        ...orgInput("a3"),
        emailVerifiedAt: new Date().toISOString(),
      }),
      api(t, "POST", "/api/organizations", bia, orgInput("a4"), {
        "x-require-email-verification": "false",
        "x-email-verified": "true",
        "x-forwarded-for": "127.0.0.1",
      }),
      api(
        t,
        "POST",
        "/api/organizations",
        {
          cookie: `${bia.cookie}; emailVerified=true; REQUIRE_EMAIL_VERIFICATION=false`,
        },
        orgInput("a5"),
      ),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(201);
    }
    expect(await t.prisma.organization.count()).toBe(0);
  });

  it("cadastrar-se de novo com o e-mail de uma conta pendente não a verifica nem a devolve", async () => {
    await signupUnverified(t, EMAIL);
    await post(t, "/api/auth/register", {
      email: EMAIL,
      name: "Outra",
      password: PASSWORD,
    });
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.emailVerifiedAt).toBeNull();
  });

  it("usuário verificado não é afetado e outro usuário não herda a verificação", async () => {
    const ok = await signupVerified(t, "ok@example.com");
    const pend = await signupUnverified(t, EMAIL);
    expect((await createOrg(t, ok, "salao-ok")).statusCode).toBe(201);
    expect((await createOrg(t, pend, "salao-pend")).statusCode).toBe(403);
  });
});

describe("dispensa de desenvolvimento e produção", () => {
  it("com a dispensa explícita (só fora de produção) a API informa emailVerificationRequired=false", async () => {
    const lax = await makeAuthApp({ requireEmailVerification: false });
    try {
      await resetUsers();
      const bia = await signupUnverified(lax, EMAIL);
      expect((await api(lax, "GET", "/api/me", bia)).json().user).toMatchObject(
        {
          emailVerified: false,
          emailVerificationRequired: false,
        },
      );
      expect((await createOrg(lax, bia, "salao-da-bia")).statusCode).toBe(201);
    } finally {
      await lax.close();
    }
  });

  it("buildApp recusa cookies seguros (produção) com a verificação dispensada", () => {
    expect(() =>
      buildApp({
        logger: false,
        checkDatabase: async () => {},
        auth: {
          prisma: {} as never,
          keyring: TEST_KEYRING,
          allowedOrigins: ["https://app.example.com"],
          secureCookies: true,
          requireEmailVerification: false,
        },
      }),
    ).toThrow(/produção/);
  });
});

describe("contas antigas: empresa criada sem verificação (M3)", () => {
  it("continuam donas e usam a empresa, mas não criam outra; nada é apagado nem alterado", async () => {
    // 1) a empresa nasce enquanto a dispensa de desenvolvimento estava ligada
    const lax = await makeAuthApp({ requireEmailVerification: false });
    const bia = await signupUnverified(lax, EMAIL);
    expect((await createOrg(lax, bia, "salao-antigo")).statusCode).toBe(201);
    await lax.close();

    // 2) o servidor passa a exigir a verificação (mesmo banco, mesma sessão)
    const before = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-antigo" },
    });
    const me = await api(t, "GET", "/api/organization", bia);
    expect(me.statusCode).toBe(200); // a empresa existente segue acessível
    expect((await createOrg(t, bia, "segundo-salao")).statusCode).toBe(403);
    expect(await t.prisma.organization.count()).toBe(1);
    const after = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-antigo" },
    });
    expect(after).toEqual(before);
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.emailVerifiedAt).toBeNull(); // nenhuma verificação automática

    // 3) e o caminho para regularizar continua aberto
    expect(
      (
        await post(
          t,
          "/api/auth/resend-verification",
          {},
          { cookie: bia.cookie },
        )
      ).statusCode,
    ).toBe(202);
    expect(
      (await verify(await latestToken(t, "VERIFY_EMAIL", EMAIL))).statusCode,
    ).toBe(204);
    expect((await createOrg(t, bia, "segundo-salao")).statusCode).toBe(201);
  });
});

describe("política de e-mail verificado para publicar (Etapa 14, só a regra; sem rotas)", () => {
  const unverified = { emailVerifiedAt: null };
  const verified = { emailVerifiedAt: new Date() };

  it("publicar exige e-mail verificado SEMPRE; despublicar nunca exige", () => {
    expect(emailPolicyAllows("org.public_page.publish", unverified)).toBe(
      false,
    );
    expect(emailPolicyAllows("org.public_page.publish", verified)).toBe(true);
    expect(emailPolicyAllows("org.public_page.unpublish", unverified)).toBe(
      true,
    );
    expect(emailPolicyAllows("org.settings.update", unverified)).toBe(true);
    expect([...ALWAYS_VERIFIED_ACTIONS]).toEqual(["org.public_page.publish"]);
  });

  it("não depende de REQUIRE_EMAIL_VERIFICATION: a função nem recebe essa configuração", () => {
    expect(emailPolicyAllows.length).toBe(2);
  });

  it("o OWNER pode despublicar na matriz de papéis (e a pergunta de verificação é separada)", () => {
    expect(can("OWNER", "org.public_page.unpublish")).toBe(true);
    expect(can("OWNER", "org.public_page.publish")).toBe(true);
    expect(can("ADMIN", "org.public_page.unpublish")).toBe(false);
  });

  it("hoje não existe rota para publicar: PATCH com status/publishedAt é recusado e a empresa continua sem publicação", async () => {
    const ok = await signupVerified(t, "ok@example.com");
    expect((await createOrg(t, ok, "salao-ok")).statusCode).toBe(201);
    for (const body of [
      { publishedAt: new Date().toISOString() },
      { status: "PUBLISHED" },
    ]) {
      const res = await api(t, "PATCH", "/api/organization", ok, body);
      expect(res.statusCode).toBe(400);
    }
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-ok" },
    });
    expect(org.publishedAt).toBeNull();
  });
});
