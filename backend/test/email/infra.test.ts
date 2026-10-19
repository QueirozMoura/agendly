// Cifragem (V14), templates, manutenção, laço de fundo, restore sem chave (O14) e provedor em produção.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../../src/jobs/maintenance.ts";
import { runOutboxCycle } from "../../src/jobs/outbox-worker.ts";
import { startJobLoop } from "../../src/jobs/runner.ts";
import {
  DecryptError,
  decryptPayload,
  encryptPayload,
} from "../../src/lib/crypto.ts";
import { makeKeyring } from "../../src/lib/email/keyring.ts";
import { loadEnv } from "../../src/config/env.ts";
import { renderEmail } from "../../src/modules/email/templates.ts";
import { startServer } from "../../src/start.ts";
import { TEST_KEYRING, TestClock } from "../support/auth-app.ts";
import {
  TEST_DB,
  prodPrisma,
  rawClient,
  truncate,
} from "../support/databases.ts";
import { pgEnv } from "../support/pg-cli.ts";
import {
  BASE_URL,
  RecordingLogger,
  TOKEN,
  makeOutboxHarness,
} from "../support/outbox.ts";

const KEY = Buffer.alloc(32, 3);

describe("V14 — AES-256-GCM do módulo nativo do Node", () => {
  it("cifra e decifra; IV aleatório (mesmo texto, saídas diferentes); formato iv|tag|dados", () => {
    const a = encryptPayload(KEY, "segredo", "id-1");
    const b = encryptPayload(KEY, "segredo", "id-1");
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(12 + 16 + "segredo".length);
    expect(a.includes(Buffer.from("segredo"))).toBe(false);
    expect(decryptPayload(KEY, a, "id-1")).toBe("segredo");
  });

  it("falha com chave errada, AAD diferente, dado adulterado ou truncado", () => {
    const data = encryptPayload(KEY, "segredo", "id-1");
    expect(() => decryptPayload(Buffer.alloc(32, 4), data, "id-1")).toThrow(
      DecryptError,
    );
    expect(() => decryptPayload(KEY, data, "id-2")).toThrow(DecryptError);
    const t = Buffer.from(data);
    t[20]! ^= 1;
    expect(() => decryptPayload(KEY, t, "id-1")).toThrow(DecryptError);
    expect(() => decryptPayload(KEY, data.subarray(0, 10), "id-1")).toThrow(
      DecryptError,
    );
  });
});

describe("templates", () => {
  it("links usam o fragmento (#token=), nunca query string, e o HTML escapa o nome", () => {
    const v = renderEmail(
      "VERIFY_EMAIL",
      { name: `<b>"Ana"</b>`, token: TOKEN },
      BASE_URL,
    );
    expect(v.text).toContain(`${BASE_URL}/verificar-email#token=${TOKEN}`);
    expect(v.html).toContain(
      `href="${BASE_URL}/verificar-email#token=${TOKEN}"`,
    );
    expect(v.html).not.toContain("<b>");
    expect(v.html).toContain("&#60;b&#62;");
    const r = renderEmail("RESET_PASSWORD", { token: TOKEN }, BASE_URL);
    expect(r.text).toContain(`${BASE_URL}/redefinir-senha#token=${TOKEN}`);
    expect(`${v.text}${r.text}`).not.toContain("?token=");
  });

  it("avisos sem token (PASSWORD_CHANGED, ACCOUNT_EXISTS) não carregam token e rejeitam payload extra", () => {
    expect(renderEmail("PASSWORD_CHANGED", {}, BASE_URL).text).toContain(
      "/recuperar-senha",
    );
    expect(renderEmail("ACCOUNT_EXISTS", {}, BASE_URL).text).toContain(
      "/entrar",
    );
    expect(() =>
      renderEmail("PASSWORD_CHANGED", { token: "x" }, BASE_URL),
    ).toThrow();
    expect(() => renderEmail("RESET_PASSWORD", {}, BASE_URL)).toThrow();
  });
});

