// L8 (estático e de pool) e a parte estática de L9: regras sobre o código de src/ e um pool de UMA conexão.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient as GeneratedClient } from "../../src/generated/prisma/client.ts";
import { runLocked } from "../../src/lib/db/locks/index.ts";
import {
  createProfessional,
  setProfessionalServices,
  updateProfessional,
} from "../../src/modules/professionals/service.ts";
import {
  createTimeOff,
  createWorkingHours,
  deleteTimeOff,
  deleteWorkingHours,
  updateTimeOff,
  updateWorkingHours,
} from "../../src/modules/availability/service.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB } from "../support/databases.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import { api, createOrg, signupVerified } from "../support/orgs.ts";
import { parentModels } from "../support/schema-model.ts";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      return name === "generated" ? [] : walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = walk(SRC).map((full) => ({
  path: relative(SRC, full).replaceAll("\\", "/"),
  code: stripComments(readFileSync(full, "utf8")),
}));
const offenders = (test: (f: (typeof files)[number]) => boolean) =>
  files.filter(test).map((f) => f.path);

// ── detectores (com autoteste abaixo: "os detectores realmente detectam") ──

/** Corpo do callback de cada `$transaction(` / `runLocked(`: do `(` da chamada até o `)` que o fecha. */
function transactionBodies(code: string): string[] {
  const bodies: string[] = [];
  for (const m of code.matchAll(/(\$transaction|runLocked)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let inTemplate = false;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === "`") inTemplate = !inTemplate;
      if (inTemplate) continue;
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        bodies.push(code.slice(open, i + 1));
        break;
      }
    }
  }
  return bodies;
}

