import { createPrismaClient, type PrismaClient } from "./client.ts";

export interface Database {
  prisma: PrismaClient;
  /** Readiness: o banco responde dentro do prazo. */
  check: () => Promise<void>;
  /** Idempotente. */
  close: () => Promise<void>;
}

const READY_TIMEOUT_MS = 2000;

/** Única instância de PrismaClient do processo; também atende o /api/ready. */
export function createDatabase(connectionString: string): Database {
  const prisma = createPrismaClient(connectionString);
  let closing: Promise<void> | undefined;
  return {
    prisma,
    check: async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness timeout")),
          READY_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => (closing ??= prisma.$disconnect()),
  };
}
