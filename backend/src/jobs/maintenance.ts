import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../lib/db/client.ts";
import {
  deleteExpiredAuthTokens,
  deleteExpiredIdempotency,
  deleteExpiredSessions,
  deleteFinishedOutbox,
  type MaintenanceLimits,
} from "../lib/db/locks/maintenance.ts";
import type { Clock } from "../lib/time/clock.ts";
import { SESSION_IDLE_MS } from "../modules/auth/session.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_MAINTENANCE: Omit<MaintenanceLimits, "now"> = {
  batch: 200,
  marginMs: HOUR,
  sessionIdleMs: SESSION_IDLE_MS,
  revokedRetentionMs: 7 * DAY,
  outboxRetentionMs: 7 * DAY,
};

export interface MaintenanceDeps {
  prisma: PrismaClient;
  clock: Clock;
  logger: Pick<FastifyBaseLogger, "info">;
  limits?: Partial<Omit<MaintenanceLimits, "now">>;
}

/** Remove, em lotes pequenos e sem esperar locks, o que já expirou. Devolve as contagens apagadas. */
export async function runMaintenance(deps: MaintenanceDeps) {
  const limits: MaintenanceLimits = {
    ...DEFAULT_MAINTENANCE,
    ...deps.limits,
    now: deps.clock.now(),
  };
  const result = {
    sessions: await deleteExpiredSessions(deps.prisma, limits),
    authTokens: await deleteExpiredAuthTokens(deps.prisma, limits),
    outbox: await deleteFinishedOutbox(deps.prisma, limits),
    idempotency: await deleteExpiredIdempotency(deps.prisma, limits),
  };
  if (
    result.sessions + result.authTokens + result.outbox + result.idempotency >
    0
  ) {
    deps.logger.info(result, "maintenance removed expired rows");
  }
  return result;
}
