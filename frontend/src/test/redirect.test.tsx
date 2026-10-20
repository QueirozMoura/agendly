// Destino interno depois do login (`from`): só caminhos da própria SPA; tudo o mais vira "/".
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { safeInternalPath } from "../features/auth/redirect";
import { makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";

describe("safeInternalPath (unitário)", () => {
  it.each([
    ["/", "/"],
    ["/empresas", "/empresas"],
    ["/empresas?x=1&y=2", "/empresas?x=1&y=2"],
    ["/a/b/c", "/a/b/c"],
    ["/redefinir-senha#token=abc", "/redefinir-senha#token=abc"],
    ["/caminho%20com%20espaco", "/caminho%20com%20espaco"],
  ])("mantém o destino interno válido %j", (input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "///evil.com",
    "//evil.com/caminho",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com", // o parser de URL remove o tab e vira //evil.com
    "/\n/evil.com",
    "/\u0000/x",
    "https://evil.com",
    "http://evil.com/empresas",
    "HTTPS://evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "mailto:a@b.com",
    "evil.com",
    "empresas",
    "",
    " /empresas",
    "/" + "a".repeat(2001),
  ])("rejeita %j e cai em '/'", (input) => {
    expect(safeInternalPath(input)).toBe("/");
  });

  it.each([
    undefined,
    null,
    0,
    5,
    true,
    {},
    [],
    ["/empresas"],
    { toString: () => "/x" },
  ])("valor que não é texto (%j) vira '/'", (input) => {
    expect(safeInternalPath(input)).toBe("/");
  });

  it("o resultado é sempre um caminho da mesma origem", () => {
    for (const input of [
      "/x",
      "//y",
      "/\\z",
      "https://w",
      "/%2F%2Fevil.com",
      "/a/../b",
    ]) {
      const out = safeInternalPath(input);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "http://app.test").origin).toBe("http://app.test");
    }
  });
});

describe("login: destino depois de entrar (componente)", () => {
  const login = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "uma-senha-bem-longa-9X");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
  };
  const withOrg = () =>
    makeState({
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });

  it("destino interno válido é respeitado", async () => {
    const { user, container } = renderApp(withOrg(), {
      route: "/entrar",
      routeState: { from: "/empresas" },
    });
    await login(user);
    expect(
      await screen.findByRole("heading", { name: "Suas empresas" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/empresas");
  });

  it.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "evil.com",
  ])(
    "destino inválido ou externo (%s) é ignorado: vai para o início",
    async (from) => {
      const { user, container } = renderApp(withOrg(), {
        route: "/entrar",
        routeState: { from },
      });
      await login(user);
      expect(
        await screen.findByRole("heading", { name: "Salão da Ana" }),
      ).toBeInTheDocument();
      expect(currentPath(container)).toBe("/");
    },
  );

  it("`from` que não é texto também é ignorado", async () => {
    const { user, container } = renderApp(withOrg(), {
      route: "/entrar",
      routeState: { from: { x: 1 } },
    });
    await login(user);
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
  });
});
