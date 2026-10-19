// S10 — concorrência no domínio de autenticação (6.5): redefinição × forgot-password × sair de todos os
// dispositivos × verificação de e-mail × criação de sessão × manutenção (SKIP LOCKED), com inícios aleatórios.
// É evidência ESTATÍSTICA (amostragem), não prova de ausência de deadlock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMaintenance } from "../../src/jobs/maintenance.ts";
import { sha256Hex } from "../../src/lib/crypto.ts";
import { createPrismaClient } from "../../src/lib/db/client.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { AppError } from "../../src/lib/errors.ts";
import {
  logoutAllDevices,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  type AccountDeps,
} from "../../src/modules/auth/account.ts";
import {
  createSession,
  findValidSession,
} from "../../src/modules/auth/session.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_KEYRING, TestClock, resetUsers } from "../support/auth-app.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
import { RecordingLogger } from "../support/outbox.ts";

const ITERATIONS = 40;
const prisma = createPrismaClient(databaseUrl(TEST_DB));
const clock = new TestClock();
const deps: AccountDeps = { prisma, outbox: { keyring: TEST_KEYRING, clock } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await resetUsers();
  // deadlock_timeout baixo: se houvesse ciclo de espera, o 40P01 apareceria rápido em vez de após 1 s.
  const c = await rawClient("postgres");
  await c.query(`ALTER DATABASE ${TEST_DB} SET deadlock_timeout = '50ms'`);
  await c.end();
  await prisma.$disconnect(); // reconecta com a configuração nova
});
afterAll(async () => {
  const c = await rawClient("postgres");
  await c.query(`ALTER DATABASE ${TEST_DB} RESET deadlock_timeout`);
  await c.end();
  await prisma.$disconnect();
});

describe("S10 — carga mista aleatória no domínio de autenticação", () => {
  it(`${ITERATIONS} rodadas: zero 40P01/55P03, nenhum erro inesperado e estado final consistente`, async () => {
    const unexpected: unknown[] = [];
    let resets = 0;
    let verifies = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const email = `s10-${i}@example.com`;
      const user = await prisma.user.create({
        data: { email, passwordHash: "hash-antigo", name: "S" },
      });
      const mkToken = async (
        type: "PASSWORD_RESET" | "EMAIL_VERIFICATION",
        raw: string,
      ) =>
        prisma.authToken.create({
          data: {
            userId: user.id,
            type,
            tokenHash: sha256Hex(raw),
            expiresAt: new Date(clock.now().getTime() + 3_600_000),
          },
        });
      const resetRaw = `reset-${i}-${"x".repeat(30)}`;
      const verifyRaw = `verify-${i}-${"y".repeat(30)}`;
      await mkToken("PASSWORD_RESET", resetRaw);
      await mkToken("EMAIL_VERIFICATION", verifyRaw);
      const oldTokens = await Promise.all(
        [0, 1].map(
          async () =>
            (
              await createSession(prisma, {
                userId: user.id,
                credentialsVersion: 0,
                now: clock.now(),
                ip: undefined,
                userAgent: undefined,
              })
            ).token,
        ),
      );

      const ran: Record<string, "ok" | "invalid"> = {};
      const op = (name: string, fn: () => Promise<unknown>) => async () => {
        await sleep(Math.floor(Math.random() * 15));
        try {
          await fn();
          ran[name] = "ok";
        } catch (err) {
          if (
            err instanceof AppError &&
            err.code === "TOKEN_INVALID_OR_EXPIRED"
          )
            ran[name] = "invalid";
          else unexpected.push({ name, kind: classifyDbError(err), err });
        }
      };
      const newSessions: string[] = [];
      const ops = [
        op("reset", () =>
          resetPassword(deps, {
            rawToken: resetRaw,
            newPasswordHash: `hash-novo-${i}`,
          }),
        ),
        op("forgot", () => requestPasswordReset(deps, email)),
        op("logoutAll", () => logoutAllDevices(deps, user.id)),
        op("verify", () => verifyEmail(deps, verifyRaw)),
        op("maintenance", () =>
          runMaintenance({
            prisma,
            clock,
            logger: new RecordingLogger(),
            limits: { revokedRetentionMs: 0, batch: 50 },
          }),
        ),
        op("login", async () => {
          // Como o login: lê a versão e cria a sessão com ela (sem lock do usuário).
          const u = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
            select: { credentialsVersion: true },
          });
          newSessions.push(
            (
              await createSession(prisma, {
                userId: user.id,
                credentialsVersion: u.credentialsVersion,
                now: clock.now(),
                ip: undefined,
                userAgent: undefined,
              })
            ).token,
          );
        }),
      ];
      // Embaralha a ordem de disparo.
      ops.sort(() => Math.random() - 0.5);
      await Promise.all(ops.map((f) => f()));

      // --- estado final consistente ---
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      if (ran.reset === "ok") {
        resets++;
        expect(after.credentialsVersion).toBe(1);
        expect(after.passwordHash).toBe(`hash-novo-${i}`);
        expect(
          await prisma.emailOutbox.count({
            where: { template: "PASSWORD_CHANGED", toEmail: email },
          }),
        ).toBe(1);
        for (const token of oldTokens)
          expect(
            await findValidSession(prisma, token, clock.now()),
          ).toBeUndefined();
        // Sessão criada com a versão antiga (0) — inclusive as criadas durante a redefinição, que o passo 5
        // não viu — nunca vale depois do commit.
        for (const token of newSessions) {
          const row = await prisma.session.findUnique({
            where: { tokenHash: sha256Hex(token) },
          });
          if (row && row.credentialsVersion === 0) {
            expect(
              await findValidSession(prisma, token, clock.now()),
            ).toBeUndefined();
          }
        }
      } else {
        expect(after.credentialsVersion).toBe(0);
        expect(after.passwordHash).toBe("hash-antigo");
        expect(
          await prisma.emailOutbox.count({
            where: { template: "PASSWORD_CHANGED", toEmail: email },
          }),
        ).toBe(0);
      }
      if (ran.verify === "ok") {
        verifies++;
        expect(after.emailVerifiedAt).not.toBeNull();
      }
      // no máximo 1 token de redefinição pendente (forgot invalida os anteriores; reset consome)
      expect(
        await prisma.authToken.count({
          where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
        }),
      ).toBeLessThanOrEqual(1);
      // forgot × reset: se o forgot venceu a corrida, o token antigo não pode ter sido usado com sucesso depois dele
      if (ran.reset === "ok" && ran.forgot === "ok") {
        expect(
          await prisma.authToken.count({
            where: {
              userId: user.id,
              type: "PASSWORD_RESET",
              usedAt: { not: null },
            },
          }),
        ).toBeGreaterThanOrEqual(1);
      }
    }

    expect(unexpected).toEqual([]); // nenhum 40P01, 55P03 ou outro erro
    // A carga realmente exercitou os dois desfechos da corrida reset × forgot.
    expect(resets).toBeGreaterThan(0);
    expect(resets).toBeLessThan(ITERATIONS);
    expect(verifies).toBeGreaterThan(0);
  }, 120_000);
});
