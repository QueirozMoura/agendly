// V6 (SQLSTATE no Prisma), V15 (FOR NO KEY UPDATE via $queryRaw, timeouts, 40P01/55P03, FOR KEY SHARE).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { classifyDbError, sqlState } from "../../src/lib/db/errors.ts";
import {
  SPIKE_DB,
  TEST_DB,
  prodPrisma,
  rawClient,
  spikePrisma,
  truncate,
} from "../support/databases.ts";
import { appointmentData, seedOrg } from "../support/spike-fixtures.ts";

const prisma = spikePrisma();
const prod = prodPrisma();
afterAll(async () => {
  await prisma.$disconnect();
  await prod.$disconnect();
});
beforeEach(async () => {
  await truncate(SPIKE_DB, ["orgs"]);
  await truncate(TEST_DB, ["users"]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("V6 — SQLSTATE no Prisma 7 (driver adapter pg)", () => {
  it("23P01 (ORM => P2039; raw => P2010): SQLSTATE em meta.driverAdapterError.cause.originalCode", async () => {
    const s = await seedOrg(prisma);
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    const viaOrm = await prisma.appointment
      .create({ data: appointmentData(s, 10) })
      .catch((e) => e);
    expect(viaOrm.code).toBe("P2039");
    expect(sqlState(viaOrm)).toBe("23P01");
    const viaRaw =
      await prisma.$executeRaw`INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until, duration_minutes_snapshot, buffer_minutes_snapshot) SELECT gen_random_uuid(), organization_id, professional_id, service_id, customer_id, starts_at, ends_at, blocked_until, duration_minutes_snapshot, buffer_minutes_snapshot FROM appointments`.catch(
        (e) => e,
      );
    expect(viaRaw.code).toBe("P2010");
    expect(sqlState(viaRaw)).toBe("23P01");
  });

  it("23505: ORM => P2002; raw => P2010; ambos classificados como unique_violation", async () => {
    const org = await prisma.org.create({ data: { name: "A" } });
    const viaOrm = await prisma.org
      .create({ data: { id: org.id, name: "dup" } })
      .catch((e) => e);
    const viaRaw =
      await prisma.$executeRaw`INSERT INTO orgs (id, name) VALUES (${org.id}::uuid, 'dup')`.catch(
        (e) => e,
      );
    expect(viaOrm.code).toBe("P2002");
    expect(viaRaw.code).toBe("P2010");
    expect([sqlState(viaOrm), sqlState(viaRaw)]).toEqual(["23505", "23505"]);
    expect([classifyDbError(viaOrm), classifyDbError(viaRaw)]).toEqual([
      "unique_violation",
      "unique_violation",
    ]);
  });

  it("FK com RESTRICT: delete pelo ORM => P2003 e SQLSTATE 23001 (não 23503); ambos classificados", async () => {
    const s = await seedOrg(prisma);
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    const err = await prisma.professional
      .delete({ where: { id: s.professional.id } })
      .catch((e) => e);
    expect(err.code).toBe("P2003");
    expect(sqlState(err)).toBe("23001");
    expect(classifyDbError(err)).toBe("foreign_key_violation");
  });

  it("23514 (CHECK) via ORM é classificado como check_violation", async () => {
    const s = await seedOrg(prisma);
    const d = appointmentData(s, 0);
    const err = await prisma.appointment
      .create({ data: { ...d, endsAt: new Date(+d.endsAt + 1000) } })
      .catch((e) => e);
    expect(classifyDbError(err)).toBe("check_violation");
  });

  it("40P01 (deadlock) provocado de forma determinística chega com SQLSTATE", async () => {
    const s = await seedOrg(prisma);
    const other = await prisma.professional.create({
      data: { organizationId: s.org.id, name: "q" },
    });
    const lock = (id: string) =>
      `SELECT id FROM professionals WHERE id = '${id}' FOR NO KEY UPDATE`;
    const a = await rawClient(SPIKE_DB);
    const b = await rawClient(SPIKE_DB);
    await a.query("SET deadlock_timeout = '100ms'");
    await b.query("SET deadlock_timeout = '100ms'");
    await a.query("BEGIN");
    await b.query("BEGIN");
    await a.query(lock(s.professional.id));
    await b.query(lock(other.id));
    const results = await Promise.allSettled([
      a.query(lock(other.id)),
      b.query(lock(s.professional.id)),
    ]);
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    await a.end();
    await b.end();
    const codes = results
      .map((r) =>
        r.status === "rejected" ? (r.reason as { code: string }).code : "ok",
      )
      .sort();
    expect(codes).toEqual(["40P01", "ok"]);
  });

  it("55P03 (lock_timeout) via ORM/$queryRaw em transação interativa chega com SQLSTATE", async () => {
    const s = await seedOrg(prisma);
    const holder = await rawClient(SPIKE_DB);
    await holder.query("BEGIN");
    await holder.query(
      `SELECT id FROM professionals WHERE id = '${s.professional.id}' FOR NO KEY UPDATE`,
    );
    const err = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
        await tx.$queryRaw`SELECT id FROM professionals WHERE id = ${s.professional.id}::uuid FOR NO KEY UPDATE`;
      })
      .catch((e) => e);
    await holder.query("ROLLBACK");
    await holder.end();
    expect(sqlState(err)).toBe("55P03");
    expect(classifyDbError(err)).toBe("lock_timeout");
  });
});

describe("V15 — locks de linha via $queryRaw em transação interativa", () => {
  const lockPro = (
    tx: Pick<typeof prisma, "$queryRaw">,
    orgId: string,
    id: string,
  ) =>
    tx.$queryRaw`SELECT id FROM professionals WHERE organization_id = ${orgId}::uuid AND id = ${id}::uuid FOR NO KEY UPDATE`;

  it("FOR NO KEY UPDATE via $queryRaw serializa transações do mesmo profissional", async () => {
    const s = await seedOrg(prisma);
    const events: string[] = [];
    const t1 = prisma.$transaction(async (tx) => {
      await lockPro(tx, s.org.id, s.professional.id);
      events.push("t1 lock");
      await sleep(400);
      events.push("t1 commit");
    });
    await sleep(100);
    const t2 = prisma.$transaction(async (tx) => {
      await lockPro(tx, s.org.id, s.professional.id);
      events.push("t2 lock");
    });
    await Promise.all([t1, t2]);
    expect(events).toEqual(["t1 lock", "t1 commit", "t2 lock"]);
  });

  it("profissionais diferentes não se bloqueiam (L3)", async () => {
    const s = await seedOrg(prisma);
    const other = await prisma.professional.create({
      data: { organizationId: s.org.id, name: "q" },
    });
    const started = Date.now();
    await Promise.all([
      prisma.$transaction(async (tx) => {
        await lockPro(tx, s.org.id, s.professional.id);
        await sleep(400);
      }),
      prisma.$transaction(async (tx) => {
        await lockPro(tx, s.org.id, other.id);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("8b. N criações paralelas COM o lock do profissional: 1 sucesso e N-1 23P01 (sem 40P01), rápido", async () => {
    const s = await seedOrg(prisma);
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        prisma.$transaction(async (tx) => {
          await lockPro(tx, s.org.id, s.professional.id);
          return tx.appointment.create({ data: appointmentData(s, 0) });
        }),
      ),
    );
    expect(Date.now() - started).toBeLessThan(900); // sem esperar o deadlock_timeout de 1 s
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const kinds = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => classifyDbError(r.reason));
    expect(kinds).toEqual(Array(7).fill("exclusion_violation"));
  });

  it("transação interativa que excede o timeout falha com P2028 (padrão medido à parte: 5 s)", async () => {
    const err = await prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await sleep(300);
        },
        { timeout: 100 },
      )
      .catch((e) => e);
    expect(err.code).toBe("P2028");
  });

  it("SET LOCAL lock_timeout vale só dentro da transação", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1234ms'`;
      const [inside] = await tx.$queryRaw<
        { lock_timeout: string }[]
      >`SHOW lock_timeout`;
      expect(inside?.lock_timeout).toBe("1234ms");
    });
    const [after] = await prisma.$queryRaw<
      { lock_timeout: string }[]
    >`SHOW lock_timeout`;
    expect(after?.lock_timeout).toBe("0");
  });

  it("isolamento padrão é READ COMMITTED", async () => {
    const [row] = await prisma.$queryRaw<
      { transaction_isolation: string }[]
    >`SHOW transaction_isolation`;
    expect(row?.transaction_isolation).toBe("read committed");
  });

  it("FOR NO KEY UPDATE no pai NÃO bloqueia INSERT de filho (FOR KEY SHARE); FOR UPDATE bloqueia", async () => {
    const u = await prod.user.create({
      data: { email: "a@example.com", passwordHash: "h", name: "A" },
    });
    const parent = await rawClient(TEST_DB);
    const child = await rawClient(TEST_DB);
    await child.query("SET lock_timeout = '300ms'");
    const insert = () =>
      child.query(
        `INSERT INTO sessions (id, user_id, token_hash, credentials_version, expires_at, updated_at)
         VALUES (gen_random_uuid(), $1, gen_random_uuid()::text, 0, now(), now())`,
        [u.id],
      );

    await parent.query("BEGIN");
    await parent.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [
      u.id,
    ]);
    await insert(); // não espera: compatível com FOR KEY SHARE
    await parent.query("ROLLBACK");

    await parent.query("BEGIN");
    await parent.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [u.id]);
    const blocked = await insert().catch((e) => e);
    await parent.query("ROLLBACK");

    await parent.end();
    await child.end();
    expect(blocked.code).toBe("55P03");
  });
});