/** Corpos de transação que citam o cliente global (`prisma`) fora do argumento de escopo `forTenant(prisma, …)`. */
function globalClientInsideTransaction(code: string): string[] {
  return transactionBodies(code).filter((body) => {
    const callback = body.slice(body.search(/async\s*\(\s*tx\b/));
    return /\bprisma\b/.test(callback);
  });
}

const LEAF_WRITE =
  /\btx\.(timeOff|workingHours|professionalService|professional)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/g;

/** Escritas-folha (N4) que não têm `lockProfessionals(` E `enterLeafWrite(` antes, dentro do mesmo `runLocked(`. */
function uncoveredLeafWrites(code: string): string[] {
  const bad: string[] = [];
  for (const m of code.matchAll(LEAF_WRITE)) {
    const at = m.index ?? 0;
    const start = code.lastIndexOf("runLocked(", at);
    const before = start < 0 ? "" : code.slice(start, at);
    if (
      !before.includes("lockProfessionals(") ||
      !before.includes("enterLeafWrite(")
    )
      bad.push(m[0]);
  }
  return bad;
}

describe("L8 — regras estáticas de transações e locks", () => {
  it("nenhum uso do cliente global (`prisma`) dentro de callbacks de transação", () => {
    const using = offenders(
      (f) => globalClientInsideTransaction(f.code).length > 0,
    );
    expect(
      using,
      `cliente global dentro de transação em: ${using.join(", ")}`,
    ).toEqual([]);
    // sanidade: o detector enxerga transações de verdade
    expect(
      files.filter((f) => transactionBodies(f.code).length > 0).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("autoteste: o detector acusa `prisma` dentro de uma transação e aceita `forTenant(prisma, …)` + tx", () => {
    const bad = `await runLocked(forTenant(prisma, org), async (tx) => { await prisma.professional.findMany(); });`;
    const bad2 = `await prisma.$transaction(async (tx) => { await tx.x.y(); await prisma.z.w(); });`;
    const ok = `await runLocked(forTenant(prisma, org), async (tx) => { await tx.professional.findMany(); });`;
    expect(globalClientInsideTransaction(bad)).toHaveLength(1);
    expect(globalClientInsideTransaction(bad2)).toHaveLength(1);
    expect(globalClientInsideTransaction(ok)).toEqual([]);
  });

  it("nenhum delete/deleteMany nos modelos-pai (derivados do schema): pais são desativados, nunca apagados (R-c)", () => {
    const parents = parentModels();
    expect(parents).toEqual([
      "Organization",
      "Professional",
      "Service",
      "User",
    ]); // sanidade do parser de relações
    for (const model of parents) {
      const accessor = model[0]!.toLowerCase() + model.slice(1);
      expect(
        offenders((f) =>
          new RegExp(`\\.${accessor}\\.(delete|deleteMany)\\s*\\(`).test(
            f.code,
          ),
        ),
        `delete físico de ${model}`,
      ).toEqual([]);
    }
  });

  it("`FOR NO KEY UPDATE`/`FOR UPDATE` só em lib/db/locks/ e a trava de profissionais só em locks/index.ts", () => {
    expect(
      offenders(
        (f) =>
          /FOR (NO KEY )?UPDATE/.test(f.code) &&
          !f.path.startsWith("lib/db/locks/"),
      ),
    ).toEqual([]);
    expect(
      offenders((f) =>
        /FROM professionals[\s\S]{0,200}FOR NO KEY UPDATE/.test(f.code),
      ),
    ).toEqual(["lib/db/locks/index.ts"]);
  });
});

describe("L9 (estático) — escrita-folha sempre sob lockProfessionals + enterLeafWrite", () => {
  it("todo tx.<folha>.<escrita> de src/ está num runLocked com as duas chamadas antes", () => {
    const writers = files.filter(
      (f) => [...f.code.matchAll(LEAF_WRITE)].length > 0,
    );
    expect(writers.map((f) => f.path).sort()).toEqual([
      "modules/availability/service.ts",
      "modules/professionals/service.ts",
    ]);
    for (const f of writers)
      expect(uncoveredLeafWrites(f.code), f.path).toEqual([]);
  });

  it("autoteste: o detector acusa escrita sem lock, sem enterLeafWrite, fora de runLocked — e aceita a correta", () => {
    const noLock = `runLocked(db, async (tx) => { enterLeafWrite(tx, id); await tx.timeOff.create({}); })`;
    const noEnter = `runLocked(db, async (tx) => { await lockProfessionals(tx, o, [id]); await tx.workingHours.update({}); })`;
    const outside = `async function f(tx) { await tx.professionalService.deleteMany({}); }`;
    const ok = `runLocked(db, async (tx) => { await lockProfessionals(tx, o, [id]); enterLeafWrite(tx, id); await tx.timeOff.create({}); })`;
    expect(uncoveredLeafWrites(noLock)).toHaveLength(1);
    expect(uncoveredLeafWrites(noEnter)).toHaveLength(1);
    expect(uncoveredLeafWrites(outside)).toHaveLength(1);
    expect(uncoveredLeafWrites(ok)).toEqual([]);
  });
});

describe("L8 (pool) — com UMA conexão no pool, nenhum fluxo usa o cliente global dentro da transação", () => {
  let t: AuthTestApp;
  let minimal: GeneratedClient;
  let org: string;
  let pro: string;
  let svc: string;
  let whId: string;
  let toId: string;

  beforeAll(async () => {
    await resetUsers();
    t = await makeAuthApp();
    const ana = await signupVerified(t, "ana@example.com");
    expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
    org = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "salao" },
      })
    ).id;
    pro = (
      await api(t, "POST", "/api/professionals", ana, { name: "Carla" })
    ).json().professional.id;
    svc = (
      await api(t, "POST", "/api/services", ana, {
        name: "Corte",
        durationMinutes: 30,
      })
    ).json().service.id;
    whId = (
      await api(t, "POST", "/api/working-hours", ana, {
        professionalId: pro,
        weekday: 1,
        startTime: "09:00",
        endTime: "12:00",
      })
    ).json().workingHours.id;
    toId = (
      await api(t, "POST", "/api/time-off", ana, {
        professionalId: pro,
        startsAt: "2031-07-01T10:00:00Z",
        endsAt: "2031-07-01T11:00:00Z",
      })
    ).json().timeOff.id;
    // pool de UMA conexão e espera curta: quem pedir uma 2ª conexão enquanto a transação segura a 1ª falha
    minimal = new GeneratedClient({
      adapter: new PrismaPg({
        connectionString: databaseUrl(TEST_DB),
        max: 1,
        connectionTimeoutMillis: 600,
      }),
    });
  });
  afterAll(async () => {
    await minimal.$disconnect();
    await t.close();
  });

  it("controle positivo: usar o cliente global dentro de uma transação trava o pool e FALHA (o teste detecta o erro)", async () => {
    const err = await minimal
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await minimal.$queryRaw`SELECT 1`; // 2ª conexão enquanto a transação segura a única
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it("controle negativo: a mesma transação usando só `tx` funciona com o pool de 1", async () => {
    await expect(
      minimal.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      }),
    ).resolves.toBeUndefined();
  });

  it("todas as operações com lock (profissional, vínculos, WorkingHours, TimeOff) concluem com o pool de 1", async () => {
    const prisma = minimal as unknown as Parameters<
      typeof updateProfessional
    >[0];
    const scope = { organizationId: org };
    await updateProfessional(prisma, scope, pro, { active: true });
    await setProfessionalServices(prisma, scope, pro, [svc]);
    await setProfessionalServices(prisma, scope, pro, []);
    const w = await createWorkingHours(prisma, scope, {
      professionalId: pro,
      weekday: 2,
      startTime: 540,
      endTime: 600,
    });
    await updateWorkingHours(prisma, scope, w.id, { endTime: 660 });
    await updateWorkingHours(prisma, scope, whId, { startTime: 480 });
    await deleteWorkingHours(prisma, scope, w.id);
    const o = await createTimeOff(prisma, scope, {
      professionalId: pro,
      startsAt: new Date("2031-09-01T10:00:00Z"),
      endsAt: new Date("2031-09-01T11:00:00Z"),
      reason: null,
    });
    await updateTimeOff(prisma, scope, o.id, { reason: "x" });
    await updateTimeOff(prisma, scope, toId, { reason: "y" });
    await deleteTimeOff(prisma, scope, o.id);
    await createProfessional(prisma, scope, { name: "Davi" });
    expect(await t.prisma.workingHours.count()).toBe(1);
    expect(await t.prisma.timeOff.count()).toBe(1);
  });

  it("runLocked também devolve a conexão quando a transação falha (a próxima operação não trava)", async () => {
    await expect(
      runLocked(minimal, async () => {
        throw new Error("falha no meio");
      }),
    ).rejects.toThrow("falha no meio");
    await expect(
      runLocked(minimal, async (tx) => tx.$queryRaw`SELECT 1`),
    ).resolves.toBeDefined();
  });
});
