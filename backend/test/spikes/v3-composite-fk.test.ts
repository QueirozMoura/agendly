// V3 — FKs compostas (organization_id, X_id) no Prisma + SQL real.
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

describe("V3 FK composta", () => {
  it("o schema com campo organizationId compartilhado por 4 relações valida e gera as FKs compostas", async () => {
    const c = await rawClient(SPIKE_DB);
    const { rows } = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'appointments'::regclass AND contype = 'f' ORDER BY conname`,
    );
    await c.end();
    const defs = rows.map((r) => r.def as string);
    expect(defs).toContain(
      "FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id) ON UPDATE CASCADE ON DELETE RESTRICT",
    );
    expect(defs.filter((d) => d.includes("(organization_id,"))).toHaveLength(3);
  });

  it("ORM: filho do mesmo tenant é criado; referenciar profissional de outra empresa falha", async () => {
    const a = await seedOrg(prisma, "A");
    const b = await seedOrg(prisma, "B");
    await prisma.appointment.create({ data: appointmentData(a, 0) });
    const cross = {
      ...appointmentData(a, 120),
      professionalId: b.professional.id,
    };
    await expect(prisma.appointment.create({ data: cross })).rejects.toSatisfy(
      (e) => classifyDbError(e) === "foreign_key_violation",
    );
  });

  it("SQL cru: par (organização A, profissional de B) é rejeitado pela FK, não pela exclusão", async () => {
    const a = await seedOrg(prisma, "A");
    const b = await seedOrg(prisma, "B");
    const c = await rawClient(SPIKE_DB);
    const d = appointmentData(a, 0);
    const err = await c
      .query(
        `INSERT INTO appointments (id, organization_id, professional_id, service_id, customer_id,
           starts_at, ends_at, blocked_until, duration_minutes_snapshot, buffer_minutes_snapshot)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 30, 0)`,
        [
          a.org.id,
          b.professional.id,
          a.service.id,
          a.customer.id,
          d.startsAt,
          d.endsAt,
          d.blockedUntil,
        ],
      )
      .catch((e) => e);
    await c.end();
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe(
      "appointments_organization_id_professional_id_fkey",
    );
  });

  it("relação composta opcional: NULL em professional_id desliga a verificação (MATCH SIMPLE)", async () => {
    const a = await seedOrg(prisma, "A");
    const b = await seedOrg(prisma, "B");
    // professional_id NULL: aceito, e a FK não verifica nada.
    await prisma.note.create({
      data: { organizationId: a.org.id, text: "sem profissional" },
    });
    // Com valor, a FK composta volta a valer.
    await expect(
      prisma.note.create({
        data: {
          organizationId: a.org.id,
          professionalId: b.professional.id,
          text: "cruzada",
        },
      }),
    ).rejects.toSatisfy((e) => classifyDbError(e) === "foreign_key_violation");
  });

  it("onDelete: SetNull em relação composta opcional: Prisma avisa e o SQL anula as DUAS colunas", () => {
    // Evidência reproduzível por CLI (schema temporário); a conclusão está em docs/STAGE-3-VALIDATIONS.md.
    const out = execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema",
        "test/fixtures/setnull.prisma",
        "--script",
      ],
      { cwd: new URL("../..", import.meta.url), encoding: "utf8" },
    );
    expect(out).toContain(
      'FOREIGN KEY ("organization_id", "professional_id") REFERENCES "professionals"("organization_id", "id") ON DELETE SET NULL',
    );
  });
});
