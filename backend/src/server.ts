import { loadEnv, EnvError } from "./config/env.ts";
import { collectSecrets, formatErrorForLog } from "./lib/logger.ts";
import { startServer } from "./start.ts";

const FORCE_EXIT_MS = 10_000;

// Rede de segurança: só encerra à força se o processo não drenar sozinho; não segura o event loop.
function forceExitIfStuck(): void {
  setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
}

async function main(): Promise<void> {
  const env = loadEnv();
  const server = await startServer(env);

  const onSignal = () => {
    // Sinais repetidos reaproveitam o mesmo encerramento (shutdown é idempotente).
    server.shutdown().catch((err) => {
      console.error(
        formatErrorForLog(err, "falha no encerramento", collectSecrets(env)),
      );
      process.exitCode = 1;
    });
    forceExitIfStuck();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

main().catch((err) => {
  console.error(
    err instanceof EnvError
      ? err.message
      : formatErrorForLog(
          err,
          "falha na inicialização",
          collectSecrets(process.env),
        ),
  );
  process.exitCode = 1;
  forceExitIfStuck();
});
