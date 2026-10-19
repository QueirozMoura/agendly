import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {}

/** Valida o ambiente. A mensagem lista só nomes de variáveis, nunca valores. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((i) => String(i.path[0] ?? "?"))),
    ];
    throw new EnvError(
      `Variáveis de ambiente inválidas ou ausentes: ${names.join(", ")}`,
    );
  }
  return result.data;
}
