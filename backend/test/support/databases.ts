import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient as SpikeClient } from "../../spikes/generated/client.ts";
import { createPrismaClient } from "../../src/lib/db/client.ts";
import { databaseUrl } from "../../tools/database-url.ts";

export const TEST_DB = "agendly_test";
export const SPIKE_DB = "agendly_spike";

export const prodPrisma = () => createPrismaClient(databaseUrl(TEST_DB));
export const spikePrisma = () =>
  new SpikeClient({
    adapter: new PrismaPg({ connectionString: databaseUrl(SPIKE_DB) }),
  });

/** Conexão pg crua: para SQL que o Prisma não expressa (EXCLUDE, locks, SET LOCAL, deadlocks). */
export async function rawClient(db: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl(db) });
  await client.connect();
  return client;
}

export async function truncate(db: string, tables: string[]): Promise<void> {
  const c = await rawClient(db);
  try {
    await c.query(
      `TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await c.end();
  }
}
