export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Contrato com o provedor de e-mail (3.5). O provedor real é escolhido depois (V10); o núcleo só conhece isto. */
export interface EmailSender {
  /**
   * Deve respeitar `signal` (timeout). Lançar EmailSendError(permanent=true) só para falhas definitivas.
   * `idempotencyKey` é estável por mensagem da outbox (o mesmo valor em todas as tentativas dela).
   */
  send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey?: string },
  ): Promise<void>;
}

export class EmailSendError extends Error {
  /** true: não adianta tentar de novo (ex.: destinatário rejeitado em definitivo). */
  readonly permanent: boolean;
  /** Espera pedida pelo provedor (Retry-After); a outbox a respeita até o teto do backoff. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, permanent = false, retryAfterMs?: number) {
    super(message);
    this.name = "EmailSendError";
    this.permanent = permanent;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Implementação de captura: guarda as mensagens em memória (testes). */
export class CaptureEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Desenvolvimento: imprime a mensagem no terminal, INCLUINDO o link com o token (sem provedor real é a única
 * forma de concluir os fluxos). Por isso nunca é usada em produção (ver start.ts).
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.info(
      `\n--- e-mail (console, só desenvolvimento) ---\nPara: ${message.to}\nAssunto: ${message.subject}\n\n${message.text}\n---`,
    );
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const MAX_ERROR_BODY_CHARS = 2048;

/** Corpo de erro do Resend: `{ statusCode, name, message }`. Só `name` e `message` são lidos, e nunca vão a log/erro. */
async function readErrorBody(
  res: Response,
): Promise<{ name: string; message: string }> {
  try {
    const parsed: unknown = JSON.parse(
      (await res.text()).slice(0, MAX_ERROR_BODY_CHARS),
    );
    const o = (parsed ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "",
      message: typeof o.message === "string" ? o.message : "",
    };
  } catch {
    return { name: "", message: "" };
  }
}

/** Retry-After em segundos inteiros (a data HTTP não é interpretada). */
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return undefined;
  return Number(raw) * 1000;
}

/**
 * Definitivo (reenviar não adianta) × temporário, segundo a lista de erros da documentação do Resend. NÃO foi conferido
 * contra a API real.
 *  - 409 `invalid_idempotent_request` (mesma chave, corpo diferente) e 400/422 de requisição inválida: definitivos.
 *  - 400 que fala de chave de API, 401 e 403 (chave, permissão, domínio não verificado, cota de teste): configuração que o
 *    operador pode corrigir; a mensagem é tentada de novo até o limite da outbox.
 *  - 409 `concurrent_idempotent_requests`/`resource_locked`, 429, 408 e 5xx: temporários.
 *  - demais 4xx (404, 405...): erro nosso, definitivo.
 * O teste de "chave de API" no 400 é uma heurística sobre o texto: o Resend usa `validation_error` para os dois casos.
 */
export function classifyResendFailure(
  status: number,
  body: { name: string; message: string },
): boolean {
  if (status === 409)
    return (
      body.name !== "concurrent_idempotent_requests" &&
      body.name !== "resource_locked"
    );
  if (status === 400) return !/api key/i.test(body.message);
  if (status === 401 || status === 403) return false;
  if (status === 408 || status === 429 || status >= 500) return false;
  return status >= 400;
}

/**
 * Resend via HTTPS (sem SDK). NÃO foi validado contra a API real (sem credenciais); os testes usam `fetch` falso.
 * Erros nunca carregam a chave, o destinatário nem o corpo da mensagem/resposta (o link leva o token).
 */
export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  constructor(
    config: { apiKey: string; from: string },
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#apiKey = config.apiKey;
    this.#from = config.from;
    this.#fetch = fetchImpl;
  }

  async send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey?: string },
  ): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          // Documentado pelo Resend: até 256 caracteres, expira em 24 h. Mesma chave em toda tentativa da mesma mensagem.
          ...(options.idempotencyKey
            ? { "idempotency-key": options.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: this.#from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: options.signal,
      });
    } catch {
      throw new EmailSendError("falha de rede ao chamar o Resend");
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {}); // libera a conexão; o id devolvido não é usado
      return;
    }
    const body = await readErrorBody(res); // consome (e fecha) o corpo da resposta
    throw new EmailSendError(
      `Resend respondeu HTTP ${res.status}${body.name ? ` (${body.name.slice(0, 60).replace(/[^\w-]/g, "")})` : ""}`,
      classifyResendFailure(res.status, body),
      res.status === 429 || res.status === 503 || res.status === 409
        ? parseRetryAfterMs(res)
        : undefined,
    );
  }
}

export type ProviderCheck =
  | { status: "ok" }
  | { status: "inconclusive"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Verificação de configuração na subida (produção): a chave existe e o domínio do remetente está verificado.
 * Só erro DEFINITIVO de configuração é "invalid"; rede fora, 429 e 5xx são "inconclusive" (não derrubam a API por uma
 * instabilidade do provedor). Chave restrita a envio não pode listar domínios: "inconclusive". Baseada na documentação
 * do Resend (GET /domains), NÃO conferida contra a API real. Os motivos nunca incluem a chave.
 */
export async function checkResendConfig(
  config: { apiKey: string; from: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<ProviderCheck> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/domains?limit=100", {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "inconclusive", reason: "Resend inacessível" };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    if (res.status === 401 && body.name === "restricted_api_key")
      return {
        status: "inconclusive",
        reason: "chave restrita a envio: domínio não verificável",
      };
    if (res.status === 400 || res.status === 401 || res.status === 403)
      return {
        status: "invalid",
        reason: `Resend recusou a chave (HTTP ${res.status})`,
      };
    return {
      status: "inconclusive",
      reason: `Resend respondeu HTTP ${res.status}`,
    };
  }
  let list: {
    data?: { name?: unknown; status?: unknown }[];
    has_more?: boolean;
  };
  try {
    list = (await res.json()) as typeof list;
  } catch {
    return { status: "inconclusive", reason: "resposta ilegível do Resend" };
  }
  const fromDomain = config.from
    .slice(config.from.lastIndexOf("@") + 1)
    .replace(/>$/, "")
    .toLowerCase();
  const match = (list.data ?? []).find((d) => {
    const name = typeof d.name === "string" ? d.name.toLowerCase() : "";
    return (
      name !== "" && (fromDomain === name || fromDomain.endsWith(`.${name}`))
    );
  });
  if (!match)
    return list.has_more
      ? {
          status: "inconclusive",
          reason: "domínio não encontrado na 1ª página",
        }
      : {
          status: "invalid",
          reason: `domínio do remetente (${fromDomain}) não está cadastrado no Resend`,
        };
  return match.status === "verified"
    ? { status: "ok" }
    : {
        status: "invalid",
        reason: `domínio do remetente (${fromDomain}) não está verificado no Resend`,
      };
}
