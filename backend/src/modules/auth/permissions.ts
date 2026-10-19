// Autorização por papel (3.2): `can(role, action)`, NEGANDO POR PADRÃO. A matriz é um DADO indexado por papel —
// adicionar ADMIN no futuro é uma nova entrada aqui (e a migration do enum), sem tocar nas rotas.
// No MVP existe um único papel operacional: OWNER. Não há código, teste nem seed de ADMIN.

export type Role = "OWNER";

/** Padrões permitidos: ação exata ou prefixo `grupo.*`. Espelha a matriz da seção 3.2. */
const MATRIX: Readonly<Record<Role, readonly string[]>> = {
  OWNER: [
    "account.*", // ver/encerrar sessões, sair de todos os dispositivos
    "org.view",
    "org.settings.update", // nome, slug e limites da página pública (timezone é imutável: não é uma ação)
    "org.public_page.publish", // exige e-mail verificado (verificado também no servidor)
    "services.*",
    "professionals.*",
    "availability.*",
    "customers.read",
    "customers.write",
    "customers.privacy",
    "appointments.*",
    "session.switch_org",
  ],
};

export function can(role: string | null | undefined, action: string): boolean {
  if (typeof role !== "string" || !Object.hasOwn(MATRIX, role)) return false; // papel desconhecido: nega
  const patterns = MATRIX[role as Role];
  return patterns.some((p) =>
    p.endsWith(".*")
      ? action.startsWith(p.slice(0, -1)) && action.length > p.length - 1
      : p === action,
  );
}
