// Cliente HTTP único: cabeçalhos, CSRF, formato de erro e tratamento CENTRAL de 401/409/403 (unitário, com MSW).
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  NETWORK_ERROR_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  messageOf,
} from "../api/client";
import { server } from "./server";

const envelope = (
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) =>
  HttpResponse.json(
    { error: { code, message, requestId: "r1" } },
    { status, ...(headers ? { headers } : {}) },
  );

/** `then` do caminho de sucesso: se a requisição NÃO falhou, o teste deve quebrar em vez de seguir com `undefined`. */
const failed = (): never => {
  throw new Error("a requisição deveria ter falhado");
};

function events() {
  return {
    onUnauthorized: vi.fn(),
    onActiveOrgChanged: vi.fn(),
    onOrganizationRequired: vi.fn(),
  };
}

describe("requisição", () => {
  it("GET não envia corpo nem Content-Type; usa o cookie da mesma origem e pede JSON", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    const client = new ApiClient({}, fetchSpy);
    await client.request("GET", "/api/me");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/me`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe("same-origin");
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });

  it("toda escrita leva Content-Type JSON, inclusive sem corpo (o backend exige: CSRF, 3.1)", async () => {
    const seen: Array<{ method: string; type: string | null; body: string }> =
      [];
    server.use(
      http.all("*/api/echo", async ({ request }) => {
        seen.push({
          method: request.method,
          type: request.headers.get("content-type"),
          body: await request.text(),
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new ApiClient();
    await client.request("POST", "/api/echo");
    await client.request("PATCH", "/api/echo", { body: { a: 1 } });
    await client.request("PUT", "/api/echo", { body: { b: [1, 2] } });
    await client.request("DELETE", "/api/echo");
    expect(seen).toEqual([
      { method: "POST", type: "application/json", body: "{}" },
      { method: "PATCH", type: "application/json", body: '{"a":1}' },
      { method: "PUT", type: "application/json", body: '{"b":[1,2]}' },
      { method: "DELETE", type: "application/json", body: "{}" },
    ]);
  });

  it("X-Active-Org só é enviado depois de setActiveOrg e some com null", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get("*/api/x", ({ request }) => {
        seen.push(request.headers.get("x-active-org"));
        return HttpResponse.json({});
      }),
    );
    const client = new ApiClient();
    await client.request("GET", "/api/x");
    client.setActiveOrg("salao-da-ana");
    await client.request("GET", "/api/x");
    client.setActiveOrg(null);
    await client.request("GET", "/api/x");
    expect(seen).toEqual([null, "salao-da-ana", null]);
  });

  it("204 devolve undefined; 200 devolve o JSON", async () => {
    server.use(
      http.post(
        "*/api/no-content",
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.get("*/api/data", () => HttpResponse.json({ n: 1 })),
    );
    const client = new ApiClient();
    expect(await client.request("POST", "/api/no-content")).toBeUndefined();
    expect(await client.request("GET", "/api/data")).toEqual({ n: 1 });
  });

  it("cancelamento (AbortSignal) propaga AbortError e não vira erro de rede", async () => {
    server.use(
      http.get(
        "*/api/slow",
        async () => new Promise<Response>(() => undefined),
      ),
    );
    const controller = new AbortController();
    const pending = new ApiClient().request("GET", "/api/slow", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("erros", () => {
  it("lê o envelope { error: { code, message, details, requestId } } e o Retry-After", async () => {
    server.use(
      http.post("*/api/limited", () =>
        HttpResponse.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Muitas tentativas.",
              details: [{ path: "x" }],
              requestId: "abc",
            },
          },
          { status: 429, headers: { "retry-after": "42" } },
        ),
      ),
    );
    const err = await new ApiClient()
      .request("POST", "/api/limited")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "Muitas tentativas.",
      details: [{ path: "x" }],
      requestId: "abc",
      retryAfterSeconds: 42,
      handled: false,
    });
  });

  it("corpo que não é JSON (erro de proxy) e 5xx => mensagem genérica, sem vazar o corpo", async () => {
    server.use(
      http.get(
        "*/api/proxy",
        () =>
          new HttpResponse("<html>502 Bad Gateway nginx/1.2</html>", {
            status: 502,
          }),
      ),
      http.get("*/api/busy", () =>
        envelope(
          503,
          "TEMPORARILY_BUSY",
          "O sistema está ocupado. Tente novamente em instantes.",
          { "retry-after": "1" },
        ),
      ),
    );
    const client = new ApiClient();
    const proxy = await client
      .request("GET", "/api/proxy")
      .then(failed, (e: unknown) => e as ApiError);
    expect(proxy).toMatchObject({
      status: 502,
      code: "UNEXPECTED_ERROR",
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    expect(proxy.message).not.toMatch(/nginx|html/i);
    const busy = await client
      .request("GET", "/api/busy")
      .then(failed, (e: unknown) => e as ApiError);
    expect(busy).toMatchObject({
      status: 503,
      code: "TEMPORARILY_BUSY",
      retryAfterSeconds: 1,
    });
  });

  it("falha de rede => ApiError NETWORK_ERROR em pt-BR; messageOf nunca expõe erros desconhecidos", async () => {
    const client = new ApiClient({}, async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:3000");
    });
    const err = await client
      .request("GET", "/api/me")
      .then(failed, (e: unknown) => e as ApiError);
    expect(err).toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: NETWORK_ERROR_MESSAGE,
    });
    expect(err.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    expect(messageOf(err)).toBe(NETWORK_ERROR_MESSAGE);
    expect(messageOf(new Error("segredo interno"))).toBe(
      UNEXPECTED_ERROR_MESSAGE,
    );
    expect(messageOf("x")).toBe(UNEXPECTED_ERROR_MESSAGE);
  });
});

describe("tratamento central", () => {
  it("401 em rota autenticada: aciona onUnauthorized UMA vez e marca o erro como tratado", async () => {
    server.use(
      http.get("*/api/private", () =>
        envelope(401, "UNAUTHENTICATED", "Sessão inválida ou expirada."),
      ),
    );
    const ev = events();
    const err = await new ApiClient(ev)
      .request("GET", "/api/private")
      .then(failed, (e: unknown) => e as ApiError);
    expect(ev.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ status: 401, handled: true });
    expect(ev.onActiveOrgChanged).not.toHaveBeenCalled();
  });

  it("401 em rota anônima (login, /api/me): NÃO aciona o tratador e o erro vai para a tela", async () => {
    server.use(
      http.post("*/api/auth/login", () =>
        envelope(401, "INVALID_CREDENTIALS", "E-mail ou senha incorretos."),
      ),
    );
    const ev = events();
    const err = await new ApiClient(ev)
      .request("POST", "/api/auth/login", { anonymous: true, body: {} })
      .then(failed, (e: unknown) => e as ApiError);
    expect(ev.onUnauthorized).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: "INVALID_CREDENTIALS", handled: false });
  });

  it("409 ACTIVE_ORG_CHANGED: aciona o recarregamento; outros 409 (conflito de negócio) não", async () => {
    server.use(
      http.get("*/api/changed", () =>
        envelope(
          409,
          "ACTIVE_ORG_CHANGED",
          "A empresa ativa mudou em outra aba. Recarregue a página.",
        ),
      ),
      http.post("*/api/slug", () =>
        envelope(409, "SLUG_UNAVAILABLE", "Este endereço já está em uso."),
      ),
      http.post("*/api/slot", () =>
        envelope(
          409,
          "SLOT_UNAVAILABLE",
          "Este horário não está mais disponível.",
        ),
      ),
    );
    const ev = events();
    const client = new ApiClient(ev);
    const changed = await client
      .request("GET", "/api/changed")
      .then(failed, (e: unknown) => e as ApiError);
    expect(ev.onActiveOrgChanged).toHaveBeenCalledTimes(1);
    expect(changed.handled).toBe(true);
    for (const path of ["/api/slug", "/api/slot"]) {
      const e = await client
        .request("POST", path)
        .then(failed, (x: unknown) => x as ApiError);
      expect(e.handled, path).toBe(false);
    }
    expect(ev.onActiveOrgChanged).toHaveBeenCalledTimes(1);
  });

  it("403 sem empresa ativa (NO_ACTIVE_ORGANIZATION, ORGANIZATION_ACCESS_REVOKED) é central; 403 de permissão não", async () => {
    server.use(
      http.get("*/api/a", () =>
        envelope(
          403,
          "NO_ACTIVE_ORGANIZATION",
          "Selecione uma empresa para continuar.",
        ),
      ),
      http.get("*/api/b", () =>
        envelope(
          403,
          "ORGANIZATION_ACCESS_REVOKED",
          "Você não tem mais acesso a esta empresa.",
        ),
      ),
      http.get("*/api/c", () =>
        envelope(403, "FORBIDDEN", "Você não tem permissão para esta ação."),
      ),
    );
    const ev = events();
    const client = new ApiClient(ev);
    const results = await Promise.all(
      ["/api/a", "/api/b", "/api/c"].map((p) =>
        client.request("GET", p).then(failed, (e: unknown) => e as ApiError),
      ),
    );
    expect(ev.onOrganizationRequired.mock.calls).toEqual([
      ["NO_ACTIVE_ORGANIZATION"],
      ["ORGANIZATION_ACCESS_REVOKED"],
    ]);
    expect(results.map((r) => r.handled)).toEqual([true, true, false]);
  });

  it("os tratadores podem ser trocados em tempo de execução (setEvents)", async () => {
    server.use(
      http.get("*/api/private", () => envelope(401, "UNAUTHENTICATED", "x")),
    );
    const first = events();
    const second = events();
    const client = new ApiClient(first);
    client.setEvents(second);
    await client.request("GET", "/api/private").catch(() => undefined);
    expect(first.onUnauthorized).not.toHaveBeenCalled();
    expect(second.onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
