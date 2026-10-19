// V4 (SQL manual sem drift), V5 (btree_gist com uuid), V8 (coerência de blocked_until) e a
// exclusão de 6.1 com os testes 1–9 da especificação.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { databaseUrl } from "../../tools/database-url.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import {
  SPIKE_DB,
  rawClient,
  spikePrisma,
  truncate,
} from "../support/databases.ts";
import { appointmentData, seedOrg } from "../support/spike-fixtures.ts";

const prisma = spikePrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => truncate(SPIKE_DB, ["orgs"]));

const backendDir = new URL("../..", import.meta.url);
const prismaCli = (args: string[]) =>
  execFileSync("npx", ["prisma", ...args], {
    cwd: backendDir,
    encoding: "utf8",
  });
const kind = (e: unknown) => classifyDbError(e);

describe("V5 btree_gist com uuid", () => {
  it("extensão instalada e usada pela EXCLUDE sobre colunas uuid", async () => {
    const c = await rawClient(SPIKE_DB);
    const ext = await c.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    const def = await c.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointments_no_overlap'`,
    );
    await c.end();
    expect(ext.rows).toHaveLength(1);
    expect(def.rows[0].def).toContain(
      "EXCLUDE USING gist (organization_id WITH =, professional_id WITH =",
    );
    expect(def.rows[0].def).toContain(
      "WHERE ((status = ANY (ARRAY['SCHEDULED'",
    );
  });
});

