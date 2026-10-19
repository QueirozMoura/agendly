import type { FastifyBaseLogger } from "fastify";

export interface JobsHandle {
  /** Para de agendar e espera o ciclo em andamento terminar. Idempotente. */
  stop: () => Promise<void>;
}

/**
 * Laço no próprio processo da API (1, 3.6): só lê estado do banco, então reiniciar não perde nada.
 * Ciclos nunca se sobrepõem e um erro nunca derruba o processo nem encerra o laço.
 */
export function startJobLoop(options: {
  intervalMs: number;
  run: () => Promise<void>;
  logger: Pick<FastifyBaseLogger, "error">;
}): JobsHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = options
        .run()
        .catch((err) => options.logger.error({ err }, "job cycle failed"))
        .finally(() => {
          running = undefined;
          schedule();
        });
    }, options.intervalMs);
  };
  schedule();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
