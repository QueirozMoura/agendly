import { execFileSync } from "node:child_process";
import pg from "pg";
import { databaseUrl } from "../../tools/database-url.ts";

export const TEST_DB = "agendly_test"; // schema de produção (prisma/)
export const SPIKE_DB = "agendly_spike"; // schema dos spikes (spikes/)

async function ensureDatabases(): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl("postgres") });
  await admin.connect();
  try {
    for (const name of [TEST_DB, SPIKE_DB]) {
      const { rowCount } = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [name],
      );
      if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

function prisma(args: string[], env: Record<string, string> = {}): void {
  execFileSync("npx", ["prisma", ...args], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
}

export default async function setup(): Promise<void> {
  await ensureDatabases();
  prisma(["generate"]);
  prisma(["generate", "--config", "spikes/prisma.config.ts"]);
  prisma(["migrate", "deploy"], { AGENDLY_DB_NAME: TEST_DB });
  prisma(["migrate", "deploy", "--config", "spikes/prisma.config.ts"]);
}
