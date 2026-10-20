import net from "node:net";
import { z } from "zod";
import {
  KeyringError,
  makeKeyring,
  parseKeyring,
  type Keyring,
} from "../lib/email/keyring.ts";

const envSchema = z.object({
  // SEM padrão: a ausência de NODE_ENV não pode virar, em silêncio, um ambiente menos seguro (cookie sem Secure, chave
  // de outbox pública, verificação de e-mail dispensada...). Deve ser declarada: development | test | production.
  NODE_ENV: z.enum(["development", "test", "production"]),
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
  // Exigir e-mail verificado para criar empresa (R10). Padrão: EXIGIDO em todos os ambientes. `false` é uma dispensa
  // explícita só para desenvolvimento/teste e é RECUSADA em produção. Variável do SERVIDOR; nada vindo do cliente a influencia.
  REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false"]).optional(),
  // Provedor de e-mail (Resend). Os dois juntos ou nenhum: em produção são obrigatórios; fora dela, sem eles o e-mail
  // vai para o console. EMAIL_FROM é o remetente (domínio verificado no provedor), ex.: "Agendly <no-reply@exemplo.com>".
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Confiança em proxy reverso (define de onde vem `req.ip`, base de todos os rate limits). Valores aceitos:
  //   "false"            nenhum proxy: usa o IP da conexão (padrão fora de produção; em produção deve ser declarado);
  //   inteiro 1–10       NÚMERO DE PROXIES confiáveis à frente da API (ex.: 1 = Caddy/Nginx); o IP é o da conexão do
  //                      cliente ao primeiro proxy, lido da DIREITA do X-Forwarded-For (o que o cliente envia à esquerda
  //                      é ignorado);
  //   IPs/CIDRs          lista separada por vírgula dos proxies confiáveis (ex.: 10.0.0.0/8,127.0.0.1).
  // "true" é RECUSADO: confiaria em qualquer X-Forwarded-For e deixaria o cliente forjar o IP e fugir do rate limit.
  TRUST_PROXY: z.string().optional(),
});

const DEFAULT_DEV_ORIGIN = "http://localhost:5173"; // Vite

export type Env = Omit<
  z.infer<typeof envSchema>,
  | "ALLOWED_ORIGINS"
  | "OUTBOX_ENCRYPTION_KEYS"
  | "OUTBOX_CURRENT_KEY_ID"
  | "APP_BASE_URL"
  | "REQUIRE_EMAIL_VERIFICATION"
  | "TRUST_PROXY"
  | "RESEND_API_KEY"
  | "EMAIL_FROM"
> & {
  TRUST_PROXY: TrustProxy;
  /** Ausente (nunca em produção) ⇒ o e-mail vai para o console. */
  EMAIL_PROVIDER: { apiKey: string; from: string } | undefined;
  REQUIRE_EMAIL_VERIFICATION: boolean;
  ALLOWED_ORIGINS: string[];
  APP_BASE_URL: string;
  OUTBOX_KEYRING: Keyring;
};

export class EnvError extends Error {}

/** Forma aceita por `trustProxy` do Fastify: nada, nº de saltos ou lista de proxies confiáveis. */
export type TrustProxy = false | number | string[];

const MAX_PROXY_HOPS = 10;

function isProxyAddress(value: string): boolean {
  const [ip, mask, extra] = value.split("/");
  if (extra !== undefined || !ip || net.isIP(ip) === 0) return false;
  if (mask === undefined) return true;
  const bits = Number(mask);
  return /^\d{1,3}$/.test(mask) && bits <= (net.isIPv4(ip) ? 32 : 128);
}

