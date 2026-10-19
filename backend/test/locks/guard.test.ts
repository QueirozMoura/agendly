// L5 — guard de ordem de locks (6.5): unitário (tx falsa, ordem das consultas emitidas) e contra o Postgres real.
// A ordem registrada prova apenas a ordem PRETENDIDA, não a ausência de deadlocks (6.5, "O que se pode afirmar").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOrder, recordAcquired } from "../../src/lib/db/locks/guard.ts";
import {
  LockCoverageViolation,
  LockOrderViolation,
  enterLeafWrite,
  heldProfessionals,
  lockProfessional,
  lockProfessionals,
  lockUser,
  runLocked,
} from "../../src/lib/db/locks/index.ts";
import { classifyDbError } from "../../src/lib/db/errors.ts";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../src/lib/db/client.ts";
import { databaseUrl } from "../../tools/database-url.ts";
import { TEST_DB, rawClient } from "../support/databases.ts";
import {
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";
import { api, createOrg, signupVerified } from "../support/orgs.ts";

const ORG = "00000000-0000-7000-8000-0000000000aa";
const A = "00000000-0000-7000-8000-000000000001";
const B = "00000000-0000-7000-8000-000000000002";
const C = "00000000-0000-7000-8000-000000000003";

/** tx falsa: registra o id de cada `SELECT … FOR NO KEY UPDATE` na ordem em que foi EMITIDO. */
function fakeTx(missing: string[] = []) {
  const emitted: string[] = [];
  const tx = {
    $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const id = String(values.at(-1));
      emitted.push(id);
      return missing.includes(id) ? [] : [{ id }];
    },
  };
  return { tx: tx as never, emitted };
}

describe("L5 — lockProfessionals: ordem emitida", () => {
  it("[B, A] emite A e depois B; remove duplicatas e ignora a caixa", async () => {
    const { tx, emitted } = fakeTx();
    expect(await lockProfessionals(tx, ORG, [B, A, B, A.toUpperCase()])).toBe(
      true,
    );
    expect(emitted).toEqual([A, B]);
  });

  it("um SELECT por profissional (não um único ORDER BY … FOR NO KEY UPDATE)", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [C, B, A]);
    expect(emitted).toEqual([A, B, C]);
  });

  it("travar de novo um profissional já travado na transação não emite consulta", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [A, B]);
    await lockProfessionals(tx, ORG, [B]);
    await lockProfessional(tx, ORG, A);
    expect(emitted).toEqual([A, B]);
    expect([...heldProfessionals(tx)].sort()).toEqual([A, B]);
  });

  it("chamadas sucessivas em ordem crescente são aceitas", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [A]);
    await lockProfessionals(tx, ORG, [B, C]);
    expect(emitted).toEqual([A, B, C]);
  });

  it("profissional inexistente => false; a chamada para ali e ele não conta como travado", async () => {
    const { tx, emitted } = fakeTx([B]);
    expect(await lockProfessionals(tx, ORG, [C, B, A])).toBe(false);
    expect(emitted).toEqual([A, B]); // parou no B; o C nunca foi pedido
    expect([...heldProfessionals(tx)]).toEqual([A]);
    expect(() => enterLeafWrite(tx, B)).toThrow(LockCoverageViolation);
  });
});

