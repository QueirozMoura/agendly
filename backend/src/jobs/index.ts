import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../lib/db/client.ts";
import type { Keyring } from "../lib/email/keyring.ts";
import type { EmailSender } from "../lib/email/sender.ts";
import type { Clock } from "../lib/time/clock.ts";
import { runMaintenance } from "./maintenance.ts";
import { runOutboxCycle } from "./outbox-worker.ts";
import { startJobLoop, type JobsHandle } from "./runner.ts";

export interface BackgroundJobsDeps {
  prisma: PrismaClient;
  keyring: Keyring;
  sender: EmailSender;
  clock: Clock;
  logger: FastifyBaseLogger;
  baseUrl: string;
}

const OUTBOX_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60_000;

/** Laço da outbox + laço de manutenção, no mesmo processo da API (3.6). */
export function startBackgroundJobs(deps: BackgroundJobsDeps): JobsHandle {
  const loops = [
    startJobLoop({
      intervalMs: OUTBOX_INTERVAL_MS,
      logger: deps.logger,
      run: async () => {
        await runOutboxCycle(deps);
      },
    }),
    startJobLoop({
      intervalMs: MAINTENANCE_INTERVAL_MS,
      logger: deps.logger,
      run: async () => {
        await runMaintenance(deps);
      },
    }),
  ];
  return {
    stop: async () => void (await Promise.all(loops.map((l) => l.stop()))),
  };
}

export type { JobsHandle };
