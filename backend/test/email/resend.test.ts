// Sender do Resend e verificação de configuração com fetch FALSO. Nada aqui fala com a rede nem prova que a integração real
// funciona: os códigos e nomes de erro seguem a documentação do Resend, ainda NÃO conferida contra a API.
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/config/env.ts";
import {
  ConsoleEmailSender,
  EmailSendError,
  ResendEmailSender,
  checkResendConfig,
  classifyResendFailure,
  type EmailMessage,
} from "../../src/lib/email/sender.ts";
import { startServer } from "../../src/start.ts";

const API_KEY = "re_chave_de_teste_nao_real_0123456789";
const FROM = "Agendly <no-reply@example.com>";
const message: EmailMessage = {
  to: "ana@example.com",
  subject: "Confirme seu e-mail",
  text: "https://app.example.com/verificar-email#token=SEGREDO-NO-LINK",
  html: "<p>link</p>",
};
const signal = () => new AbortController().signal;
const reply = (status: number, body = "{}", headers: HeadersInit = {}) =>
  vi.fn(
    async () => new Response(body, { status, headers }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const sender = (fetchImpl: typeof fetch) =>
  new ResendEmailSender({ apiKey: API_KEY, from: FROM }, fetchImpl);
const calls = (f: unknown) =>
  (f as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
const fail = async (
  f: typeof fetch,
  extra: { idempotencyKey?: string } = {},
): Promise<EmailSendError> => {
  try {
    await sender(f).send(message, { signal: signal(), ...extra });
  } catch (e) {
    return e as EmailSendError;
  }
  throw new Error("era esperado um erro");
};

describe("ResendEmailSender", () => {
  it("envia POST autenticado com remetente, destinatário e conteúdo; respeita o signal", async () => {
    const f = reply(200, '{"id":"abc"}');
    const s = signal();
    await sender(f).send(message, { signal: s });
    const [url, init] = calls(f)[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(init.signal).toBe(s);
    expect(JSON.parse(String(init.body))).toEqual({
      from: FROM,
      to: ["ana@example.com"],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("envia o Idempotency-Key recebido (e nenhum cabeçalho quando não há chave)", async () => {
    const f = reply(200);
    await sender(f).send(message, { signal: signal(), idempotencyKey: "k-1" });
    expect(
      (calls(f)[0]![1].headers as Record<string, string>)["idempotency-key"],
    ).toBe("k-1");
    const g = reply(200);
    await sender(g).send(message, { signal: signal() });
    expect(
      (calls(g)[0]![1].headers as Record<string, string>)["idempotency-key"],
    ).toBeUndefined();
  });

  it("fecha o corpo da resposta, de sucesso ou de falha", async () => {
    for (const status of [200, 500]) {
      const res = new Response('{"name":"application_error"}', { status });
      await sender(vi.fn(async () => res) as unknown as typeof fetch)
        .send(message, { signal: signal() })
        .catch(() => {});
      expect(res.bodyUsed || res.body?.locked || res.body === null).toBe(true);
    }
  });

  it("falha de rede é temporária e a mensagem não vaza nada", async () => {
    const net = vi.fn(async () => {
      throw new TypeError(`fetch failed ${API_KEY} ${message.text}`);
    }) as unknown as typeof fetch;
    const err = await fail(net);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.permanent).toBe(false);
  });

  it("Retry-After (segundos) vira retryAfterMs em 429/503/409; ignora valor inválido ou outros status", async () => {
    expect(
      (await fail(reply(429, "{}", { "retry-after": "17" }))).retryAfterMs,
    ).toBe(17_000);
    expect(
      (await fail(reply(503, "{}", { "retry-after": "2" }))).retryAfterMs,
    ).toBe(2_000);
    expect(
      (await fail(reply(429, "{}", { "retry-after": "amanhã" }))).retryAfterMs,
    ).toBeUndefined();
    expect(
      (await fail(reply(429, "{}", { "retry-after": "-5" }))).retryAfterMs,
    ).toBeUndefined();
    expect(
      (await fail(reply(500, "{}", { "retry-after": "9" }))).retryAfterMs,
    ).toBeUndefined();
    expect((await fail(reply(429))).retryAfterMs).toBeUndefined();
  });

  it("a mensagem de erro nunca contém a chave, o destinatário, o token nem o corpo da resposta", async () => {
    const body = JSON.stringify({
      name: "validation_error",
      message: `rejeitado ${API_KEY} ana@example.com SEGREDO-NO-LINK`,
    });
    const err = await fail(reply(422, body));
    const net = await fail(
      vi.fn(async () => {
        throw new Error(`${API_KEY} SEGREDO-NO-LINK`);
      }) as unknown as typeof fetch,
    );
    for (const e of [err, net]) {
      const text = `${e.message}${e.stack ?? ""}${JSON.stringify(e)}`;
      for (const secret of [API_KEY, "SEGREDO-NO-LINK", "ana@example.com"])
        expect(text).not.toContain(secret);
    }
    // o nome do erro (identificador curto) pode aparecer; lixo com símbolos é filtrado
    const odd = await fail(reply(422, JSON.stringify({ name: "x y<>\n" })));
    expect(odd.message).not.toMatch(/[<>\n]/);
  });
});

describe("classificação de erros do Resend (segundo a documentação, não validada na API)", () => {
  const body = (name = "", message = "") => ({ name, message });
  it.each([
    [400, body("validation_error", "The `to` field is invalid"), true],
    [400, body("invalid_idempotency_key"), true],
    [422, body("missing_required_field"), true],
    [422, body("invalid_parameter"), true],
    [409, body("invalid_idempotent_request"), true],
    [404, body("not_found"), true],
    [405, body("method_not_allowed"), true],
    // configuração corrigível pelo operador: tenta de novo
    [400, body("validation_error", "API key is invalid"), false],
    [401, body("missing_api_key"), false],
    [401, body("restricted_api_key"), false],
    [403, body("validation_error", "The domain is not verified"), false],
    [403, body("suspended_api_key"), false],
    // temporários
    [409, body("concurrent_idempotent_requests"), false],
    [409, body("resource_locked"), false],
    [429, body("rate_limit_exceeded"), false],
    [429, body("daily_quota_exceeded"), false],
    [500, body("application_error"), false],
    [503, body("service_unavailable"), false],
    [408, body(), false],
  ])("HTTP %i %j => permanente=%s", (status, b, permanent) => {
    expect(classifyResendFailure(status, b)).toBe(permanent);
  });

  it("o corpo JSON da resposta decide a classe pelo sender; corpo ilegível não quebra", async () => {
    expect(
      (await fail(reply(409, '{"name":"invalid_idempotent_request"}')))
        .permanent,
    ).toBe(true);
    expect(
      (await fail(reply(409, '{"name":"concurrent_idempotent_requests"}')))
        .permanent,
    ).toBe(false);
    expect((await fail(reply(400, "<html>não é json</html>"))).permanent).toBe(
      true,
    );
    expect((await fail(reply(502, "<html>"))).permanent).toBe(false);
  });
});

describe("checkResendConfig (verificação na subida)", () => {
  const cfg = { apiKey: API_KEY, from: FROM };
  const domains = (data: unknown[], has_more = false) =>
    reply(200, JSON.stringify({ object: "list", has_more, data }));

  it("domínio do remetente verificado (ou subdomínio dele) => ok; usa a chave no Bearer", async () => {
    const f = domains([{ name: "example.com", status: "verified" }]);
    expect(await checkResendConfig(cfg, f)).toEqual({ status: "ok" });
    expect(
      (calls(f)[0]![1].headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${API_KEY}`);
    const sub = { apiKey: API_KEY, from: "no-reply@mail.example.com" };
    expect(
      await checkResendConfig(
        sub,
        domains([{ name: "example.com", status: "verified" }]),
      ),
    ).toEqual({ status: "ok" });
  });

  it("domínio ausente ou não verificado => invalid; sem a chave no motivo", async () => {
    for (const f of [
      domains([{ name: "outro.com", status: "verified" }]),
      domains([{ name: "example.com", status: "pending" }]),
      domains([]),
    ]) {
      const r = await checkResendConfig(cfg, f);
      expect(r.status).toBe("invalid");
      expect(JSON.stringify(r)).not.toContain(API_KEY);
    }
  });

  it("lista paginada sem o domínio na 1ª página => inconclusivo, não inválido", async () => {
    expect(
      (
        await checkResendConfig(
          cfg,
          domains([{ name: "x.com", status: "verified" }], true),
        )
      ).status,
    ).toBe("inconclusive");
  });

  it("chave recusada (400/401/403) => invalid; chave restrita a envio => inconclusivo", async () => {
    for (const status of [400, 401, 403])
      expect(
        (
          await checkResendConfig(
            cfg,
            reply(status, '{"name":"validation_error"}'),
          )
        ).status,
      ).toBe("invalid");
    expect(
      (
        await checkResendConfig(
          cfg,
          reply(401, '{"name":"restricted_api_key"}'),
        )
      ).status,
    ).toBe("inconclusive");
  });

  it("rede fora, timeout, 429, 5xx e resposta ilegível => inconclusivo (não derruba a API)", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    for (const f of [down, reply(429), reply(500), reply(200, "não é json")])
      expect((await checkResendConfig(cfg, f)).status).toBe("inconclusive");
  });
});

describe("escolha do sender e verificação na inicialização", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    NODE_ENV: "test",
  };
  const fakeDb = () => ({
    prisma: {} as never,
    check: async () => {},
    close: async () => {},
  });
  const prodEnv = {
    ...base,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://app.example.com",
    TRUST_PROXY: "false",
    OUTBOX_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}`,
    OUTBOX_CURRENT_KEY_ID: "k1",
    RESEND_API_KEY: API_KEY,
    EMAIL_FROM: FROM,
  };

  async function senderChosen(extra: Record<string, string>) {
    let chosen: unknown;
    const running = await startServer(
      { ...loadEnv({ ...base, ...extra }), PORT: 0, LOG_LEVEL: "silent" },
      {
        createDatabase: fakeDb,
        startJobs: (deps) => {
          chosen = deps.sender;
          return { stop: async () => {} };
        },
      },
    );
    await running.shutdown();
    return chosen;
  }

  it("com RESEND_API_KEY + EMAIL_FROM usa o Resend; sem eles (fora de produção) usa o console", async () => {
    expect(
      await senderChosen({ RESEND_API_KEY: API_KEY, EMAIL_FROM: FROM }),
    ).toBeInstanceOf(ResendEmailSender);
    expect(await senderChosen({})).toBeInstanceOf(ConsoleEmailSender);
  });

  it("fora de produção a verificação do provedor NÃO é feita", async () => {
    const check = vi.fn();
    const running = await startServer(
      {
        ...loadEnv({ ...base, RESEND_API_KEY: API_KEY, EMAIL_FROM: FROM }),
        PORT: 0,
        LOG_LEVEL: "silent",
      },
      {
        createDatabase: fakeDb,
        startJobs: () => ({ stop: async () => {} }),
        checkEmailProvider: check,
      },
    );
    await running.shutdown();
    expect(check).not.toHaveBeenCalled();
  });

  it("produção: configuração inválida impede a subida ANTES de abrir banco/porta, sem vazar a chave", async () => {
    const createDatabase = vi.fn(fakeDb);
    const err = await startServer(
      { ...loadEnv(prodEnv), PORT: 0, LOG_LEVEL: "silent" },
      {
        createDatabase,
        checkEmailProvider: async () => ({
          status: "invalid",
          reason:
            "domínio do remetente (example.com) não está verificado no Resend",
        }),
      },
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/não está verificado/);
    expect((err as Error).message).not.toContain(API_KEY);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("produção: verificação inconclusiva sobe, com aviso que não afirma entrega validada", async () => {
    const warns: string[] = [];
    const running = await startServer(
      { ...loadEnv(prodEnv), PORT: 0, LOG_LEVEL: "silent" },
      {
        createDatabase: fakeDb,
        startJobs: () => ({ stop: async () => {} }),
        checkEmailProvider: async () => ({
          status: "inconclusive",
          reason: "Resend inacessível",
        }),
        logWarn: (m) => warns.push(m),
      },
    );
    await running.shutdown();
    expect(warns.join()).toMatch(/NÃO foi confirmada/);
    expect(warns.join()).not.toContain(API_KEY);
  });

  it("produção: verificação ok sobe sem avisos", async () => {
    const warns: string[] = [];
    const running = await startServer(
      { ...loadEnv(prodEnv), PORT: 0, LOG_LEVEL: "silent" },
      {
        createDatabase: fakeDb,
        startJobs: () => ({ stop: async () => {} }),
        checkEmailProvider: async () => ({ status: "ok" }),
        logWarn: (m) => warns.push(m),
      },
    );
    await running.shutdown();
    expect(warns).toEqual([]);
  });
});
