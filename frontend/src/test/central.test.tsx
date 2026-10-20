// Tratamento CENTRAL de 401 e 409 (aceite da etapa 11) e de 403 sem empresa ativa, vistos pela interface.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";

const withOrg = () =>
  makeState({
    user: ANA,
    organizations: [makeOrg("salao", "Salão da Ana")],
    activeSlug: "salao",
  });

describe("401 no meio da sessão", () => {
  it("qualquer 401 em rota autenticada leva ao login com o aviso de sessão terminada (sem mostrar o erro cru)", async () => {
    const state = withOrg();
    const { user, container } = renderApp(state, { route: "/empresas" });
    await user.click(
      await screen.findByRole("button", { name: "Entrar em Salão da Ana" }),
    );
    await screen.findByRole("heading", { name: "Salão da Ana" });
    state.user = null; // o servidor revogou a sessão (outro dispositivo, expiração...)
    await user.click(screen.getByRole("link", { name: "Empresas" }));
    await user.click(
      await screen.findByRole("button", { name: "Entrar em Salão da Ana" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/entrar");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sua sessão terminou. Entre novamente para continuar.",
    );
    expect(
      screen.queryByText("Sessão inválida ou expirada."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("depois de entrar de novo o aviso some e a navegação volta ao normal", async () => {
    const state = withOrg();
    const { user } = renderApp(state, { route: "/empresas" });
    await user.click(
      await screen.findByRole("button", { name: "Entrar em Salão da Ana" }),
    );
    await screen.findByRole("heading", { name: "Salão da Ana" });
    state.user = null;
    await user.click(screen.getByRole("link", { name: "Empresas" }));
    await user.click(
      await screen.findByRole("button", { name: "Entrar em Salão da Ana" }),
    );
    await screen.findByText(
      "Sua sessão terminou. Entre novamente para continuar.",
    );
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "uma-senha-bem-longa-9X");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    // volta à página onde a sessão terminou (`from`), não ao início
    await screen.findByRole("heading", { name: "Suas empresas" });
    expect(
      screen.queryByText(
        "Sua sessão terminou. Entre novamente para continuar.",
      ),
    ).not.toBeInTheDocument();
  });

  it("a consulta inicial /api/me sem sessão (401) NÃO é 'sessão terminada': o login abre sem aviso", async () => {
    renderApp(makeState(), { route: "/" });
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Sua sessão terminou. Entre novamente para continuar.",
      ),
    ).not.toBeInTheDocument();
  });
});

describe("409 ACTIVE_ORG_CHANGED (outra aba trocou a empresa)", () => {
  it("recarrega o app, uma vez, sem mostrar erro", async () => {
    const state = makeState({
      user: ANA,
      organizations: [
        makeOrg("salao", "Salão da Ana"),
        makeOrg("barbearia", "Barbearia"),
      ],
      activeSlug: "salao",
    });
    const onReload = vi.fn();
    const { user } = renderApp(state, { route: "/", onReload });
    await screen.findByRole("heading", { name: "Salão da Ana" });
    expect(onReload).not.toHaveBeenCalled();
    state.activeSlug = "barbearia"; // a aba B trocou a empresa da sessão
    await user.click(screen.getByRole("link", { name: "Empresas" }));
    await screen.findByRole("heading", { name: "Suas empresas" });
    await user.click(screen.getByRole("link", { name: "Agendly" })); // o painel pede /api/organization com X-Active-Org: salao
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("403 sem empresa ativa", () => {
  it("NO_ACTIVE_ORGANIZATION num painel aberto relê as empresas e leva ao seletor", async () => {
    const state = withOrg();
    const { user, container } = renderApp(state, { route: "/" });
    await screen.findByRole("heading", { name: "Salão da Ana" });
    state.activeSlug = null; // a empresa ativa foi limpa no servidor (ex.: membership perdida)
    await user.click(screen.getByRole("link", { name: "Empresas" }));
    await screen.findByRole("heading", { name: "Suas empresas" });
    await user.click(screen.getByRole("link", { name: "Agendly" }));
    await waitFor(() => expect(currentPath(container)).toBe("/empresas"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("falhas de rede e de servidor", () => {
  it("rede fora do ar no login: mensagem em pt-BR, sem detalhes técnicos", async () => {
    const { ApiClient } = await import("../api/client");
    const client = new ApiClient({}, async (input, init) => {
      if (String(input).endsWith("/api/me"))
        return Response.json(
          { error: { code: "UNAUTHENTICATED", message: "x" } },
          { status: 401 },
        );
      void init;
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const { user } = renderApp(makeState(), { route: "/entrar", client });
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "uma-senha-bem-longa-9X");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível conectar ao servidor.");
    expect(alert).not.toHaveTextContent(/ECONNREFUSED|fetch failed/);
  });
});
