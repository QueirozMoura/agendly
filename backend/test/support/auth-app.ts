import { Writable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.ts";
import { createPrismaClient } from "../../src/lib/db/client.ts";
import { buildLoggerOptions } from "../../src/lib/logger.ts";
import type { Clock } from "../../src/lib/time/clock.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB, truncate } from "./databases.ts";

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
  opts: { secureCookies?: boolean; databaseUrlOverride?: string } = {},
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
    checkDatabase: async () => {},
    auth: {
      prisma,
      allowedOrigins: [ORIGIN],
      secureCookies: opts.secureCookies ?? false,
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

export const resetUsers = () => truncate(TEST_DB, ["users", "organizations"]);

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
