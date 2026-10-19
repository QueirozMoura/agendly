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
  // Origens permitidas para requisições que alteram estado (proteção CSRF, 3.1). Separadas por vírgula.
  // Em produção é obrigatória (a SPA e a API ficam na mesma origem pública).
  ALLOWED_ORIGINS: z.string().optional(),
  // true somente atrás de proxy reverso confiável (Caddy/Nginx): faz req.ip vir de X-Forwarded-For.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const DEFAULT_DEV_ORIGIN = "http://localhost:5173"; // Vite

export type Env = Omit<z.infer<typeof envSchema>, "ALLOWED_ORIGINS"> & {
  ALLOWED_ORIGINS: string[];
};

export class EnvError extends Error {}

function parseOrigins(
  data: { NODE_ENV: string; ALLOWED_ORIGINS?: string | undefined },
  invalid: string[],
): string[] {
  const raw = data.ALLOWED_ORIGINS?.trim();
  if (!raw) {
    if (data.NODE_ENV === "production") invalid.push("ALLOWED_ORIGINS");
    return [DEFAULT_DEV_ORIGIN];
  }
  try {
    const origins = raw.split(",").map((o) => {
      const url = new URL(o.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo");
      return url.origin;
    });
    return [...new Set(origins)];
  } catch {
    invalid.push("ALLOWED_ORIGINS");
    return [];
  }
}

/** Valida o ambiente. A mensagem lista só nomes de variáveis, nunca valores. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  const invalid = result.success
    ? []
    : result.error.issues.map((i) => String(i.path[0] ?? "?"));
  const origins = result.success ? parseOrigins(result.data, invalid) : [];
  if (!result.success || invalid.length > 0) {
    throw new EnvError(
      `Variáveis de ambiente inválidas ou ausentes: ${[...new Set(invalid)].join(", ")}`,
    );
  }
  return { ...result.data, ALLOWED_ORIGINS: origins };
}
