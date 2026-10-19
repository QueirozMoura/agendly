import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

/**
 * URL do banco para ferramentas (Prisma CLI, testes). Usa DATABASE_URL se existir; senão monta a
 * partir das variáveis POSTGRES_* do .env da raiz (o mesmo que o docker-compose usa). Nunca imprime.
 */
export function databaseUrl(dbName?: string): string {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const e = process.env;
  if (e.DATABASE_URL && !dbName) return e.DATABASE_URL;
  const base = e.DATABASE_URL
    ? new URL(e.DATABASE_URL)
    : new URL(
        `postgresql://${encodeURIComponent(e.POSTGRES_USER ?? "")}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? "")}@localhost:${e.POSTGRES_PORT ?? "5432"}/${e.POSTGRES_DB ?? ""}`,
      );
  if (dbName) base.pathname = `/${dbName}`;
  return base.toString();
}
