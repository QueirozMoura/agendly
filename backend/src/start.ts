import type { FastifyInstance } from "fastify";
import { buildApp as defaultBuildApp, type AppOptions } from "./app.ts";
import type { Env } from "./config/env.ts";
import { createDatabase, type Database } from "./lib/db/database.ts";
import {
  buildLoggerOptions,
  collectSecrets,
  formatErrorForLog,
} from "./lib/logger.ts";

export interface StartDeps {
  createDatabase?: (url: string) => Database;
  buildApp?: (options: AppOptions) => FastifyInstance;
  /** Erros secundários (ex.: falha ao fechar recursos depois de uma falha de inicialização). */
  logError?: (err: unknown, message: string) => void;
}

export interface RunningServer {
  app: FastifyInstance;
  /** Idempotente: chamadas concorrentes ou repetidas compartilham o mesmo encerramento. */
  shutdown: () => Promise<void>;
}

/** Fecha tudo o que foi criado; tenta cada recurso mesmo que o anterior falhe. */
async function closeAll(
  app: FastifyInstance | undefined,
  db: Database,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await app?.close();
  } catch (err) {
    errors.push(err);
  }
  try {
    await db.close();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "falha ao encerrar recursos");
}

export async function startServer(
  env: Env,
  deps: StartDeps = {},
): Promise<RunningServer> {
  const secrets = collectSecrets(env);
  const logError =
    deps.logError ??
    ((err, msg) => console.error(formatErrorForLog(err, msg, secrets)));
  const db = (deps.createDatabase ?? createDatabase)(env.DATABASE_URL);
  let app: FastifyInstance | undefined;

  try {
    app = (deps.buildApp ?? defaultBuildApp)({
      logger: buildLoggerOptions(env),
      checkDatabase: db.check,
      trustProxy: env.TRUST_PROXY,
      auth: {
        prisma: db.prisma,
        allowedOrigins: env.ALLOWED_ORIGINS,
        secureCookies: env.NODE_ENV === "production",
      },
    });
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    try {
      await closeAll(app, db);
    } catch (cleanupErr) {
      logError(
        cleanupErr,
        "falha ao liberar recursos após erro de inicialização",
      );
    }
    throw err;
  }

  const running = app;
  let closing: Promise<void> | undefined;
  return { app: running, shutdown: () => (closing ??= closeAll(running, db)) };
}
