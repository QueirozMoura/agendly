import type { OutboxDeps } from "../../src/jobs/outbox-worker.ts";
import type { PrismaClient } from "../../src/lib/db/client.ts";
import type { Keyring } from "../../src/lib/email/keyring.ts";
import type { EmailMessage, EmailSender } from "../../src/lib/email/sender.ts";
import { enqueueEmail } from "../../src/modules/email/outbox.ts";
import type {
  EmailPayloads,
  EmailTemplateName,
} from "../../src/modules/email/templates.ts";
import { TEST_KEYRING, TestClock } from "./auth-app.ts";
import { TEST_DB, prodPrisma, truncate } from "./databases.ts";

export const BASE_URL = "https://app.exemplo.com";

/** Logger que guarda tudo o que foi registrado (para provar que não há segredo nos logs). */
export class RecordingLogger {
  readonly lines: string[] = [];
  private push(level: string, obj: unknown, msg?: string) {
    this.lines.push(
      JSON.stringify({ level, msg, obj }, (_k, v) =>
        v instanceof Error
          ? { name: v.name, message: v.message, stack: v.stack }
          : v,
      ),
    );
  }
  error(obj: unknown, msg?: string) {
    this.push("error", obj, msg);
  }
  warn(obj: unknown, msg?: string) {
    this.push("warn", obj, msg);
  }
  info(obj: unknown, msg?: string) {
    this.push("info", obj, msg);
  }
  text() {
    return this.lines.join("\n");
  }
}

/** Provedor de e-mail controlável: cada chamada passa por `behavior(n, message)`. */
export class ScriptedSender implements EmailSender {
  readonly calls: EmailMessage[] = [];
  readonly signals: AbortSignal[] = [];
  readonly keys: (string | undefined)[] = [];
  behavior: (
    n: number,
    message: EmailMessage,
    signal: AbortSignal,
  ) => Promise<void> = async () => {};
  async send(
    message: EmailMessage,
    {
      signal,
      idempotencyKey,
    }: { signal: AbortSignal; idempotencyKey?: string },
  ): Promise<void> {
    this.keys.push(idempotencyKey);
    this.calls.push(message);
    this.signals.push(signal);
    await this.behavior(this.calls.length, message, signal);
  }
}

export interface OutboxHarness {
  prisma: PrismaClient;
  clock: TestClock;
  logger: RecordingLogger;
  sender: ScriptedSender;
  deps: OutboxDeps;
  enqueue<T extends EmailTemplateName>(
    template: T,
    payload: EmailPayloads[T],
    opts?: { to?: string; ttlMs?: number; keyring?: Keyring },
  ): Promise<string>;
  close(): Promise<void>;
}

export async function makeOutboxHarness(
  opts: { keyring?: Keyring; config?: OutboxDeps["config"] } = {},
): Promise<OutboxHarness> {
  await truncate(TEST_DB, ["email_outbox"]);
  const prisma = prodPrisma();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  const sender = new ScriptedSender();
  const keyring = opts.keyring ?? TEST_KEYRING;
  const deps: OutboxDeps = {
    prisma,
    keyring,
    sender,
    clock,
    logger,
    baseUrl: BASE_URL,
    random: () => 0.5, // jitter neutro: backoff determinístico
    ...(opts.config ? { config: opts.config } : {}),
  };
  return {
    prisma,
    clock,
    logger,
    sender,
    deps,
    enqueue: (template, payload, o = {}) =>
      prisma.$transaction((tx) =>
        enqueueEmail(
          tx,
          { keyring: o.keyring ?? keyring, clock },
          {
            to: o.to ?? "dest@example.com",
            template,
            payload,
            ttlMs: o.ttlMs ?? 60 * 60 * 1000,
          },
        ),
      ),
    close: () => prisma.$disconnect(),
  };
}

export const TOKEN = "TOKEN-SECRETO-DO-LINK-0123456789abcdefABCDEF";
