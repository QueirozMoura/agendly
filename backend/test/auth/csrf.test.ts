import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORIGIN,
  makeAuthApp,
  resetUsers,
  type AuthTestApp,
} from "../support/auth-app.ts";

let t: AuthTestApp;
beforeAll(async () => {
  await resetUsers();
  t = await makeAuthApp();
});
afterAll(() => t.close());

const send = (
  headers: Record<string, string>,
  payload: string | undefined = "{}",
) =>
  t.app.inject({ method: "POST", url: "/api/auth/logout", headers, payload });

describe("proteção CSRF: Origin e Content-Type", () => {
  it("origem permitida + JSON => aceita", async () => {
    const res = await send({
      origin: ORIGIN,
      "content-type": "application/json",
    });
    expect(res.statusCode).toBe(204);
  });

  it("aceita Content-Type com charset e variação de caixa", async () => {
    const res = await send({
      origin: ORIGIN,
      "content-type": "Application/JSON; charset=utf-8",
    });
    expect(res.statusCode).toBe(204);
  });

  it("sem Origin => 403 FORBIDDEN_ORIGIN", async () => {
    const res = await send({ "content-type": "application/json" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("Origin de outro site, 'null' ou com porta/esquema diferente => 403", async () => {
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:5174",
      "https://localhost:5173",
      `${ORIGIN}.evil.example`,
    ]) {
      const res = await send({ origin, "content-type": "application/json" });
      expect(res.statusCode, origin).toBe(403);
    }
  });

  it("Content-Type diferente de JSON (formulário, texto, ausente) => 415", async () => {
    for (const ct of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await send({ origin: ORIGIN, "content-type": ct }, "a=b");
      expect(res.statusCode, ct).toBe(415);
      expect(res.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    const none = await send({ origin: ORIGIN }, undefined);
    expect(none.statusCode).toBe(415);
  });

  it("a checagem de Origin vem antes da de Content-Type", async () => {
    const res = await send(
      { origin: "https://evil.example", "content-type": "text/plain" },
      "x",
    );
    expect(res.statusCode).toBe(403);
  });

  it("métodos seguros (GET) não exigem Origin", async () => {
    const res = await t.app.inject("/api/health");
    expect(res.statusCode).toBe(200);
  });

  it("login e cadastro também são protegidos (nada é processado sem Origin)", async () => {
    for (const url of ["/api/auth/login", "/api/auth/register"]) {
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: "a@example.com", password: "x" }),
      });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
