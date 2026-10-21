// Portaria de "/": visitante anônimo vê a página pública (placeholder da Etapa 1 da landing); com sessão, o painel de
// sempre. As demais rotas e os fluxos de entrada continuam como antes.
import { screen } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";

const PASSWORD = "uma-senha-bem-longa-9X";
const PUBLIC_TEXT = /Sua agenda em ordem/;

describe("portaria de /", () => {
  it("visitante anônimo vê o placeholder público, com os botões Entrar e Começar agora", async () => {
    const { container } = renderApp(makeState(), { route: "/" });
    expect(await screen.findByText(PUBLIC_TEXT)).toBeInTheDocument();
    // header, hero, CTA final e rodapé oferecem os mesmos destinos
    for (const [name, href] of [
      ["Entrar", "/entrar"],
      ["Começar agora", "/cadastro"],
    ] as const) {
      const links = screen.getAllByRole("link", { name });
      expect(links.length).toBeGreaterThanOrEqual(2);
      for (const link of links) expect(link).toHaveAttribute("href", href);
    }
    expect(currentPath(container)).toBe("/");
    // a navegação é a das seções da página pública, não a do painel
    expect(
      screen.getByRole("navigation", { name: "Seções" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Principal" }),
    ).not.toBeInTheDocument();
  });

  it("sessão que terminou estando em / vai ao login com o aviso (não à página pública)", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/" });
    await screen.findByRole("heading", { name: "Salão da Ana" });
    await user.click(screen.getByRole("link", { name: "Empresas" }));
    await screen.findByRole("heading", { name: "Suas empresas" });
    state.user = null; // o servidor encerrou a sessão
    await user.click(screen.getByRole("link", { name: "Agendly" })); // "/" pede /api/organization e recebe 401
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/entrar");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sua sessão terminou. Entre novamente para continuar.",
    );
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
  });

  it("usuário autenticado com empresa ativa vê a HomePage dentro do layout do painel", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { container } = renderApp(state, { route: "/" });
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Principal" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
  });

  it("enquanto a sessão carrega mostra o carregamento e nunca o conteúdo público (nem para quem tem sessão)", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    renderApp(state, {
      route: "/",
      overrides: [
        http.get("/api/me", async () => {
          await delay(150);
          return HttpResponse.json({ user: ANA });
        }),
      ],
    });
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(/carregando/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
  });

  it("autenticado sem empresa ativa em / segue para a seleção de empresa", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
    });
    const { container } = renderApp(state, { route: "/" });
    expect(
      await screen.findByRole("heading", { name: "Suas empresas" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/empresas");
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
  });

  it("rotas protegidas continuam exigindo login: /agenda anônimo vai a /entrar e volta à agenda (from)", async () => {
    const state = makeState({
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/agenda" });
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/entrar");
    expect(screen.queryByText(PUBLIC_TEXT)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(
      await screen.findByRole("heading", { name: "Agenda" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/agenda");
  });

  it("login sem destino (a partir da página pública) cai em / e mostra o painel", async () => {
    const state = makeState({
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/" });
    await user.click(
      (await screen.findAllByRole("link", { name: "Entrar" }))[0]!,
    );
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
  });

  it("PublicOnly continua valendo: autenticado em /entrar, /cadastro e /esqueci-senha vai ao painel", async () => {
    for (const route of ["/entrar", "/cadastro", "/esqueci-senha"]) {
      const state = makeState({
        user: ANA,
        organizations: [makeOrg("salao", "Salão da Ana")],
        activeSlug: "salao",
      });
      const { container, unmount } = renderApp(state, { route });
      expect(
        await screen.findByRole("heading", { name: "Salão da Ana" }),
      ).toBeInTheDocument();
      expect(currentPath(container), route).toBe("/");
      unmount();
    }
  });

  it("PublicOnly respeita o from: autenticado em /entrar com from=/servicos vai a /servicos", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { container } = renderApp(state, {
      route: "/entrar",
      routeState: { from: "/servicos" },
    });
    await screen.findByRole("navigation", { name: "Principal" });
    expect(currentPath(container)).toBe("/servicos");
  });
});
