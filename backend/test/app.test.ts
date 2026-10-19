import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.ts";
import { buildLoggerOptions } from "../src/lib/logger.ts";
import { AppError } from "../src/lib/errors.ts";

const UUID = /^[0-9a-f-]{36}$/;
let lines: string[] = [];
const stream = new Writable({
  write(chunk, _enc, cb) {
    lines.push(String(chunk));
    cb();
  },
});

function make(checkDatabase: () => Promise<void> = async () => {}) {
  lines = [];
  const app = buildApp({
    logger: buildLoggerOptions({ LOG_LEVEL: "debug" }, stream),
    checkDatabase,
  });
  app.get("/test/validate", async () =>
    z.object({ n: z.number() }).parse({ n: "x" }),
  );
  app.get("/test/app-error", async () => {
    throw new AppError("CUSTOM", 409, "Conflito.", { a: 1 });
  });
  app.get("/test/boom", async () => {
    throw new Error("detalhe interno secreto");
  });
  app.post("/test/echo", async (req) => req.body);
  return app;
}

let app: ReturnType<typeof make>;
afterEach(() => app?.close());

describe("health e ready", () => {
  it("GET /api/health => 200", async () => {
    app = make();
    const res = await app.inject("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("GET /api/ready => 200 com banco ok", async () => {
    app = make();
    const res = await app.inject("/api/ready");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("GET /api/ready => 503 NOT_READY sem vazar o erro do banco", async () => {
    app = make(async () => {
      throw new Error("senha do banco: hunter2");
    });
    const res = await app.inject("/api/ready");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NOT_READY");
    expect(res.body).not.toContain("hunter2");
  });
});

describe("formato padrão de erro", () => {
  it("404 para rota inexistente", async () => {
    app = make();
    const res = await app.inject("/api/nao-existe");
    expect(res.statusCode).toBe(404);
    const { error } = res.json();
    expect(error.code).toBe("NOT_FOUND");
    expect(error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("400 VALIDATION_ERROR para erro do Zod", async () => {
    app = make();
    const res = await app.inject("/test/validate");
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details[0].path).toBe("n");
    expect(error.requestId).toMatch(UUID);
  });

  it("AppError preserva código, status e detalhes", async () => {
    app = make();
    const res = await app.inject("/test/app-error");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "CUSTOM",
      details: { a: 1 },
    });
  });

  it("JSON malformado => 400 BAD_REQUEST", async () => {
    app = make();
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{oops",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("erro inesperado => 500 genérico sem vazar detalhes", async () => {
    app = make();
    const res = await app.inject("/test/boom");
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
    expect(res.body).not.toContain("secreto");
  });

  it("ignora x-request-id enviado pelo cliente", async () => {
    app = make();
    const res = await app.inject({
      url: "/api/health",
      headers: { "x-request-id": "forjado" },
    });
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("logs", () => {
  it("não registram cookie, authorization nem campos sensíveis", async () => {
    app = make();
    await app.inject({
      url: "/api/health",
      headers: {
        cookie: "sid=COOKIE_SECRETO",
        authorization: "Bearer TOKEN_SECRETO",
      },
    });
    app.log.info(
      {
        req: {
          headers: {
            cookie: "sid=COOKIE_SECRETO",
            authorization: "Bearer TOKEN_SECRETO",
          },
        },
        res: { headers: { "set-cookie": "sid=SETCOOKIE_SECRETO" } },
        body: {
          password: "SENHA_SECRETA",
          newPassword: "NOVA_SECRETA",
          token: "TOKEN2_SECRETO",
        },
        user: { password: "SENHA2_SECRETA" },
      },
      "teste de redaction",
    );
    const out = lines.join("");
    expect(out).toContain("teste de redaction");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/SECRET/);
    expect(out).toMatch(/"requestId":"[0-9a-f-]{36}"/);
  });
});

describe("logs de exceções", () => {
  const SENHA = "s3nh4-Muito+Secreta";
  const URL_DB = `postgresql://agendly:${SENHA}@db.local:5432/agendly`;
  const logger = () =>
    buildLoggerOptions({ LOG_LEVEL: "debug", DATABASE_URL: URL_DB }, stream);

  it("erro 500 com credencial na mensagem não vaza no log nem na resposta", async () => {
    lines = [];
    app = buildApp({ logger: logger(), checkDatabase: async () => {} });
    app.get("/test/leak", async () => {
      throw new Error(`falha ao conectar em ${URL_DB} (password=${SENHA})`);
    });
    const res = await app.inject("/test/leak");
    const out = lines.join("");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("s3nh4");
    expect(out).not.toContain("s3nh4");
    // Informação operacional preservada.
    expect(out).toContain("unhandled error");
    expect(out).toContain("db.local:5432/agendly");
    expect(out).toMatch(/"requestId":"[0-9a-f-]{36}"/);
  });

  it("falha do banco no /ready não vaza credenciais, mas registra code e host", async () => {
    lines = [];
    app = buildApp({
      logger: logger(),
      checkDatabase: async () => {
        throw Object.assign(new Error(`connect ECONNREFUSED ${URL_DB}`), {
          code: "ECONNREFUSED",
          detail: `senha ${SENHA}`,
        });
      },
    });
    const res = await app.inject("/api/ready");
    const out = lines.join("");
    expect(res.statusCode).toBe(503);
    expect(out).not.toContain("s3nh4");
    expect(out).toContain("ECONNREFUSED");
    expect(out).toContain("readiness check failed");
  });
});

describe("Clock", () => {
  it("é injetável", async () => {
    const fixed = new Date("2026-01-01T00:00:00Z");
    lines = [];
    app = buildApp({
      logger: false,
      checkDatabase: async () => {},
      clock: { now: () => fixed },
    });
    expect(app.clock.now()).toBe(fixed);
  });
});
