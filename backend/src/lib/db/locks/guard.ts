// Guard de ordem de locks em tempo de execução (6.5). Mantém, por transação, o maior nível adquirido e os
// profissionais já travados. Violar a ordem lança LockOrderViolation ANTES de a consulta de lock ser enviada ao banco
// (nada espera), em dev, CI e produção. O guard valida a conformidade com o MODELO; não enxerga os locks internos
// do PostgreSQL (FK, índices únicos, exclusão) e portanto não prova a ausência de deadlocks.

/** Níveis da hierarquia global (6.5). Os domínios de agendamento (N) e de autenticação (A) são disjuntos. */
export type LockLevel = "N1" | "N2" | "N3" | "N4" | "A1" | "A2" | "A3" | "A4";

const RANK: Record<LockLevel, number> = {
  N1: 1,
  N2: 2,
  N3: 3,
  N4: 4,
  A1: 1,
  A2: 2,
  A3: 3,
  A4: 4,
};

const domainOf = (level: LockLevel): "booking" | "auth" =>
  level.startsWith("N") ? "booking" : "auth";

/** Níveis em que a regra permite no máximo UMA linha por transação (N2 e N4 admitem várias). */
const SINGLE_ROW: ReadonlySet<LockLevel> = new Set(["N1", "N3", "A1"]);

export class LockOrderViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockOrderViolation";
  }
}

/** Escrita em linha-folha (N4) sem a trava N2 do profissional correspondente (L9). */
export class LockCoverageViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockCoverageViolation";
  }
}

interface LockState {
  domain: "booking" | "auth";
  rank: number;
  level: LockLevel;
  /** Chaves já travadas por nível (N1/N3/A1: no máximo uma; N2: ids de profissional). */
  held: Map<LockLevel, Set<string>>;
  /** Maior id de profissional travado até agora (as travas N2 são adquiridas em ordem crescente). */
  lastProfessionalId: string | undefined;
}

// Chaveado pelo objeto `tx` da transação interativa: some junto com ele, sem vazar entre transações.
const states = new WeakMap<object, LockState>();

/** Ids de profissional são comparados em minúsculas; a ordem é a lexicográfica, igual à de `lockProfessionals`. */
export const normalizeId = (id: string): string => id.toLowerCase();

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Verifica a ordem ANTES de a trava ser pedida ao banco. Devolve `true` se a mesma chave já está travada nesta
 * transação (nova aquisição é desnecessária). Lança LockOrderViolation se a aquisição inverter a hierarquia.
 */
export function checkOrder(tx: object, level: LockLevel, key: string): boolean {
  const state = states.get(tx);
  if (!state) return false;
  if (state.domain !== domainOf(level))
    throw new LockOrderViolation(
      `${level}: a transação já usa o domínio de ${state.domain}; os domínios não se misturam`,
    );
  if (state.held.get(level)?.has(key)) return true;
  const rank = RANK[level];
  if (rank < state.rank)
    throw new LockOrderViolation(
      `${level} adquirido depois de ${state.level}: ordem inversa da hierarquia`,
    );
  if (rank === state.rank && SINGLE_ROW.has(level) && state.held.has(level))
    throw new LockOrderViolation(
      `${level}: mais de uma linha travada na mesma transação`,
    );
  if (
    level === "N2" &&
    state.lastProfessionalId !== undefined &&
    compareIds(key, state.lastProfessionalId) < 0
  )
    throw new LockOrderViolation(
      "N2: profissional com id menor que o último travado (ordem crescente exigida)",
    );
  return false;
}

/** Registra a aquisição bem-sucedida (chamar depois de `checkOrder`, quando o banco concedeu a trava). */
export function recordAcquired(
  tx: object,
  level: LockLevel,
  key: string,
): void {
  let state = states.get(tx);
  if (!state) {
    state = {
      domain: domainOf(level),
      rank: RANK[level],
      level,
      held: new Map(),
      lastProfessionalId: undefined,
    };
    states.set(tx, state);
  }
  if (RANK[level] >= state.rank) {
    state.rank = RANK[level];
    state.level = level;
  }
  const keys = state.held.get(level) ?? new Set<string>();
  keys.add(key);
  state.held.set(level, keys);
  if (level === "N2") state.lastProfessionalId = key;
}

/** Profissionais travados (N2) nesta transação — para o teste de cobertura e para as escritas folha. */
export function heldProfessionals(tx: object): ReadonlySet<string> {
  return states.get(tx)?.held.get("N2") ?? new Set();
}

/**
 * N4: declara uma escrita em linha-folha (`time_off`, `working_hours`, `professional_services`, a linha do
 * profissional). Exige que a trava N2 do profissional dono da linha já esteja retida (L9) e fecha a escalada: depois
 * de N4 nenhuma trava de nível menor pode ser pedida.
 */
export function enterLeafWrite(tx: object, professionalId: string): void {
  const id = normalizeId(professionalId);
  if (!heldProfessionals(tx).has(id))
    throw new LockCoverageViolation(
      "escrita em dado do profissional sem a trava N2 desse profissional",
    );
  recordAcquired(tx, "N4", `leaf:${id}`);
}
