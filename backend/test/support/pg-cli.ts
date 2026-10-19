import { databaseUrl } from "../../tools/database-url.ts";

/** Credenciais do cliente de linha de comando por variáveis de ambiente (nunca em argv: apareceria em erros). */
export function pgEnv(db: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl(db));
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port,
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: db,
  };
}
