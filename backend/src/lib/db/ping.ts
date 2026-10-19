import pg from "pg";

export interface DatabaseCheck {
  check: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDatabaseCheck(connectionString: string): DatabaseCheck {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  });
  // Erro em conexão ociosa não pode derrubar o processo.
  pool.on("error", () => {});
  let closing: Promise<void> | undefined;
  return {
    check: async () => {
      await pool.query("SELECT 1");
    },
    // pg.Pool.end() lança se chamado duas vezes; aqui é idempotente.
    close: () => (closing ??= pool.end()),
  };
}