describe("L5 — violações do guard (lançam ANTES de a consulta ser emitida)", () => {
  it("profissional B e depois A (id menor) => LockOrderViolation, e a consulta de A não é emitida", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [B]);
    await expect(lockProfessionals(tx, ORG, [A])).rejects.toBeInstanceOf(
      LockOrderViolation,
    );
    await expect(lockProfessionals(tx, ORG, [C, A])).rejects.toThrow(
      /id menor/,
    );
    expect(emitted).toEqual([B]);
  });

  it("depois de uma violação o estado não fica corrompido: a ordem correta continua valendo", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [B]);
    await expect(lockProfessionals(tx, ORG, [A])).rejects.toThrow(
      LockOrderViolation,
    );
    await lockProfessionals(tx, ORG, [C]);
    expect(emitted).toEqual([B, C]);
  });

  it("N2 depois de N4 (escrita-folha) => violação: nível menor depois de maior", async () => {
    const { tx, emitted } = fakeTx();
    await lockProfessionals(tx, ORG, [A]);
    enterLeafWrite(tx, A);
    await expect(lockProfessionals(tx, ORG, [B])).rejects.toThrow(
      /ordem inversa/,
    );
    expect(emitted).toEqual([A]);
  });

  it("escrita-folha sem trava N2 (ou com a trava de OUTRO profissional) => LockCoverageViolation (L9)", async () => {
    const { tx } = fakeTx();
    expect(() => enterLeafWrite(tx, A)).toThrow(LockCoverageViolation);
    await lockProfessionals(tx, ORG, [B]);
    expect(() => enterLeafWrite(tx, A)).toThrow(LockCoverageViolation);
    expect(() => enterLeafWrite(tx, B)).not.toThrow();
    expect(() => enterLeafWrite(tx, B.toUpperCase())).not.toThrow(); // vários N4 são permitidos
  });

  it("domínios disjuntos: A1 (users) e N2 (professionals) não se misturam, em nenhuma ordem", async () => {
    const one = fakeTx();
    await lockUser(one.tx, A);
    await expect(lockProfessionals(one.tx, ORG, [B])).rejects.toThrow(
      /domínio/,
    );
    const two = fakeTx();
    await lockProfessionals(two.tx, ORG, [B]);
    await expect(lockUser(two.tx, A)).rejects.toThrow(/domínio/);
    expect(one.emitted).toEqual([A]);
    expect(two.emitted).toEqual([B]);
  });

  it("A1: no máximo uma linha de users por transação (a mesma pode ser pedida de novo sem consulta)", async () => {
    const { tx, emitted } = fakeTx();
    await lockUser(tx, A);
    await lockUser(tx, A);
    await expect(lockUser(tx, B)).rejects.toThrow(/mais de uma linha/);
    expect(emitted).toEqual([A]);
  });

  it("transações diferentes não compartilham estado", async () => {
    const t1 = fakeTx();
    const t2 = fakeTx();
    await lockProfessionals(t1.tx, ORG, [C]);
    await expect(lockProfessionals(t2.tx, ORG, [A])).resolves.toBe(true);
    await expect(lockProfessionals(t1.tx, ORG, [A])).rejects.toThrow(
      LockOrderViolation,
    );
  });
});

describe("L5 — hierarquia completa N1 → N2 → N3 → N4 (níveis que as etapas seguintes usarão)", () => {
  const run = (
    tx: object,
    steps: Array<[Parameters<typeof checkOrder>[1], string]>,
  ) => {
    for (const [level, key] of steps) {
      if (!checkOrder(tx, level, key)) recordAcquired(tx, level, key);
    }
  };

  it("a ordem N1, N2 (crescente), N3, N4 é aceita", () => {
    expect(() =>
      run({}, [
        ["N1", "c1"],
        ["N2", A],
        ["N2", B],
        ["N3", "k"],
        ["N4", "x"],
        ["N4", "y"],
      ]),
    ).not.toThrow();
  });

  it.each([
    [
      "N2 antes de N1",
      [
        ["N2", A],
        ["N1", "c1"],
      ],
    ],
    [
      "N3 antes de N2",
      [
        ["N3", "k"],
        ["N2", A],
      ],
    ],
    [
      "N4 antes de N3",
      [
        ["N4", "x"],
        ["N3", "k"],
      ],
    ],
    [
      "N4 antes de N1",
      [
        ["N4", "x"],
        ["N1", "c1"],
      ],
    ],
    [
      "dois clientes (N1) na mesma transação",
      [
        ["N1", "c1"],
        ["N1", "c2"],
      ],
    ],
    [
      "duas chaves de idempotência (N3)",
      [
        ["N3", "k1"],
        ["N3", "k2"],
      ],
    ],
    [
      "profissionais fora de ordem",
      [
        ["N2", B],
        ["N2", A],
      ],
    ],
    [
      "A2 depois de N1 (domínios)",
      [
        ["N1", "c1"],
        ["A2", "t"],
      ],
    ],
  ] as const)("%s => LockOrderViolation", (_name, steps) => {
    expect(() => run({}, steps as never)).toThrow(LockOrderViolation);
  });

  it("os níveis da autenticação seguem A1 → A2 → A3 → A4", () => {
    expect(() =>
      run({}, [
        ["A1", "u"],
        ["A2", "t"],
        ["A3", "s"],
        ["A4", "o"],
      ]),
    ).not.toThrow();
    expect(() =>
      run({}, [
        ["A3", "s"],
        ["A2", "t"],
      ]),
    ).toThrow(LockOrderViolation);
  });
});

