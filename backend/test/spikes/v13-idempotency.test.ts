// V13 — INSERT ... ON CONFLICT DO UPDATE ... WHERE: re-reivindicação atômica de chave vencida.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  SPIKE_DB,
  rawClient,
  spikePrisma,
  truncate,
} from "../support/databases.ts";

const prisma = spikePrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => truncate(SPIKE_DB, ["orgs", "idempotency_records"]));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reivindica a chave: devolve a linha se inseriu OU re-reivindicou uma vencida; nenhuma linha se vigente.
const CLAIM = `
  INSERT INTO idempotency_records (id, organization_id, scope, key, request_hash, claimed_by, created_at, expires_at)
  VALUES (gen_random_uuid(), $1, 'appointments.create', $2, $3, $4, now(), now() + interval '24 hours')
  ON CONFLICT (organization_id, scope, key) DO UPDATE
    SET request_hash = EXCLUDED.request_hash, claimed_by = EXCLUDED.claimed_by,
        created_at = now(), expires_at = EXCLUDED.expires_at, response_status = NULL
    WHERE idempotency_records.expires_at <= now()
  RETURNING claimed_by`;

async function setup() {
  const org = await prisma.org.create({ data: { name: "A" } });
  return { orgId: org.id, key: "k-1" };
}

describe("V13 ON CONFLICT DO UPDATE ... WHERE", () => {
  it("chave nova: insere e devolve a linha", async () => {
    const { orgId, key } = await setup();
    const c = await rawClient(SPIKE_DB);
    const r = await c.query(CLAIM, [orgId, key, "h1", "T1"]);
    await c.end();
    expect(r.rows).toEqual([{ claimed_by: "T1" }]);
  });

  it("chave vigente: não atualiza e não devolve linha (=> comparar request_hash)", async () => {
    const { orgId, key } = await setup();
    const c = await rawClient(SPIKE_DB);
    await c.query(CLAIM, [orgId, key, "h1", "T1"]);
    const r = await c.query(CLAIM, [orgId, key, "h2", "T2"]);
    const stored = await c.query(
      "SELECT request_hash FROM idempotency_records",
    );
    await c.end();
    expect(r.rowCount).toBe(0);
    expect(stored.rows[0].request_hash).toBe("h1");
  });

  it("chave vencida: é re-reivindicada atomicamente", async () => {
    const { orgId, key } = await setup();
    const c = await rawClient(SPIKE_DB);
    await c.query(CLAIM, [orgId, key, "h1", "T1"]);
    await c.query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 minute'",
    );
    const r = await c.query(CLAIM, [orgId, key, "h2", "T2"]);
    const stored = await c.query(
      "SELECT request_hash FROM idempotency_records",
    );
    await c.end();
    expect(r.rows).toEqual([{ claimed_by: "T2" }]);
    expect(stored.rows[0].request_hash).toBe("h2");
  });

  it("duas transações com chave NOVA: a segunda ESPERA o commit da primeira e então não reivindica", async () => {
    const { orgId, key } = await setup();
    const a = await rawClient(SPIKE_DB);
    const b = await rawClient(SPIKE_DB);
    await a.query("BEGIN");
    await b.query("BEGIN");
    const ra = await a.query(CLAIM, [orgId, key, "h1", "A"]);
    let bDone = false;
    const pb = b.query(CLAIM, [orgId, key, "h1", "B"]).then((r) => {
      bDone = true;
      return r;
    });
    await sleep(300);
    expect(bDone).toBe(false); // bloqueada no índice único até A decidir
    await a.query("COMMIT");
    const rb = await pb;
    await b.query("COMMIT");
    await a.end();
    await b.end();
    expect(ra.rows).toEqual([{ claimed_by: "A" }]);
    expect(rb.rowCount).toBe(0); // viu a linha vigente de A (READ COMMITTED): cai no replay/409
  });

  it("rollback da primeira: a segunda passa a ser a dona da chave", async () => {
    const { orgId, key } = await setup();
    const a = await rawClient(SPIKE_DB);
    const b = await rawClient(SPIKE_DB);
    await a.query("BEGIN");
    await b.query("BEGIN");
    await a.query(CLAIM, [orgId, key, "h1", "A"]);
    const pb = b.query(CLAIM, [orgId, key, "h1", "B"]);
    await sleep(200);
    await a.query("ROLLBACK");
    const rb = await pb;
    await b.query("COMMIT");
    await a.end();
    await b.end();
    expect(rb.rows).toEqual([{ claimed_by: "B" }]);
  });

  it("duas transações re-reivindicando a MESMA chave vencida: exatamente uma vence", async () => {
    const { orgId, key } = await setup();
    const seed = await rawClient(SPIKE_DB);
    await seed.query(CLAIM, [orgId, key, "h0", "OLD"]);
    await seed.query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 minute'",
    );
    await seed.end();

    const a = await rawClient(SPIKE_DB);
    const b = await rawClient(SPIKE_DB);
    await a.query("BEGIN");
    await b.query("BEGIN");
    const ra = await a.query(CLAIM, [orgId, key, "h1", "A"]);
    const pb = b.query(CLAIM, [orgId, key, "h1", "B"]);
    await sleep(200);
    await a.query("COMMIT");
    const rb = await pb; // reavalia o WHERE sobre a versão nova da linha (expires_at no futuro)
    await b.query("COMMIT");
    await a.end();
    await b.end();
    expect(ra.rows).toEqual([{ claimed_by: "A" }]);
    expect(rb.rowCount).toBe(0);
  });

  it("limpeza concorrente (DELETE ... SKIP LOCKED) não remove linha vigente nem de transação aberta", async () => {
    const { orgId, key } = await setup();
    const a = await rawClient(SPIKE_DB);
    const cleaner = await rawClient(SPIKE_DB);
    await a.query("BEGIN");
    await a.query(CLAIM, [orgId, key, "h1", "A"]);
    const del = await cleaner.query(
      `DELETE FROM idempotency_records WHERE id IN (
         SELECT id FROM idempotency_records WHERE expires_at < now() - interval '1 hour'
         FOR UPDATE SKIP LOCKED LIMIT 100)`,
    );
    await a.query("COMMIT");
    const { rows } = await cleaner.query(
      "SELECT count(*)::int AS n FROM idempotency_records",
    );
    await a.end();
    await cleaner.end();
    expect(del.rowCount).toBe(0);
    expect(rows[0].n).toBe(1);
  });
});
