import { z } from "zod";
import {
  KeyringError,
  makeKeyring,
  parseKeyring,
  type Keyring,
} from "../lib/email/keyring.ts";

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
  // Chaves AES-256 do payload da outbox (3.6): `id:base64,id2:base64` (32 bytes cada) + id da corrente.
  // Obrigatórias em produção (a API não sobe sem a chave corrente); em dev/teste há uma chave fixa.
  OUTBOX_ENCRYPTION_KEYS: z.string().optional(),
  OUTBOX_CURRENT_KEY_ID: z.string().optional(),
  // URL pública da SPA, usada nos links dos e-mails. Padrão: a primeira de ALLOWED_ORIGINS.
  APP_BASE_URL: z.string().optional(),
  // TEMPORÁRIO (desenvolvimento/validação local, enquanto o envio de e-mail não está configurado): exigir e-mail verificado
  // para criar empresa (R10). Padrão: exigido em produção, dispensado fora dela. Em produção `false` é recusado.
  // Variável do SERVIDOR; nada vindo do cliente a influencia. Ver docs/EMAIL-VERIFICATION-TEMPORARILY-DISABLED.md.
  REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false"]).optional(),
  // true somente atrás de proxy reverso confiável (Caddy/Nginx): faz req.ip vir de X-Forwarded-For.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const DEFAULT_DEV_ORIGIN = "http://localhost:5173"; // Vite

export type Env = Omit<
  z.infer<typeof envSchema>,
  | "ALLOWED_ORIGINS"
  | "OUTBOX_ENCRYPTION_KEYS"
  | "OUTBOX_CURRENT_KEY_ID"
  | "APP_BASE_URL"
  | "REQUIRE_EMAIL_VERIFICATION"
> & {
  REQUIRE_EMAIL_VERIFICATION: boolean;
  ALLOWED_ORIGINS: string[];
  APP_BASE_URL: string;
  OUTBOX_KEYRING: Keyring;
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
// Chave fixa e PÚBLICA, só para desenvolvimento e testes. Nunca é aceita em produção.
const DEV_KEY_ID = "dev";
const DEV_KEYRING = makeKeyring(
  new Map([[DEV_KEY_ID, Buffer.alloc(32, 7)]]),
  DEV_KEY_ID,
);

function parseOutboxKeyring(
  data: {
    NODE_ENV: string;
    OUTBOX_ENCRYPTION_KEYS?: string | undefined;
    OUTBOX_CURRENT_KEY_ID?: string | undefined;
  },
  invalid: string[],
): Keyring {
  const keys = data.OUTBOX_ENCRYPTION_KEYS?.trim();
  const current = data.OUTBOX_CURRENT_KEY_ID?.trim();
  if (!keys && !current && data.NODE_ENV !== "production") return DEV_KEYRING;
  try {
    if (!keys || !current) throw new KeyringError("ausente");
    return parseKeyring(keys, current);
  } catch {
    invalid.push("OUTBOX_ENCRYPTION_KEYS", "OUTBOX_CURRENT_KEY_ID");
    return DEV_KEYRING;
  }
}

function parseBaseUrl(
  raw: string | undefined,
  fallback: string,
  invalid: string[],
): string {
  if (!raw?.trim()) return fallback;
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo");
    return url.origin;
  } catch {
    invalid.push("APP_BASE_URL");
    return fallback;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  const invalid = result.success
    ? []
    : result.error.issues.map((i) => String(i.path[0] ?? "?"));
  const origins = result.success ? parseOrigins(result.data, invalid) : [];
  const keyring = result.success
    ? parseOutboxKeyring(result.data, invalid)
    : DEV_KEYRING;
  const baseUrl = result.success
    ? parseBaseUrl(
        result.data.APP_BASE_URL,
        origins[0] ?? "http://localhost:5173",
        invalid,
      )
    : "";
  if (
    result.success &&
    result.data.NODE_ENV === "production" &&
    result.data.REQUIRE_EMAIL_VERIFICATION === "false"
  )
    invalid.push("REQUIRE_EMAIL_VERIFICATION");
  if (!result.success || invalid.length > 0) {
    throw new EnvError(
      `Variáveis de ambiente inválidas ou ausentes: ${[...new Set(invalid)].join(", ")}`,
    );
  }
  const d = result.data;
  return {
    NODE_ENV: d.NODE_ENV,
    HOST: d.HOST,
    PORT: d.PORT,
    LOG_LEVEL: d.LOG_LEVEL,
    DATABASE_URL: d.DATABASE_URL,
    TRUST_PROXY: d.TRUST_PROXY,
    REQUIRE_EMAIL_VERIFICATION:
      d.REQUIRE_EMAIL_VERIFICATION === undefined
        ? d.NODE_ENV === "production"
        : d.REQUIRE_EMAIL_VERIFICATION === "true",
    ALLOWED_ORIGINS: origins,
    APP_BASE_URL: baseUrl,
    OUTBOX_KEYRING: keyring,
  };
}
