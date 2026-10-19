import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/lib/db/database.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB } from "../support/databases.ts";

describe("createDatabase (instância única de PrismaClient + readiness)", () => {
  it("check() resolve com o banco no ar e close() é idempotente", async () => {
    const db = createDatabase(databaseUrl(TEST_DB));
    await expect(db.check()).resolves.toBeUndefined();
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });

  it("check() rejeita rapidamente com o banco inacessível", async () => {
    const db = createDatabase("postgresql://u:p@127.0.0.1:1/x");
    const started = Date.now();
    await expect(db.check()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
    await db.close();
  });
});
