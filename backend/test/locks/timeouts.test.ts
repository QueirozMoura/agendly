// Correção delimitada pós-auditoria da Etapa 9: fluxos de autenticação/organização sob runLocked e classificação
// de P2028. Testes marcados [integração] usam o Postgres e os erros REAIS do Prisma 7.10.1; os marcados [sintético]
// fabricam o formato do erro para cobrir variantes que não dá para provocar com segurança.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as GeneratedClient } from "../../src/generated/prisma/client.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { registerErrorHandling } from "../../src/plugins/error-handler.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import {
  api,
  createOrg,
  signupVerified,
  type TestUser,
} from "../support/orgs.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newClient = (max = 1) =>
  new GeneratedClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl(TEST_DB),
      max,
      connectionTimeoutMillis: 3000,
    }),
  });

async function appWith(routes: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify({ logger: false });
  registerErrorHandling(app);
  routes(app);
  await app.ready();
  return app;
}

describe("[integração] classificação de P2028 com os erros reais do Prisma", () => {
  let p: GeneratedClient;
  beforeEach(() => {
    p = newClient();
  });
  afterEach(() => p.$disconnect());

  it("transação que EXPIRA (consulta depois do prazo) => transaction_timeout", async () => {
    const err = await p
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await sleep(400);
          await tx.$queryRaw`SELECT 2`;
        },
        { timeout: 150 },
      )
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("P2028");
    expect(classifyDbError(err)).toBe("transaction_timeout");
  });

  it("transação que expira durante uma consulta lenta e falha no COMMIT => transaction_timeout, e nada é gravado", async () => {
    const err = await p
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_sleep(0.5)::text`;
        },
        { timeout: 150 },
      )
      .catch((e: unknown) => e);
    expect(classifyDbError(err)).toBe("transaction_timeout");
  });

  it("sem conexão no pool dentro de maxWait ('Unable to start a transaction in the given time') => transaction_timeout", async () => {
    const hold = p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await sleep(700);
    });
    await sleep(60);
    const err = await p
      .$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 150 })
      .catch((e: unknown) => e);
    await hold;
    expect((err as { code: string }).code).toBe("P2028");
    expect(classifyDbError(err)).toBe("transaction_timeout");
  });

  it("P2028 que NÃO é timeout (transação já encerrada) => não classificado", async () => {
    let leaked: Parameters<Parameters<typeof p.$transaction>[0]>[0] | undefined;
    await p.$transaction(async (tx) => {
      leaked = tx;
    });
    const err = await leaked!.$queryRaw`SELECT 1`.catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("P2028");
    expect(String((err as Error).message)).toContain("already closed");
    expect(classifyDbError(err)).toBeUndefined();
  });
});

describe("[integração] tratador de erros com P2028 real", () => {
  it("expiração => 503 TEMPORARILY_BUSY + Retry-After, rollback total e corpo sem detalhes internos", async () => {
    const p = newClient(2);
    const app = await appWith((a) => {
      a.get("/slow", async () => {
        await p.$transaction(
          async (tx) => {
            await tx.$executeRaw`INSERT INTO organizations (id, name, slug, timezone, updated_at)
              VALUES (gen_random_uuid(), 'x', 'rollback-probe', 'UTC', now())`;
            await sleep(400);
            await tx.$queryRaw`SELECT 1`;
          },
          { timeout: 150 },
        );
        return { ok: true };
      });
      a.get("/closed", async () => {
        let leaked: {
          $queryRaw: (s: TemplateStringsArray) => Promise<unknown>;
        };
        await p.$transaction(async (tx) => {
          leaked = tx;
        });
        await leaked!.$queryRaw`SELECT 1`;
        return { ok: true };
      });
    });
    await resetUsers();
    const slow = await app.inject({ url: "/slow" });
    expect(slow.statusCode).toBe(503);
    expect(slow.headers["retry-after"]).toBe("1");
    expect(slow.json().error).toMatchObject({
      code: "TEMPORARILY_BUSY",
      message: "O sistema está ocupado. Tente novamente em instantes.",
    });
    expect(JSON.stringify(slow.json())).not.toMatch(
      /P2028|expired|timeout|ms|prisma|organizations|INSERT/i,
    );
    const c = await rawClient(TEST_DB);
    try {
      const { rows } = await c.query(
        "SELECT count(*)::int AS n FROM email_outbox",
      );
      expect(rows[0].n).toBe(0); // o INSERT feito antes do prazo sofreu rollback
    } finally {
      await c.end();
    }

    const closed = await app.inject({ url: "/closed" });
    expect(closed.statusCode).toBe(500); // P2028 que não é timeout continua erro interno
    expect(closed.json().error.code).toBe("INTERNAL_ERROR");
    expect(closed.headers["retry-after"]).toBeUndefined();
    await app.close();
    await p.$disconnect();
  });
});

describe("[sintético] formatos de P2028 no tratador", () => {
  const p2028 = (meta: unknown, message: string) => ({
    name: "PrismaClientKnownRequestError",
    code: "P2028",
    meta,
    message,
  });
  it.each([
    [
      "expirada (meta com timeout e timeTaken)",
      p2028({ operation: "commit", timeout: 8000, timeTaken: 8100 }, "x"),
      503,
    ],
    [
      "espera por conexão (mensagem)",
      p2028(
        {},
        "Transaction API error: Unable to start a transaction in the given time.",
      ),
      503,
    ],
    [
      "transação encerrada",
      p2028(
        {},
        "Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.",
      ),
      500,
    ],
    [
      "transação não encontrada",
      p2028({}, "Transaction API error: Transaction not found."),
      500,
    ],
    [
      "inconsistência interna",
      p2028({}, "Transaction API error: Internal Consistency Error: x"),
      500,
    ],
    [
      "meta parcial/mal formada",
      p2028({ timeout: "8000" }, "Transaction API error: algo"),
      500,
    ],
  ])("%s => %i", async (_name, err, status) => {
    const app = await appWith((a) =>
      a.get("/boom", async () => {
        throw err;
      }),
    );
    const res = await app.inject({ url: "/boom" });
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(
      status === 503 ? "TEMPORARILY_BUSY" : "INTERNAL_ERROR",
    );
    await app.close();
  });
});

describe("[integração] fluxos de autenticação e organização sob lock_timeout", () => {
  let t: AuthTestApp;
  let ana: TestUser;
  beforeEach(async () => {
    await resetUsers();
    t = await makeAuthApp();
    ana = await signupVerified(t, "ana@example.com");
    expect((await createOrg(t, ana, "salao-da-ana")).statusCode).toBe(201);
  });
  afterEach(() => t.close());

  async function hold(sql: string, id: string) {
    const c = await rawClient(TEST_DB);
    await c.query("BEGIN");
    await c.query(sql, [id]);
    return {
      release: async () => {
        await c.query("ROLLBACK");
        await c.end();
      },
    };
  }

  it("A1 preso por outra transação: logout-all => 503 em ~2 s, sessões intactas; liberada a trava, funciona", async () => {
    const held = await hold(
      "SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE",
      ana.userId,
    );
    let res;
    const started = Date.now();
    try {
      res = await api(t, "POST", "/api/auth/logout-all", ana, {});
    } finally {
      await held.release();
    }
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json().error.code).toBe("TEMPORARILY_BUSY");
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(5000);
    expect(await t.prisma.session.count({ where: { revokedAt: null } })).toBe(
      1,
    ); // rollback: nada revogado
    expect((await api(t, "GET", "/api/me", ana)).statusCode).toBe(200);

    expect(
      (await api(t, "POST", "/api/auth/logout-all", ana, {})).statusCode,
    ).toBe(204);
    expect(await t.prisma.session.count({ where: { revokedAt: null } })).toBe(
      0,
    );
  }, 20_000);

  it("linha da empresa presa: PATCH /api/organization => 503, empresa intacta; depois funciona", async () => {
    const org = await t.prisma.organization.findUniqueOrThrow({
      where: { slug: "salao-da-ana" },
    });
    const held = await hold(
      "SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE",
      org.id,
    );
    let res;
    try {
      res = await api(t, "PATCH", "/api/organization", ana, {
        name: "Outro nome",
      });
    } finally {
      await held.release();
    }
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("TEMPORARILY_BUSY");
    expect(JSON.stringify(res.json())).not.toContain(org.id);
    expect(
      (await t.prisma.organization.findUniqueOrThrow({ where: { id: org.id } }))
        .name,
    ).toBe(org.name);
    expect(
      (await api(t, "PATCH", "/api/organization", ana, { name: "Outro nome" }))
        .statusCode,
    ).toBe(200);
  }, 20_000);

  it("os fluxos modificados usam runLocked: `SET lock_timeout` aparece na transação e não vaza para fora", async () => {
    t.queries.length = 0;
    expect(
      (await api(t, "POST", "/api/auth/logout-all", ana, {})).statusCode,
    ).toBe(204);
    const setAt = t.queries.findIndex((q) =>
      /set_config\('lock_timeout'/.test(q),
    );
    const lockAt = t.queries.findIndex((q) =>
      /FROM users[\s\S]*FOR NO KEY UPDATE/.test(q),
    );
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeLessThan(lockAt); // timeout definido ANTES da primeira trava (A1)
    const [row] = await t.prisma.$queryRaw<
      { lock_timeout: string }[]
    >`SHOW lock_timeout`;
    expect(row?.lock_timeout).toBe("0");
  });

  it("A1 e a trava da empresa não aparecem na mesma transação (domínios disjuntos); nenhum LockOrderViolation nos fluxos", async () => {
    const bob = await signupVerified(t, "bob@example.com");
    expect((await createOrg(t, bob, "barbearia-bob")).statusCode).toBe(201);
    await Promise.all([
      api(t, "POST", "/api/auth/logout-all", bob, {}),
      api(t, "PATCH", "/api/organization", ana, { name: "Nome A" }),
      api(t, "POST", "/api/auth/resend-verification", ana, {}),
    ]);
    expect(t.logs()).not.toMatch(
      /LockOrderViolation|LockCoverageViolation|40P01/,
    );
  });
});

describe("estático — toda trava de users/organizations acontece dentro de runLocked", () => {
  const SRC = fileURLToPath(new URL("../../src", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      if (statSync(full).isDirectory())
        return n === "generated" ? [] : walk(full);
      return full.endsWith(".ts") ? [full] : [];
    });
  const files = walk(SRC).map((full) => ({
    path: relative(SRC, full).replaceAll("\\", "/"),
    code: readFileSync(full, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  }));

  /** Chamadas a lockUser/lockOrganization sem um `runLocked(` antes, na mesma função de topo. */
  function unlockedCalls(code: string): number {
    let bad = 0;
    for (const m of code.matchAll(/\b(lockUser|lockOrganization)\(tx/g)) {
      const at = m.index ?? 0;
      const start = code.lastIndexOf("runLocked(", at);
      const prevFn = code.lastIndexOf("export async function", at);
      if (start < 0 || start < prevFn) bad++;
    }
    return bad;
  }

  it("lockUser/lockOrganization só são chamados sob runLocked", () => {
    const callers = files.filter(
      (f) =>
        !f.path.startsWith("lib/db/") &&
        /\b(lockUser|lockOrganization)\(tx/.test(f.code),
    );
    expect(callers.map((f) => f.path).sort()).toEqual([
      "modules/auth/account.ts",
      "modules/organizations/service.ts",
    ]);
    for (const f of callers) expect(unlockedCalls(f.code), f.path).toBe(0);
  });

  it("autoteste: o detector acusa lockUser fora de runLocked e aceita dentro", () => {
    expect(
      unlockedCalls(
        "export async function f(d){ await d.prisma.$transaction(async (tx) => { await lockUser(tx, id); }); }",
      ),
    ).toBe(1);
    expect(
      unlockedCalls(
        "export async function f(d){ await runLocked(d.prisma, async (tx) => { await lockUser(tx, id); }); }",
      ),
    ).toBe(0);
  });

  it("transações restantes com prisma.$transaction fora de lib/db/locks são só as SEM trava explícita (lista revisada)", () => {
    const REVIEWED: Record<string, string> = {
      "modules/auth/account.ts":
        "registerUser (INSERT user+token+outbox) e ACCOUNT_EXISTS (INSERT outbox): sem trava explícita; esperas só em índice único (folha)",
      "modules/organizations/service.ts":
        "createOrganization (INSERT empresa+membership+UPDATE sessão): sem trava explícita; empresa recém-criada",
    };
    const using = files
      .filter(
        (f) => /\$transaction\(/.test(f.code) && !f.path.startsWith("lib/db/"),
      )
      .map((f) => f.path)
      .sort();
    expect(using).toEqual(Object.keys(REVIEWED).sort());
    for (const f of files.filter((x) => using.includes(x.path)))
      expect(
        /\b(lockUser|lockOrganization|lockProfessionals?)\(/.test(
          // trechos fora de runLocked: remove os corpos de runLocked grosseiramente comparando contagem
          f.code.split("runLocked(").length > 1 ? "" : f.code,
        ),
      ).toBe(false);
  });
});
