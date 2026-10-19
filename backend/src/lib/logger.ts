import type { FastifyServerOptions } from "fastify";

const REDACTED_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "newPassword",
  "token",
];

// Cobre cabeçalhos de requisição/resposta e campos sensíveis no topo, em body e em um nível aninhado.
export const REDACT_PATHS = [
  ...REDACTED_KEYS.flatMap((k) => [
    `req.headers["${k}"]`,
    `res.headers["${k}"]`,
    `headers["${k}"]`,
    `body.${k}`,
    `req.body.${k}`,
    `*.${k}`,
  ]),
  ...REDACTED_KEYS.filter((k) => !k.includes("-")),
];

const CENSOR = "[REDACTED]";
const MAX_CAUSE_DEPTH = 3;
const MAX_AGGREGATED = 5;

/** Valores que nunca devem aparecer em log: a senha embutida na URL do banco. */
export function collectSecrets(source: {
  DATABASE_URL?: string | undefined;
}): string[] {
  const raw = source.DATABASE_URL;
  if (!raw) return [];
  try {
    const { password } = new URL(raw);
    // Só a senha: host, porta e banco são úteis para diagnóstico (o userinfo é coberto por sanitizeText).
    return password
      ? [...new Set([password, decodeURIComponent(password)])]
      : [];
  } catch {
    return [raw]; // URL malformada pode conter a senha em qualquer ponto: oculta o valor inteiro.
  }
}

/** Remove credenciais conhecidas e padrões comuns (userinfo de URL, password=…, Bearer …) de um texto. */
export function sanitizeText(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  // Mais longos primeiro: a URL inteira antes da senha isolada.
  for (const s of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(CENSOR);
  }
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${CENSOR}@`)
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)[^\s,;&)'"]+/gi,
      `$1$2${CENSOR}`,
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${CENSOR}`);
}

/**
 * Converte qualquer valor lançado em um objeto seguro para log. Só `message`, `stack` e poucos campos
 * operacionais (code/errno/syscall) são mantidos; as demais propriedades do erro (ex.: `detail` do
 * pg, que pode conter dados pessoais, ou um `connectionString`) são descartadas.
 */
export interface SanitizedError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

export function sanitizeError(
  err: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): SanitizedError {
  if (!(err instanceof Error)) {
    return {
      type: "NonError",
      message:
        typeof err === "string"
          ? sanitizeText(err, secrets)
          : `valor lançado (${typeof err})`,
      stack: "",
    };
  }
  const out: SanitizedError = {
    type: err.name,
    message: sanitizeText(err.message, secrets),
    stack: err.stack ? sanitizeText(err.stack, secrets) : "",
  };
  const extra = err as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
  };
  for (const key of ["code", "errno", "syscall"] as const) {
    const v = extra[key];
    if (typeof v === "string") out[key] = sanitizeText(v, secrets);
    else if (typeof v === "number") out[key] = v;
  }
  if (depth < MAX_CAUSE_DEPTH) {
    if (err.cause !== undefined)
      out.cause = sanitizeError(err.cause, secrets, depth + 1);
    if (err instanceof AggregateError) {
      out.errors = err.errors
        .slice(0, MAX_AGGREGATED)
        .map((e) => sanitizeError(e, secrets, depth + 1));
    }
  }
  return out;
}

/** Linha de log (JSON) para erros fora do logger do Fastify, ex.: falha de inicialização. */
export function formatErrorForLog(
  err: unknown,
  message: string,
  secrets: readonly string[] = [],
): string {
  return JSON.stringify({
    level: "error",
    msg: message,
    err: sanitizeError(err, secrets),
  });
}

export function buildLoggerOptions(
  env: { LOG_LEVEL: string; DATABASE_URL?: string | undefined },
  stream?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions["logger"]> {
  const secrets = collectSecrets(env);
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    serializers: { err: (err: unknown) => sanitizeError(err, secrets) },
    ...(stream ? { stream } : {}),
  };
}
