import type { FastifyInstance } from "fastify";
import { buildApp as defaultBuildApp, type AppOptions } from "./app.ts";
import type { Env } from "./config/env.ts";
import {
  startBackgroundJobs,
  type BackgroundJobsDeps,
  type JobsHandle,
} from "./jobs/index.ts";
import { createDatabase, type Database } from "./lib/db/database.ts";
import { ConsoleEmailSender, type EmailSender } from "./lib/email/sender.ts";
import {
  buildLoggerOptions,
  collectSecrets,
  formatErrorForLog,
} from "./lib/logger.ts";
import { systemClock } from "./lib/time/clock.ts";

export interface StartDeps {
  createDatabase?: (url: string) => Database;
  buildApp?: (options: AppOptions) => FastifyInstance;
  /** Provedor de e-mail. Padrão: console (só desenvolvimento); produção exige um provedor real (V10). */
  sender?: EmailSender;
  /** Inicia os laços de fundo (outbox e manutenção). Substituível em testes. */
  startJobs?: (deps: BackgroundJobsDeps) => JobsHandle;
  /** Erros secundários (ex.: falha ao fechar recursos depois de uma falha de inicialização). */
  logError?: (err: unknown, message: string) => void;
}

export interface RunningServer {
  app: FastifyInstance;
  /** Idempotente: chamadas concorrentes ou repetidas compartilham o mesmo encerramento. */
  shutdown: () => Promise<void>;
}

/** Fecha tudo o que foi criado, na ordem inversa; tenta cada recurso mesmo que o anterior falhe. */
async function closeAll(
  jobs: JobsHandle | undefined,
  app: FastifyInstance | undefined,
  db: Database,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [
    () => jobs?.stop(),
    () => app?.close(),
    () => db.close(),
  ]) {
    try {
      await close();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "falha ao encerrar recursos");
}

function pickSender(env: Env, injected: EmailSender | undefined): EmailSender {
  if (injected) return injected;
  if (env.NODE_ENV === "production") {
    // O provedor real é escolhido e verificado nas etapas 5 (escolha) e 16 (V10). Falhar na subida é melhor
    // do que "enviar" para o console e perder e-mails de verificação e recuperação em silêncio.
    throw new Error(
      "Nenhum provedor de e-mail configurado para produção (V10).",
    );
  }
  return new ConsoleEmailSender();
}

export async function startServer(
  env: Env,
  deps: StartDeps = {},
): Promise<RunningServer> {
  const secrets = [...collectSecrets(env), ...env.OUTBOX_KEYRING.secrets()];
  const logError =
    deps.logError ??
    ((err, msg) => console.error(formatErrorForLog(err, msg, secrets)));
  const sender = pickSender(env, deps.sender);
  const db = (deps.createDatabase ?? createDatabase)(env.DATABASE_URL);
  let app: FastifyInstance | undefined;
  let jobs: JobsHandle | undefined;

  try {
    app = (deps.buildApp ?? defaultBuildApp)({
      logger: buildLoggerOptions(env),
      checkDatabase: db.check,
      trustProxy: env.TRUST_PROXY,
      auth: {
        prisma: db.prisma,
        keyring: env.OUTBOX_KEYRING,
        allowedOrigins: env.ALLOWED_ORIGINS,
        secureCookies: env.NODE_ENV === "production",
      },
    });
    await app.listen({ host: env.HOST, port: env.PORT });
    jobs = (deps.startJobs ?? startBackgroundJobs)({
      prisma: db.prisma,
      keyring: env.OUTBOX_KEYRING,
      sender,
      clock: systemClock,
      logger: app.log,
      baseUrl: env.APP_BASE_URL,
    });
  } catch (err) {
    try {
      await closeAll(jobs, app, db);
    } catch (cleanupErr) {
      logError(
        cleanupErr,
        "falha ao liberar recursos após erro de inicialização",
      );
    }
    throw err;
  }

  const running = app;
  const runningJobs = jobs;
  let closing: Promise<void> | undefined;
  return {
    app: running,
    shutdown: () => (closing ??= closeAll(runningJobs, running, db)),
  };
}