describe("L5 — contra o Postgres real", () => {
  let t: AuthTestApp;
  let org: string;
  let pa: string;
  let pb: string;
  let queries: Array<{ query: string; params: string }>;
  let prisma: PrismaClient;

  beforeEach(async () => {
    await resetUsers();
    t = await makeAuthApp();
    const ana = await signupVerified(t, "ana@example.com");
    expect((await createOrg(t, ana, "salao")).statusCode).toBe(201);
    org = (
      await t.prisma.organization.findUniqueOrThrow({
        where: { slug: "salao" },
      })
    ).id;
    const ids = await Promise.all(
      ["P1", "P2"].map(
        async (name) =>
          (await api(t, "POST", "/api/professionals", ana, { name })).json()
            .professional.id as string,
      ),
    );
    [pa, pb] = ids.sort() as [string, string];
    queries = [];
    prisma = createPrismaClient(databaseUrl(TEST_DB), {
      log: [{ emit: "event", level: "query" }],
    });
    (
      prisma as unknown as {
        $on(
          e: "query",
          cb: (x: { query: string; params: string }) => void,
        ): void;
      }
    ).$on("query", (e) => queries.push({ query: e.query, params: e.params }));
  });
  afterEach(async () => {
    await prisma.$disconnect();
    await t.close();
  });

  const lockStatements = () =>
    queries
      .filter((q) => /FOR NO KEY UPDATE/.test(q.query))
      .map((q) => JSON.parse(q.params).at(-1) as string);

  it("lockProfessionals([maior, menor]) emite os SELECT … FOR NO KEY UPDATE na ordem crescente", async () => {
    await runLocked(prisma, async (tx) => {
      expect(await lockProfessionals(tx, org, [pb, pa])).toBe(true);
    });
    expect(lockStatements()).toEqual([pa, pb]);
  });

  it("empresa errada: o profissional não é encontrado (false) e nada fica travado", async () => {
    const other = "00000000-0000-7000-8000-0000000000bb";
    await runLocked(prisma, async (tx) => {
      expect(await lockProfessionals(tx, other, [pa])).toBe(false);
    });
  });

  it("inversão de ordem falha NA HORA, sem esperar a trava que outra conexão segura (nem o lock_timeout)", async () => {
    const holder = await rawClient(TEST_DB);
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE",
        [pa],
      );
      const started = Date.now();
      const err = await runLocked(prisma, async (tx) => {
        await lockProfessionals(tx, org, [pb]);
        await lockProfessionals(tx, org, [pa]); // inverte: id menor depois do maior; pa está presa pelo holder
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockOrderViolation);
      expect(Date.now() - started).toBeLessThan(1500); // sem esperar os 3 s de lock_timeout
      expect(
        queries.filter((q) => /FOR NO KEY UPDATE/.test(q.query)),
      ).toHaveLength(1); // só a de pb
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("lock_timeout por transação: runLocked(…, 200 ms) estoura 55P03 e não vaza para outras transações", async () => {
    const holder = await rawClient(TEST_DB);
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM professionals WHERE id = $1 FOR NO KEY UPDATE",
        [pa],
      );
      const started = Date.now();
      const err = await runLocked(
        prisma,
        async (tx) => {
          const [row] = await tx.$queryRaw<
            { lock_timeout: string }[]
          >`SHOW lock_timeout`;
          expect(row?.lock_timeout).toBe("200ms");
          await lockProfessionals(tx, org, [pa]);
        },
        200,
      ).catch((e: unknown) => e);
      expect(classifyDbError(err)).toBe("lock_timeout");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    // fora de runLocked o timeout é o padrão do servidor (0 = sem limite): SET LOCAL não vazou
    for (let i = 0; i < 4; i++) {
      const [row] = await prisma.$queryRaw<
        { lock_timeout: string }[]
      >`SHOW lock_timeout`;
      expect(row?.lock_timeout).toBe("0");
    }
  });
});
