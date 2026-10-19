// Migration inicial de identidade (Etapa 3) aplicada em banco limpo + V2 (UUID v7).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import { newId } from "../../src/lib/ids.ts";
import {
  TEST_DB,
  prodPrisma,
  rawClient,
  truncate,
} from "../support/databases.ts";

const prisma = prodPrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => truncate(TEST_DB, ["users", "organizations"]));

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const user = (email = "a@example.com") => ({
  email,
  passwordHash: "h",
  name: "A",
});
const org = (slug = "acme") => ({
  name: "Acme",
  slug,
  timezone: "America/Sao_Paulo",
});

describe("esquema de identidade", () => {
  it("cria as cinco tabelas, com colunas uuid", async () => {
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const types = await c.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='id'`,
    );
    await c.end();
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "users",
        "organizations",
        "memberships",
        "sessions",
        "auth_tokens",
      ]),
    );
    expect(types.rows[0].data_type).toBe("uuid");
  });

  it("users: credentials_version começa em 0 e e-mail único", async () => {
    const u = await prisma.user.create({ data: user() });
    expect(u.credentialsVersion).toBe(0);
    await expect(prisma.user.create({ data: user() })).rejects.toSatisfy(
      (e) => classifyDbError(e) === "unique_violation",
    );
  });

  it("users: CHECK impede e-mail com maiúsculas (SQL manual)", async () => {
    await expect(
      prisma.user.create({ data: user("Maiuscula@Example.com") }),
    ).rejects.toSatisfy((e) => classifyDbError(e) === "check_violation");
  });

  it("organizations: padrões de 6.7 e CHECK dos limites", async () => {
    const o = await prisma.organization.create({ data: org() });
    expect(o).toMatchObject({
      publicMinNoticeMinutes: 120,
      publicMaxAdvanceDays: 60,
      publicMaxActiveBookingsPerPhone: 3,
      publishedAt: null,
    });
    await expect(
      prisma.organization.create({
        data: { ...org("x"), publicMaxActiveBookingsPerPhone: 0 },
      }),
    ).rejects.toSatisfy((e) => classifyDbError(e) === "check_violation");
  });

  it("memberships: único por (usuário, empresa) e role só aceita OWNER", async () => {
    const u = await prisma.user.create({ data: user() });
    const o = await prisma.organization.create({ data: org() });
    await prisma.membership.create({
      data: { userId: u.id, organizationId: o.id, role: "OWNER" },
    });
    await expect(
      prisma.membership.create({
        data: { userId: u.id, organizationId: o.id, role: "OWNER" },
      }),
    ).rejects.toSatisfy((e) => classifyDbError(e) === "unique_violation");

    const c = await rawClient(TEST_DB);
    await expect(
      c.query(
        `INSERT INTO memberships (id, user_id, organization_id, role, updated_at)
         VALUES ($1, $2, $3, 'ADMIN', now())`,
        [newId(), u.id, o.id],
      ),
    ).rejects.toMatchObject({ code: "22P02" }); // invalid_text_representation: ADMIN não existe no enum
    await c.end();
  });

  it("sessions e auth_tokens: token_hash único; FK impede órfãos; sem DELETE em cascata", async () => {
    const u = await prisma.user.create({ data: user() });
    await prisma.session.create({
      data: {
        userId: u.id,
        tokenHash: "h1",
        credentialsVersion: 0,
        expiresAt: new Date(),
      },
    });
    await expect(
      prisma.session.create({
        data: {
          userId: u.id,
          tokenHash: "h1",
          credentialsVersion: 0,
          expiresAt: new Date(),
        },
      }),
    ).rejects.toSatisfy((e) => classifyDbError(e) === "unique_violation");
    await prisma.authToken.create({
      data: {
        userId: u.id,
        type: "PASSWORD_RESET",
        tokenHash: "t1",
        expiresAt: new Date(),
      },
    });
    await expect(prisma.user.delete({ where: { id: u.id } })).rejects.toSatisfy(
      (e) => classifyDbError(e) === "foreign_key_violation",
    ); // R-c: pais não são apagados (Restrict)
  });
});

describe("V2 — UUID v7", () => {
  it("default uuid(7) do Prisma gera v7 em colunas uuid, ordenáveis no tempo", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        (await prisma.user.create({ data: user(`u${i}@example.com`) })).id,
      );
    }
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids); // ordem lexicográfica == ordem de criação
  });

  it("newId() (biblioteca uuid) gera v7 e é aceito como PK", async () => {
    const id = newId();
    expect(id).toMatch(UUID_V7);
    const u = await prisma.user.create({ data: { id, ...user() } });
    expect(u.id).toBe(id);
    const ids = Array.from({ length: 1000 }, newId);
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });

  it("PostgreSQL 18 tem uuidv7() nativo (alternativa; não adotada)", async () => {
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      `SELECT uuidv7()::text AS id, version() AS v`,
    );
    await c.end();
    expect(rows[0].id).toMatch(UUID_V7);
    expect(rows[0].v).toContain("PostgreSQL 18");
  });
});