describe("manutenção em lotes com SKIP LOCKED", () => {
  const prisma = prodPrisma();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  beforeEach(() => truncate(TEST_DB, ["users", "email_outbox"]));
  afterEach(async () => {
    await prisma.$disconnect();
  });
  const DAY = 24 * 60 * 60 * 1000;

  async function seed() {
    const user = await prisma.user.create({
      data: { email: "m@example.com", passwordHash: "h", name: "M" },
    });
    const now = clock.now();
    const s = (tokenHash: string, d: object) =>
      prisma.session.create({
        data: {
          userId: user.id,
          tokenHash,
          credentialsVersion: 0,
          expiresAt: new Date(+now + 30 * DAY),
          lastSeenAt: now,
          ...d,
        },
      });
    await s("ativa", {});
    await s("expirada", { expiresAt: new Date(+now - 2 * DAY) });
    await s("ociosa", { lastSeenAt: new Date(+now - 9 * DAY) });
    await s("revogada-antiga", { revokedAt: new Date(+now - 8 * DAY) });
    await s("revogada-recente", { revokedAt: new Date(+now - 1 * DAY) });
    const t = (tokenHash: string, d: object) =>
      prisma.authToken.create({
        data: {
          userId: user.id,
          type: "PASSWORD_RESET",
          tokenHash,
          expiresAt: new Date(+now + DAY),
          ...d,
        },
      });
    await t("tok-valido", {});
    await t("tok-expirado", { expiresAt: new Date(+now - 2 * DAY) });
    await t("tok-usado-antigo", { usedAt: new Date(+now - 2 * DAY) });
    return user;
  }

  it("remove só o que já venceu (com folga) e mantém o que ainda pode estar em uso", async () => {
    await seed();
    const old = new Date(+clock.now() - 8 * DAY);
    await prisma.emailOutbox.create({
      data: {
        toEmail: "a@x.com",
        template: "ACCOUNT_EXISTS",
        status: "SENT",
        nextAttemptAt: old,
        notAfter: old,
        createdAt: old,
      },
    });
    await prisma.emailOutbox.create({
      data: {
        toEmail: "b@x.com",
        template: "ACCOUNT_EXISTS",
        status: "DEAD",
        deadReason: "EXPIRED",
        nextAttemptAt: clock.now(),
        notAfter: clock.now(),
        createdAt: clock.now(),
      },
    });

    const r = await runMaintenance({ prisma, clock, logger });
    expect(r).toEqual({ sessions: 3, authTokens: 2, outbox: 1 });
    expect(
      (await prisma.session.findMany()).map((s) => s.tokenHash).sort(),
    ).toEqual(["ativa", "revogada-recente"]);
    expect((await prisma.authToken.findMany()).map((t) => t.tokenHash)).toEqual(
      ["tok-valido"],
    );
    expect(await prisma.emailOutbox.count()).toBe(1);
  });

  it("opera em lotes pequenos", async () => {
    await seed();
    const r = await runMaintenance({
      prisma,
      clock,
      logger,
      limits: { batch: 1 },
    });
    expect(r.sessions).toBe(1);
    expect(await prisma.session.count()).toBe(4);
  });

  it("não espera locks: linha travada por outra transação é pulada e sobrevive", async () => {
    await seed();
    const c = await rawClient(TEST_DB);
    await c.query("BEGIN");
    await c.query(
      "SELECT id FROM sessions WHERE token_hash = 'expirada' FOR UPDATE",
    );
    const started = Date.now();
    const r = await runMaintenance({ prisma, clock, logger });
    expect(Date.now() - started).toBeLessThan(1500);
    await c.query("ROLLBACK");
    await c.end();
    expect(r.sessions).toBe(2);
    expect(
      (await prisma.session.findMany({ where: { tokenHash: "expirada" } }))
        .length,
    ).toBe(1);
  });
});

describe("laço de fundo", () => {
  it("ciclos não se sobrepõem, erro não encerra o laço e stop() espera o ciclo em andamento", async () => {
    const errors: unknown[] = [];
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const loop = startJobLoop({
      intervalMs: 5,
      logger: { error: (o: unknown) => void errors.push(o) },
      run: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        if (calls === 2) throw new Error("falha do ciclo");
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    await loop.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(after); // parou de agendar
    expect(running).toBe(0); // stop() esperou o ciclo atual
    expect(maxRunning).toBe(1);
    expect(calls).toBeGreaterThan(3); // continuou depois do erro
    expect(errors).toHaveLength(1);
  });
});

describe("O14 — restaurar um dump do banco SEM a chave", () => {
  const RESTORED = "agendly_restore_o14";

  it("linhas pendentes viram DEAD, nada quebra e nenhum token vaza em log", async () => {
    const h = await makeOutboxHarness();
    await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "a@example.com" },
    );
    await h.enqueue(
      "VERIFY_EMAIL",
      { name: "Ana", token: TOKEN },
      { to: "b@example.com" },
    );
    const dump = execFileSync("pg_dump", ["--no-owner"], {
      env: pgEnv(TEST_DB),
      encoding: "utf8",
      maxBuffer: 50 << 20,
    });
    await h.close();

    const admin = await rawClient("postgres");
    await admin.query(`DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${RESTORED}`);
    await admin.end();
    try {
      execFileSync("psql", ["--quiet", "--set", "ON_ERROR_STOP=1"], {
        env: pgEnv(RESTORED),
        input: dump,
        encoding: "utf8",
      });
      const restored = (
        await import("../../src/lib/db/client.ts")
      ).createPrismaClient(
        (await import("../../tools/database-url.ts")).databaseUrl(RESTORED),
      );
      const logger = new RecordingLogger();
      const otherEnv = makeKeyring(
        new Map([["outro-ambiente", Buffer.alloc(32, 99)]]),
        "outro-ambiente",
      );
      const sender = { calls: 0, send: async () => void sender.calls++ };
      const processed = await runOutboxCycle({
        prisma: restored,
        keyring: otherEnv,
        sender,
        clock: new TestClock(),
        logger,
        baseUrl: BASE_URL,
      });
      const rows = await restored.emailOutbox.findMany();
      await restored.$disconnect();
      expect(processed).toBe(2);
      expect(sender.calls).toBe(0);
      expect(
        rows.every(
          (r) =>
            r.status === "DEAD" &&
            r.deadReason === "KEY_UNAVAILABLE" &&
            r.payloadEncrypted === null,
        ),
      ).toBe(true);
      expect(`${logger.text()}${JSON.stringify(rows)}`).not.toContain(TOKEN);
    } finally {
      const drop = await rawClient("postgres");
      await drop.query(`DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
      await drop.end();
    }
  });
});

describe("provedor de e-mail em produção", () => {
  it("startServer em produção sem provedor injetado falha ANTES de abrir porta, sem vazar chaves", async () => {
    const env = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      ALLOWED_ORIGINS: "https://app.exemplo.com",
      OUTBOX_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}`,
      OUTBOX_CURRENT_KEY_ID: "k1",
    });
    const err = await startServer({ ...env, PORT: 0 }).catch((e) => e);
    expect(String(err.message)).toContain("provedor de e-mail");
    expect(String(err.message)).not.toContain(
      Buffer.alloc(32, 5).toString("base64"),
    );
  });
});

void TEST_KEYRING;