function parseTrustProxy(
  data: { NODE_ENV: string; TRUST_PROXY?: string | undefined },
  invalid: string[],
): TrustProxy {
  const raw = data.TRUST_PROXY?.trim();
  if (raw === undefined || raw === "") {
    // Em produção a decisão é explícita: esquecer a variável atrás de um proxy faria todos os clientes dividirem o IP
    // do proxy (e o mesmo rate limit); declará-la sem proxy exige "false".
    if (data.NODE_ENV === "production") invalid.push("TRUST_PROXY");
    return false;
  }
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops >= 1 && hops <= MAX_PROXY_HOPS) return hops;
    invalid.push("TRUST_PROXY");
    return false;
  }
  const list = raw.split(",").map((v) => v.trim());
  if (list.every(isProxyAddress)) return list;
  invalid.push("TRUST_PROXY"); // inclui "true": confiar em todos os saltos permite forjar o IP
  return false;
}

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
      // Produção: só HTTPS (cookie Secure/__Host- e links de e-mail com token não podem trafegar em claro).
      if (data.NODE_ENV === "production" && url.protocol !== "https:")
        throw new Error("https");
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
  production: boolean,
): string {
  if (!raw?.trim()) return fallback;
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo");
    if (production && url.protocol !== "https:") throw new Error("https");
    return url.origin;
  } catch {
    invalid.push("APP_BASE_URL");
    return fallback;
  }
}

// Chave do Resend: prefixo `re_` e caracteres de token. É só uma checagem de FORMATO (pega colagem errada, espaço, aspas);
// não prova que a chave existe nem que pode enviar. O formato exato não é garantido pela documentação.
const RESEND_KEY_FORMAT = /^re_[A-Za-z0-9_]{16,200}$/;
const LOCAL_PART =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isEmailAddress(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2 || value.length > 254) return false;
  const [local, domain] = parts as [string, string];
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every((l) => DOMAIN_LABEL.test(l)) &&
    /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1] as string)
  );
}

/** `ana@dominio.com` ou `Nome <ana@dominio.com>` (formato documentado pelo Resend). */
export function isValidSender(value: string): boolean {
  const named = /^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/.exec(value);
  if (named)
    return (
      (named[1] as string).trim() !== "" && isEmailAddress(named[2] as string)
    );
  return isEmailAddress(value);
}

function parseEmailProvider(
  data: {
    NODE_ENV: string;
    RESEND_API_KEY?: string | undefined;
    EMAIL_FROM?: string | undefined;
  },
  invalid: string[],
): Env["EMAIL_PROVIDER"] {
  const apiKey = data.RESEND_API_KEY?.trim();
  const from = data.EMAIL_FROM?.trim();
  if (apiKey && from) {
    if (!isValidSender(from)) invalid.push("EMAIL_FROM");
    if (!RESEND_KEY_FORMAT.test(apiKey)) invalid.push("RESEND_API_KEY");
    return { apiKey, from };
  }
  // Metade configurada é erro em qualquer ambiente; nenhuma só é aceita fora de produção.
  if (apiKey || from || data.NODE_ENV === "production")
    invalid.push("RESEND_API_KEY", "EMAIL_FROM");
  return undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  const invalid = result.success
    ? []
    : result.error.issues.map((i) => String(i.path[0] ?? "?"));
  const origins = result.success ? parseOrigins(result.data, invalid) : [];
  const trustProxy = result.success
    ? parseTrustProxy(result.data, invalid)
    : false;
  const keyring = result.success
    ? parseOutboxKeyring(result.data, invalid)
    : DEV_KEYRING;
  const baseUrl = result.success
    ? parseBaseUrl(
        result.data.APP_BASE_URL,
        origins[0] ?? "http://localhost:5173",
        invalid,
        result.data.NODE_ENV === "production",
      )
    : "";
  const emailProvider = result.success
    ? parseEmailProvider(result.data, invalid)
    : undefined;
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
    TRUST_PROXY: trustProxy,
    // Exigida por padrão; só `false` explícito (e nunca em produção, recusado acima) a dispensa.
    REQUIRE_EMAIL_VERIFICATION: d.REQUIRE_EMAIL_VERIFICATION !== "false",
    EMAIL_PROVIDER: emailProvider,
    ALLOWED_ORIGINS: origins,
    APP_BASE_URL: baseUrl,
    OUTBOX_KEYRING: keyring,
  };
}
