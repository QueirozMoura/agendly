import { Writable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.ts";
import { decryptPayload } from "../../src/lib/crypto.ts";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../src/lib/db/client.ts";
import { makeKeyring } from "../../src/lib/email/keyring.ts";
import { buildLoggerOptions } from "../../src/lib/logger.ts";
import type { Clock } from "../../src/lib/time/clock.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB, truncate } from "./databases.ts";

// Chave fixa só de teste (nunca usada fora daqui).
export const TEST_KEYRING = makeKeyring(
  new Map([["t1", Buffer.alloc(32, 9)]]),
  "t1",
);

export const ORIGIN = "http://localhost:5173";
export const PASSWORD = "uma-senha-bem-longa-9X";

export class TestClock implements Clock {
  private current = new Date("2031-03-01T12:00:00.000Z");
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface AuthTestApp {
  app: ReturnType<typeof buildApp>;
  prisma: ReturnType<typeof createPrismaClient>;
  clock: TestClock;
  logs: () => string;
  queries: string[];
  close: () => Promise<void>;
}

export async function makeAuthApp(
  opts: {
    secureCookies?: boolean;
    requireEmailVerification?: boolean;
    /** Proxies confiáveis (nº de saltos ou lista); padrão: nenhum. */
    trustProxy?: number | string[];
    databaseUrlOverride?: string;
    /** Devolve o cliente que a API usa (ex.: com `$extends` para injetar falhas e barreiras). */
    wrapPrisma?: (prisma: PrismaClient) => PrismaClient;
  } = {},
): Promise<AuthTestApp> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const clock = new TestClock();
  const prisma = createPrismaClient(
    opts.databaseUrlOverride ?? databaseUrl(TEST_DB),
    {
      log: [{ emit: "event", level: "query" }],
    },
  );
  const queries: string[] = [];
  (
    prisma as unknown as {
      $on(event: "query", cb: (e: { query: string }) => void): void;
    }
  ).$on("query", (e) => queries.push(e.query));
  const app = buildApp({
    logger: buildLoggerOptions(
      {
        LOG_LEVEL: "debug",
        DATABASE_URL: opts.databaseUrlOverride ?? databaseUrl(TEST_DB),
      },
      stream,
    ),
    clock,
    ...(opts.trustProxy === undefined ? {} : { trustProxy: opts.trustProxy }),
    checkDatabase: async () => {},
    auth: {
      prisma: opts.wrapPrisma ? opts.wrapPrisma(prisma) : prisma,
      keyring: TEST_KEYRING,
      allowedOrigins: [ORIGIN],
      secureCookies: opts.secureCookies ?? false,
      ...(opts.requireEmailVerification === undefined
        ? {}
        : { requireEmailVerification: opts.requireEmailVerification }),
    },
  });
  await app.ready();
  return {
    app,
    prisma,
    clock,
    queries,
    logs: () => lines.join(""),
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export const resetUsers = () =>
  truncate(TEST_DB, ["users", "organizations", "email_outbox"]);

/** Decifra o payload de uma linha da outbox (testes pegam o token do link daqui). */
export function readOutboxPayload(row: {
  id: string;
  payloadEncrypted: Uint8Array | null;
  keyId: string | null;
}) {
  if (!row.payloadEncrypted || !row.keyId) throw new Error("linha sem payload");
  const key = TEST_KEYRING.get(row.keyId) as Buffer;
  return JSON.parse(
    decryptPayload(key, Buffer.from(row.payloadEncrypted), row.id),
  ) as Record<string, string>;
}

/** Token do e-mail mais recente (ainda na fila) de um template para um destinatário. */
export async function latestToken(
  t: AuthTestApp,
  template: "VERIFY_EMAIL" | "RESET_PASSWORD",
  to: string,
): Promise<string> {
  const row = await t.prisma.emailOutbox.findFirstOrThrow({
    where: { template, toEmail: to, status: "PENDING" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], // ids UUID v7 desempatam relógio fixo
  });
  return readOutboxPayload(row).token as string;
}

type Json = Record<string, unknown>;

export function post(
  t: AuthTestApp,
  url: string,
  body: Json | string = {},
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function cookieHeader(res: LightMyRequestResponse): string {
  const c = res.cookies[0];
  return c ? `${c.name}=${c.value}` : "";
}

export async function registerAndLogin(
  t: AuthTestApp,
  email = "ana@example.com",
  password = PASSWORD,
): Promise<{ cookie: string; token: string; res: LightMyRequestResponse }> {
  await post(t, "/api/auth/register", { email, name: "Ana", password });
  const res = await post(t, "/api/auth/login", { email, password });
  return { cookie: cookieHeader(res), token: res.cookies[0]?.value ?? "", res };
}

/** Pede a redefinição pelo endpoint e devolve o token que iria no e-mail. */
export async function requestReset(
  t: AuthTestApp,
  email: string,
): Promise<string> {
  const res = await post(t, "/api/auth/forgot-password", { email });
  if (res.statusCode !== 202)
    throw new Error(`forgot-password: ${res.statusCode}`);
  return latestToken(t, "RESET_PASSWORD", email);
}

/** Barreira para entrelaçar operações de forma determinística nos testes de concorrência. */
export class Gate {
  private open!: () => void;
  private reachedResolve!: () => void;
  readonly reached = new Promise<void>((r) => (this.reachedResolve = r));
  private readonly released = new Promise<void>((r) => (this.open = r));
  active = true;
  async pass(): Promise<void> {
    if (!this.active) return;
    this.reachedResolve();
    await this.released;
  }
  release(): void {
    this.active = false;
    this.open();
  }
}