describe("6.1 — constraint de exclusão (testes 1–9 da especificação)", () => {
  it("1. dois ativos sobrepostos no mesmo profissional => 23P01", async () => {
    const s = await seedOrg(prisma);
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    await expect(
      prisma.appointment.create({ data: appointmentData(s, 10) }),
    ).rejects.toSatisfy((e) => kind(e) === "exclusion_violation");
  });

  it("2. encostados ([)) passam", async () => {
    const s = await seedOrg(prisma);
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    await prisma.appointment.create({ data: appointmentData(s, 30) });
    await prisma.appointment.create({ data: appointmentData(s, -30) });
  });

  it("3. mesmo horário, profissionais diferentes passam", async () => {
    const s = await seedOrg(prisma);
    const other = await prisma.professional.create({
      data: { organizationId: s.org.id, name: "q" },
    });
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    await prisma.appointment.create({
      data: { ...appointmentData(s, 0), professionalId: other.id },
    });
  });

  it("4. CANCELLED/NO_SHOW/COMPLETED liberam a faixa; reativar o primeiro depois falha", async () => {
    const s = await seedOrg(prisma);
    const first = await prisma.appointment.create({
      data: appointmentData(s, 0),
    });
    await prisma.appointment.update({
      where: { id: first.id },
      data: { status: "CANCELLED" },
    });
    await prisma.appointment.create({ data: appointmentData(s, 0) });
    await expect(
      prisma.appointment.update({
        where: { id: first.id },
        data: { status: "SCHEDULED" },
      }),
    ).rejects.toSatisfy((e) => kind(e) === "exclusion_violation");
    for (const status of ["NO_SHOW", "COMPLETED"] as const) {
      const x = await prisma.appointment.create({
        data: appointmentData(s, 600),
      });
      await prisma.appointment.update({
        where: { id: x.id },
        data: { status },
      });
      await prisma.appointment
        .create({ data: appointmentData(s, 600) })
        .then((a) =>
          prisma.appointment.update({
            where: { id: a.id },
            data: { status: "CANCELLED" },
          }),
        );
    }
  });

  it("5. sobreposição só dentro do buffer falha; fora do buffer passa", async () => {
    const s = await seedOrg(prisma);
    await prisma.appointment.create({ data: appointmentData(s, 0, 30, 15) }); // ocupa [0, 45)
    await expect(
      prisma.appointment.create({ data: appointmentData(s, 35) }),
    ).rejects.toSatisfy((e) => kind(e) === "exclusion_violation");
    await prisma.appointment.create({ data: appointmentData(s, 45) });
  });

  it("6. UPDATE (remarcar) não conflita consigo mesmo; para cima de outro ativo falha", async () => {
    const s = await seedOrg(prisma);
    const a = await prisma.appointment.create({ data: appointmentData(s, 0) });
    await prisma.appointment.create({ data: appointmentData(s, 60) });
    const { startsAt, endsAt, blockedUntil } = appointmentData(s, 10);
    await prisma.appointment.update({
      where: { id: a.id },
      data: { startsAt, endsAt, blockedUntil },
    });
    const moved = appointmentData(s, 70);
    await expect(
      prisma.appointment.update({
        where: { id: a.id },
        data: {
          startsAt: moved.startsAt,
          endsAt: moved.endsAt,
          blockedUntil: moved.blockedUntil,
        },
      }),
    ).rejects.toSatisfy((e) => kind(e) === "exclusion_violation");
  });

  it("8a. N inserções paralelas SEM lock: nunca há 2 ativos, mas os perdedores podem receber 40P01", async () => {
    // Achado da Etapa 3: com a EXCLUDE sozinha, transações concorrentes no mesmo slot esperam umas pelas
    // outras e o PostgreSQL resolve o ciclo com deadlock (40P01, após deadlock_timeout) em vez de 23P01.
    // A invariante vale; a mensagem 409 só é previsível com o lock do profissional (V15, teste 8b).
    const s = await seedOrg(prisma);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        prisma.appointment.create({ data: appointmentData(s, 0) }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const kinds = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => kind(r.reason));
    expect(kinds).toHaveLength(5);
    expect(
      kinds.every((k) => k === "exclusion_violation" || k === "deadlock"),
    ).toBe(true);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("9. as constraints existem no banco migrado (proteção contra drift)", async () => {
    const c = await rawClient(SPIKE_DB);
    const { rows } = await c.query(
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'appointments'::regclass
       AND conname IN ('appointments_no_overlap','appointments_range_valid','appointments_range_coherent')`,
    );
    await c.end();
    expect(Object.fromEntries(rows.map((r) => [r.conname, r.contype]))).toEqual(
      {
        appointments_no_overlap: "x",
        appointments_range_valid: "c",
        appointments_range_coherent: "c",
      },
    );
  });
});

describe("V8 — coerência de ends_at/blocked_until (opção 1: CHECK com make_interval)", () => {
  const insert = async (vals: {
    ends: Date;
    blocked: Date;
    duration?: number;
    buffer?: number;
  }) => {
    const s = await seedOrg(prisma);
    const d = appointmentData(s, 0);
    const c = await rawClient(SPIKE_DB);
    try {
      await c.query(
        `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id,
           starts_at, ends_at, blocked_until, duration_minutes_snapshot, buffer_minutes_snapshot)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          s.org.id,
          s.professional.id,
          s.service.id,
          s.customer.id,
          d.startsAt,
          vals.ends,
          vals.blocked,
          vals.duration ?? 30,
          vals.buffer ?? 15,
        ],
      );
      return undefined;
    } catch (e) {
      return e as { code: string; constraint: string };
    } finally {
      await c.end();
    }
  };

  it("10. SQL cru com ends_at incoerente é rejeitado pelo CHECK", async () => {
    const d = appointmentData(await seedOrg(prisma, "x"), 0);
    const err = await insert({
      ends: new Date(+d.endsAt + 60_000),
      blocked: new Date(+d.endsAt + 15 * 60_000),
    });
    expect(err?.code).toBe("23514");
    expect(err?.constraint).toBe("appointments_range_coherent");
  });

  it("10. SQL cru com blocked_until incoerente é rejeitado", async () => {
    const d = appointmentData(await seedOrg(prisma, "x"), 0);
    const err = await insert({ ends: d.endsAt, blocked: d.endsAt }); // buffer 15 declarado, 0 gravado
    expect(err?.code).toBe("23514");
  });

  it("valores coerentes são aceitos (create e update do Prisma, sem contornos)", async () => {
    const s = await seedOrg(prisma);
    const a = await prisma.appointment.create({
      data: appointmentData(s, 0, 45, 15),
    });
    const moved = appointmentData(s, 120, 45, 15);
    await prisma.appointment.update({
      where: { id: a.id },
      data: {
        startsAt: moved.startsAt,
        endsAt: moved.endsAt,
        blockedUntil: moved.blockedUntil,
      },
    });
    // Remarcar sem recalcular ends_at/blocked_until => rejeitado pelo CHECK.
    await expect(
      prisma.appointment.update({
        where: { id: a.id },
        data: { startsAt: new Date(+moved.startsAt + 3600_000) },
      }),
    ).rejects.toSatisfy((e) => kind(e) === "check_violation");
  });

  it("o resultado não depende do TimeZone da sessão nem de DST (intervalo só em minutos)", async () => {
    const c = await rawClient(SPIKE_DB);
    const r = [];
    for (const tz of ["UTC", "America/Sao_Paulo", "America/New_York"]) {
      await c.query(`SET TimeZone = '${tz}'`);
      const { rows } = await c.query(
        `SELECT ('2026-03-08 06:30:00+00'::timestamptz + make_interval(mins => 120)) = '2026-03-08 08:30:00+00'::timestamptz AS ok`,
      );
      r.push(rows[0].ok);
    }
    await c.end();
    expect(r).toEqual([true, true, true]);
  });

  it("timestamptz + interval NÃO é IMMUTABLE (impossível em coluna gerada/índice); make_interval é", async () => {
    const c = await rawClient(SPIKE_DB);
    const { rows } = await c.query(
      `SELECT p.proname, p.provolatile FROM pg_proc p WHERE p.proname IN ('timestamptz_pl_interval','make_interval')
       ORDER BY 1`,
    );
    const gen = await c
      .query(
        `CREATE TEMP TABLE g (t timestamptz, u timestamptz GENERATED ALWAYS AS (t + interval '30 minutes') STORED)`,
      )
      .catch((e) => e);
    await c.end();
    expect(
      Object.fromEntries(rows.map((r) => [r.proname, r.provolatile])),
    ).toEqual({
      make_interval: "i",
      timestamptz_pl_interval: "s",
    });
    expect(gen.code).toBe("42P17"); // generation expression is not immutable
  });

  it("trigger que REJEITA também funciona (alternativa 2, não adotada) mas é redundante com o CHECK", async () => {
    const c = await rawClient(SPIKE_DB);
    await c.query(`
      CREATE TEMP TABLE tg (starts_at timestamptz, dur int, ends_at timestamptz);
      CREATE FUNCTION pg_temp.chk() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.ends_at <> NEW.starts_at + make_interval(mins => NEW.dur) THEN
          RAISE EXCEPTION 'incoerente' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER t BEFORE INSERT OR UPDATE ON tg FOR EACH ROW EXECUTE FUNCTION pg_temp.chk();`);
    await c.query(
      `INSERT INTO tg VALUES ('2030-01-01 10:00+00', 30, '2030-01-01 10:30+00')`,
    );
    const err = await c
      .query(
        `INSERT INTO tg VALUES ('2030-01-01 10:00+00', 30, '2030-01-01 11:00+00')`,
      )
      .catch((e) => e);
    await c.end();
    expect(err.code).toBe("23514");
  });

  it("CHECK sobrevive a pg_dump/restore (dump do schema spike restaurado em banco novo)", async () => {
    const admin = await rawClient("postgres");
    const restored = "agendly_spike_restore";
    await admin.query(`DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${restored}`);
    await admin.end();
    // Credenciais por variáveis de ambiente (nunca em argv, que apareceria em mensagens de erro).
    const pgEnv = (db: string) => {
      const u = new URL(databaseUrl(db));
      return {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port,
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
        PGDATABASE: db,
      };
    };
    const sql = execFileSync("pg_dump", ["--no-owner"], {
      env: pgEnv(SPIKE_DB),
      encoding: "utf8",
      maxBuffer: 50 << 20,
    });
    execFileSync("psql", ["--quiet", "--set", "ON_ERROR_STOP=1"], {
      env: pgEnv(restored),
      input: sql,
      encoding: "utf8",
    });
    const c = await rawClient(restored);
    const { rows } = await c.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'appointments'::regclass ORDER BY conname`,
    );
    await c.end();
    const names = rows.map((r) => r.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        "appointments_no_overlap",
        "appointments_range_coherent",
        "appointments_range_valid",
      ]),
    );
    const drop = await rawClient("postgres");
    await drop.query(`DROP DATABASE ${restored} WITH (FORCE)`);
    await drop.end();
  });
});

describe("V4 — SQL manual sem drift", () => {
  it("migrate diff entre migrations aplicadas e schema.prisma: 'No difference detected' (exit 0)", () => {
    const out = prismaCli([
      "migrate",
      "diff",
      "--config",
      "spikes/prisma.config.ts",
      "--from-config-datasource",
      "--to-schema",
      "spikes/schema.prisma",
      "--exit-code",
    ]);
    expect(out).toContain("No difference detected");
  });

  it("uma mudança de schema (nova coluna) gera SQL que NÃO toca EXCLUDE, CHECK nem índice parcial", () => {
    const dir = mkdtempSync(join(tmpdir(), "agendly-v4-"));
    mkdirSync(dir, { recursive: true });
    const original = readFileSync(
      new URL("../../spikes/schema.prisma", import.meta.url),
      "utf8",
    );
    const changed = original
      .replace('output   = "./generated"', 'output   = "./gen"')
      .replace(
        "  version                 Int         @default(0)",
        "  version                 Int         @default(0)\n  extraNote               String?",
      );
    const file = join(dir, "schema.prisma");
    writeFileSync(file, changed);
    const script = prismaCli([
      "migrate",
      "diff",
      "--config",
      "spikes/prisma.config.ts",
      "--from-config-datasource",
      "--to-schema",
      file,
      "--script",
    ]);
    expect(script).toContain('ADD COLUMN     "extraNote" TEXT');
    expect(script).not.toMatch(
      /appointments_no_overlap|appointments_range|appointments_active_idx|DROP CONSTRAINT|DROP INDEX/,
    );
  });

  it("limite do drift check: o Prisma NÃO detecta a remoção manual da EXCLUDE; só o teste de pg_constraint", async () => {
    const c = await rawClient(SPIKE_DB);
    let out: string;
    try {
      await c.query(
        "ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap",
      );
      out = prismaCli([
        "migrate",
        "diff",
        "--config",
        "spikes/prisma.config.ts",
        "--from-config-datasource",
        "--to-schema",
        "spikes/schema.prisma",
      ]);
    } finally {
      await c.query(`ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (organization_id WITH =, professional_id WITH =,
          tstzrange(starts_at, blocked_until, '[)') WITH &&) WHERE (status IN ('SCHEDULED', 'CONFIRMED'))`);
      await c.end();
    }
    expect(out).toContain("No difference detected");
  });
});
