import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.ts";
import {
  ORIGIN,
  PASSWORD,
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

const creds = { email: "ana@example.com", password: PASSWORD };
const register = () => post(t, "/api/auth/register", { ...creds, name: "Ana" });

describe("POST /api/auth/login", () => {
  it("credenciais válidas => 200 com dados públicos do usuário e cookie de sessão", async () => {
    await register();
    const res = await post(t, "/api/auth/login", {
      ...creds,
      email: "  ANA@example.com ",
    });
    expect(res.statusCode).toBe(200);
    const { user } = res.json();
    expect(user).toEqual({
      id: expect.any(String),
      email: "ana@example.com",
      name: "Ana",
      emailVerified: false,
    });
    expect(JSON.stringify(res.json())).not.toMatch(/hash|argon2|password/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.cookies).toHaveLength(1);
  });

  it("cookie: HttpOnly, SameSite=Lax, Path=/, Max-Age de 30 dias, sem Domain; Secure só em produção", async () => {
    await register();
    const dev = await post(t, "/api/auth/login", creds);
    const raw = String(dev.headers["set-cookie"]);
    expect(raw).toMatch(/^agendly_session=[A-Za-z0-9_-]{43};/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Max-Age=2592000/);
    expect(raw).not.toMatch(/Domain=/i);
    expect(raw).not.toMatch(/Secure/i);

    const prod = await makeAuthApp({ secureCookies: true });
    try {
      const res = await post(prod, "/api/auth/login", creds);
      const secure = String(res.headers["set-cookie"]);
      expect(secure).toMatch(/^__Host-agendly_session=/);
      expect(secure).toMatch(/; Secure/);
      expect(secure).toMatch(/HttpOnly/i);
      expect(secure).toMatch(/SameSite=Lax/i);
      expect(secure).toMatch(/Path=\//);
      expect(secure).not.toMatch(/Domain=/i);
    } finally {
      await prod.close();
    }
  });

  it("o banco guarda só o SHA-256 do token (32 bytes aleatórios), versão e prazos corretos", async () => {
    await register();
    const res = await post(t, "/api/auth/login", creds);
    const token = res.cookies[0]?.value as string;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const rows = await t.prisma.session.findMany();
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s?.tokenHash).toBe(sha256Hex(token));
    expect(s?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s?.credentialsVersion).toBe(0);
    expect(s?.revokedAt).toBeNull();
    expect(s?.expiresAt.toISOString()).toBe("2031-03-31T12:00:00.000Z"); // 30 dias após o "agora" injetado
    expect(s?.createdAt.toISOString()).toBe("2031-03-01T12:00:00.000Z");
    // O token em claro não aparece em nenhuma coluna de nenhuma linha.
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("cada login gera um token diferente", async () => {
    await register();
    const a = await post(t, "/api/auth/login", creds);
    const b = await post(t, "/api/auth/login", creds);
    expect(a.cookies[0]?.value).not.toBe(b.cookies[0]?.value);
    expect(await t.prisma.session.count()).toBe(2);
  });

  it("senha errada e usuário inexistente => resposta IDÊNTICA (sem enumeração) e sem sessão", async () => {
    await register();
    const wrongPassword = await post(t, "/api/auth/login", {
      ...creds,
      password: "senha-errada-123",
    });
    const unknownUser = await post(t, "/api/auth/login", {
      email: "ninguem@example.com",
      password: PASSWORD,
    });
    const strip = (r: typeof wrongPassword) => ({
      status: r.statusCode,
      body: { ...r.json(), error: { ...r.json().error, requestId: undefined } },
      headers: {
        ...r.headers,
        date: undefined,
        "x-request-id": undefined,
        "content-length": undefined,
      },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(strip(unknownUser)).toEqual(strip(wrongPassword));
    expect(wrongPassword.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
    expect(await t.prisma.session.count()).toBe(0);
  });

  it("usuário inexistente gasta custo de Argon2 comparável (não responde instantaneamente)", async () => {
    await register();
    const time = async (email: string) => {
      const start = performance.now();
      await post(t, "/api/auth/login", { email, password: "senha-errada-123" });
      return performance.now() - start;
    };
    await time("aquecimento@example.com"); // inicializa o hash fictício
    const unknown = await time("ninguem@example.com");
    const wrong = await time(creds.email);
    // Teste de sanidade, não de precisão: ambos fazem uma derivação completa (~100+ ms).
    expect(unknown).toBeGreaterThan(50);
    expect(wrong).toBeGreaterThan(50);
    expect(Math.abs(unknown - wrong)).toBeLessThan(
      Math.max(unknown, wrong) * 0.6,
    );
  });

  it("entradas inválidas => 400 sem tocar no banco de sessões", async () => {
    for (const body of [
      {},
      { email: "x" },
      { email: creds.email },
      { ...creds, extra: 1 },
      { ...creds, password: "a".repeat(129) },
    ]) {
      const res = await post(t, "/api/auth/login", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await t.prisma.session.count()).toBe(0);
  });

  it("login lê o hash da senha e a credentials_version em UMA única consulta (S9, parte de consulta)", async () => {
    await register();
    t.queries.length = 0;
    await post(t, "/api/auth/login", creds);
    const reads = t.queries.filter((q) => /FROM "public"\."users"/.test(q));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('"password_hash"');
    expect(reads[0]).toContain('"credentials_version"');
  });

  it("a sessão carrega a credentials_version lida junto com o hash (mesmo se já houver outra)", async () => {
    await register();
    await t.prisma.user.update({
      where: { email: creds.email },
      data: { credentialsVersion: 7 },
    });
    await post(t, "/api/auth/login", creds);
    expect((await t.prisma.session.findFirstOrThrow()).credentialsVersion).toBe(
      7,
    );
  });

  it("conta não verificada pode fazer login (a restrição é aplicada onde o e-mail é exigido)", async () => {
    await register();
    const res = await post(t, "/api/auth/login", creds);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.emailVerified).toBe(false);
  });

  it("limite por e-mail: a 9ª tentativa na janela => 429 com Retry-After, mesmo com a senha certa", async () => {
    await register();
    for (let i = 0; i < 8; i++) {
      const r = await post(t, "/api/auth/login", {
        ...creds,
        password: "senha-errada-123",
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await post(t, "/api/auth/login", creds);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Outro e-mail não é afetado pelo limite por e-mail.
    const other = await post(t, "/api/auth/login", {
      email: "outra@example.com",
      password: "x",
    });
    expect(other.statusCode).toBe(401);
  });

  it("limite por IP: 30 tentativas com e-mails diferentes e a 31ª => 429", async () => {
    for (let i = 0; i < 30; i++) {
      const r = await post(t, "/api/auth/login", {
        email: `u${i}@example.com`,
        password: "x",
      });
      expect(r.statusCode).toBe(401);
    }
    const res = await post(t, "/api/auth/login", {
      email: "u99@example.com",
      password: "x",
    });
    expect(res.statusCode).toBe(429);
  }, 60_000);

  it("registerAndLogin (helper) devolve cookie utilizável", async () => {
    const { cookie } = await registerAndLogin(t);
    expect(cookie).toMatch(/^agendly_session=/);
    void ORIGIN;
  });
});
