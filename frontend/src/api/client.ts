// Cliente HTTP ÚNICO do frontend (seção 2). Responsabilidades:
// - falar com a API por cookie de sessão HttpOnly (nenhum token passa pelo JavaScript nem por localStorage);
// - cumprir a proteção CSRF do backend (3.1): `Content-Type: application/json` em todo método que altera estado,
//   inclusive com corpo vazio (`{}`); o navegador acrescenta o `Origin` sozinho;
// - enviar `X-Active-Org: <slug>` como asserção de consistência entre abas (4.1);
// - tratar de forma CENTRAL 401 (sessão), 409 ACTIVE_ORG_CHANGED e 403 sem empresa ativa (7), para que nenhuma tela
//   precise repetir isso. O erro é lançado de qualquer forma, marcado com `handled` para a tela não exibi-lo duas vezes.

export const NETWORK_ERROR_MESSAGE =
  "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.";
export const UNEXPECTED_ERROR_MESSAGE =
  "Algo deu errado. Tente novamente em instantes.";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /** Segundos sugeridos pelo servidor (cabeçalho Retry-After em 429/503). */
  readonly retryAfterSeconds: number | undefined;
  /** true: um tratador central já reagiu (ex.: voltou ao login); a tela não deve mostrar o erro. */
  handled = false;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** Mensagem segura para mostrar ao usuário a partir de qualquer erro capturado. */
export function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : UNEXPECTED_ERROR_MESSAGE;
}

export interface ApiEvents {
  /** 401 em rota autenticada: a sessão acabou ou foi revogada. */
  onUnauthorized: () => void;
  /** 409 ACTIVE_ORG_CHANGED: outra aba trocou a empresa ativa; o app deve recarregar. */
  onActiveOrgChanged: () => void;
  /** 403 NO_ACTIVE_ORGANIZATION / ORGANIZATION_ACCESS_REVOKED: é preciso escolher uma empresa. */
  onOrganizationRequired: (code: string) => void;
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Rotas em que um 401 NÃO significa "sessão expirada" (login, cadastro, recuperação, verificação e a consulta
   * inicial de `/api/me`): o erro é devolvido à tela sem acionar o tratador central.
   */
  anonymous?: boolean;
  /** Cabeçalhos adicionais (ex.: `Idempotency-Key`). Não substituem `content-type` nem `x-active-org`. */
  headers?: Record<string, string>;
}

const NO_ACTIVE_ORG_CODES = new Set([
  "NO_ACTIVE_ORGANIZATION",
  "ORGANIZATION_ACCESS_REVOKED",
]);

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class ApiClient {
  private events: Partial<ApiEvents>;
  private activeOrg: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    events: Partial<ApiEvents> = {},
    fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    this.events = events;
    this.fetchImpl = fetchImpl;
  }

  setEvents(events: Partial<ApiEvents>): void {
    this.events = events;
  }

  /** Slug da empresa ativa exibida; enviado em `X-Active-Org`. `null` não envia o cabeçalho. */
  setActiveOrg(slug: string | null): void {
    this.activeOrg = slug;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
    };
    if (this.activeOrg) headers["x-active-org"] = this.activeOrg;
    let body: string | undefined;
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${window.location.origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: "same-origin",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      // Cancelamento pedido pelo chamador não é falha de rede (o `name` basta: o DOMException pode vir de outro realm).
      if (
        options.signal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      )
        throw err;
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message: NETWORK_ERROR_MESSAGE,
      });
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw this.toError(response, await readBody(response), options);
  }

  private toError(
    response: Response,
    parsed: {
      code: string;
      message: string;
      details?: unknown;
      requestId?: string;
    } | null,
    options: RequestOptions,
  ): ApiError {
    const err = new ApiError({
      status: response.status,
      code: parsed?.code ?? "UNEXPECTED_ERROR",
      message: parsed?.message ?? UNEXPECTED_ERROR_MESSAGE,
      details: parsed?.details,
      requestId: parsed?.requestId,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
    if (response.status === 401 && !options.anonymous) {
      err.handled = true;
      this.events.onUnauthorized?.();
    } else if (response.status === 409 && err.code === "ACTIVE_ORG_CHANGED") {
      err.handled = true;
      this.events.onActiveOrgChanged?.();
    } else if (response.status === 403 && NO_ACTIVE_ORG_CODES.has(err.code)) {
      err.handled = true;
      this.events.onOrganizationRequired?.(err.code);
    }
    return err;
  }
}

async function readBody(response: Response): Promise<{
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
} | null> {
  try {
    const json = (await response.json()) as {
      error?: {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        requestId?: unknown;
      };
    };
    const e = json.error;
    if (!e || typeof e.code !== "string" || typeof e.message !== "string")
      return null;
    return {
      code: e.code,
      message: e.message,
      details: e.details,
      ...(typeof e.requestId === "string" ? { requestId: e.requestId } : {}),
    };
  } catch {
    return null; // corpo que não é JSON (ex.: erro de proxy): cai na mensagem genérica
  }
}
