// Casca do painel: barra lateral (navegação, empresa ativa, conta), recolher no desktop, gaveta no celular e estilos.
import { screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";

const state = () =>
  makeState({
    user: ANA,
    organizations: [
      makeOrg("salao", "Salão da Ana"),
      makeOrg("barbearia", "Barbearia"),
    ],
    activeSlug: "salao",
  });

const shell = (container: HTMLElement) =>
  container.querySelector(".app-shell") as HTMLElement;

describe("barra lateral", () => {
  it("tem marca, navegação agrupada, empresas, empresa ativa e saída, com as rotas de sempre", async () => {
    const { container } = renderApp(state(), { route: "/" });
    await screen.findByRole("navigation", { name: "Principal" }); // empresas carregadas
    const aside = screen.getByRole("complementary", { name: "Menu lateral" });
    expect(
      within(aside).getByRole("link", { name: "Agendly" }),
    ).toHaveAttribute("href", "/");
    const main = within(aside).getByRole("navigation", { name: "Principal" });
    for (const [name, href] of [
      ["Início", "/"],
      ["Agenda", "/agenda"],
      ["Serviços", "/servicos"],
      ["Profissionais", "/profissionais"],
    ] as const)
      expect(within(main).getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    expect(main.textContent).toContain("Operação");
    expect(main.textContent).toContain("Cadastros");
    expect(
      within(
        within(aside).getByRole("navigation", { name: "Conta e empresas" }),
      ).getByRole("link", { name: "Empresas" }),
    ).toHaveAttribute("href", "/empresas");
    expect(
      within(aside).getByRole("combobox", { name: "Empresa ativa" }),
    ).toHaveValue("salao");
    expect(
      within(aside).getByRole("button", { name: "Sair" }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".app-shell > main")).toHaveLength(1);
  });

  it("sem empresa ativa não mostra a navegação principal, só Empresas", async () => {
    const s = state();
    s.activeSlug = null;
    renderApp(s, { route: "/empresas" });
    await screen.findByRole("heading", { name: "Suas empresas" });
    expect(
      screen.queryByRole("navigation", { name: "Principal" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Empresas" })).toBeInTheDocument();
  });

  it("marca a rota ativa com aria-current e só o Início em '/'", async () => {
    const { user } = renderApp(state(), { route: "/" });
    const main = await screen.findByRole("navigation", { name: "Principal" });
    expect(within(main).getByRole("link", { name: "Início" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(main).getByRole("link", { name: "Agenda" }));
    await screen.findByRole("heading", { name: "Agenda" });
    expect(within(main).getByRole("link", { name: "Agenda" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(main).getByRole("link", { name: "Início" }),
    ).not.toHaveAttribute("aria-current");
    await user.click(within(main).getByRole("link", { name: "Serviços" }));
    await screen.findByRole("heading", { name: "Serviços" });
    expect(
      within(main).getByRole("link", { name: "Serviços" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("a empresa ativa é trocada pelo seletor da barra lateral e volta ao início", async () => {
    const { user, container } = renderApp(state(), { route: "/agenda" });
    await screen.findByRole("heading", { name: "Agenda" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Empresa ativa" }),
      "barbearia",
    );
    expect(
      await screen.findByRole("heading", { name: "Barbearia" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
  });

  it("o aviso de e-mail continua no conteúdo, não na barra lateral", async () => {
    const s = state();
    s.user = { ...ANA, emailVerified: false };
    renderApp(s, { route: "/" });
    const banner = (await screen.findByText(/Confirme seu e-mail/)).closest(
      "[role='status']",
    ) as HTMLElement;
    expect(banner.closest("main")).not.toBeNull();
    expect(banner.closest("aside")).toBeNull();
  });
});

describe("recolher (desktop)", () => {
  it("alterna entre expandida e recolhida; recolhida mostra a empresa em um atalho e mantém os nomes acessíveis", async () => {
    const { user, container } = renderApp(state(), { route: "/" });
    const toggle = await screen.findByRole("button", { name: "Recolher menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(shell(container)).not.toHaveClass("is-collapsed");
    await user.click(toggle);
    expect(shell(container)).toHaveClass("is-collapsed");
    const expand = screen.getByRole("button", { name: "Expandir menu" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("link", { name: "Empresa ativa: Salão da Ana" }),
    ).toHaveAttribute("href", "/empresas");
    for (const name of ["Agenda", "Serviços", "Profissionais", "Empresas"])
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
    await user.click(expand);
    expect(shell(container)).not.toHaveClass("is-collapsed");
    expect(
      screen.getByRole("combobox", { name: "Empresa ativa" }),
    ).toBeInTheDocument();
  });
});

describe("gaveta (celular)", () => {
  it("abre pelo botão, leva o foco ao fechar, fecha com Esc devolvendo o foco ao botão", async () => {
    const { user, container } = renderApp(state(), { route: "/" });
    const open = await screen.findByRole("button", { name: "Abrir menu" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(open).toHaveAttribute("aria-controls", "app-sidebar");
    await user.click(open);
    expect(shell(container)).toHaveClass("drawer-open");
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Fechar menu" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(shell(container)).not.toHaveClass("drawer-open");
    expect(open).toHaveFocus();
  });

  it("fecha ao clicar no fundo e ao navegar por um item", async () => {
    const { user, container } = renderApp(state(), { route: "/" });
    await user.click(await screen.findByRole("button", { name: "Abrir menu" }));
    await user.click(container.querySelector(".drawer-overlay") as HTMLElement);
    expect(shell(container)).not.toHaveClass("drawer-open");
    await user.click(screen.getByRole("button", { name: "Abrir menu" }));
    await user.click(screen.getByRole("link", { name: "Serviços" }));
    await screen.findByRole("heading", { name: "Serviços" });
    expect(shell(container)).not.toHaveClass("drawer-open");
    expect(currentPath(container)).toBe("/servicos");
  });

  it("com a gaveta aberta o Tab circula dentro dela (último → primeiro e Shift+Tab ao contrário)", async () => {
    const { user } = renderApp(state(), { route: "/" });
    await user.click(await screen.findByRole("button", { name: "Abrir menu" }));
    const aside = screen.getByRole("complementary", { name: "Menu lateral" });
    const focusables = [
      ...aside.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]):not([data-desktop-only]), select:not([disabled])",
      ),
    ];
    // o botão de recolher é só de desktop (some no CSS da gaveta): não pode ser o "último" do ciclo
    expect(
      aside
        .querySelector(".collapse-toggle")
        ?.hasAttribute("data-desktop-only"),
    ).toBe(true);
    expect(focusables.at(-1)?.textContent).toContain("Sair");
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("o fundo escurecido não é exposto a leitores de tela nem entra na ordem de tabulação", async () => {
    const { container } = renderApp(state(), { route: "/" });
    await screen.findByRole("complementary", { name: "Menu lateral" });
    const overlay = container.querySelector(".drawer-overlay") as HTMLElement;
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveAttribute("tabindex", "-1");
  });
});

describe("estilos do painel (estrutura)", () => {
  const read = (p: string) =>
    readFileSync(resolve(process.cwd(), p), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
  const css = read("src/styles.css");
  const block = (selector: string) =>
    css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));

  it("cada token do tema claro tem o par no escuro (prefers-color-scheme)", () => {
    const light = block(":root {");
    const dark = block(':root[data-theme="dark"]');
    const system = block(
      ':root:not([data-theme="light"]):not([data-theme="dark"])',
    );
    const names = (t = "") =>
      new Set([...t.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    // só tokens de cor/sombra variam por tema; medidas (raio, largura) são comuns
    for (const t of [
      "--bg",
      "--surface",
      "--surface-2",
      "--text",
      "--muted",
      "--border",
      "--control-border",
      "--primary",
      "--primary-hover",
      "--primary-text",
      "--primary-soft",
      "--primary-soft-text",
      "--danger",
      "--danger-bg",
      "--success",
      "--success-bg",
      "--info",
      "--info-bg",
      "--sidebar-bg",
      "--overlay",
      "--shadow-sm",
      "--shadow-md",
      "--ring",
    ]) {
      expect(names(light).has(t), `${t} (claro)`).toBe(true);
      expect(names(dark).has(t), `${t} (escuro)`).toBe(true);
      expect(names(system).has(t), `${t} (escuro do sistema)`).toBe(true);
    }
  });

  it("nenhuma cor fixa fora dos tokens: os componentes só usam var(--…)", () => {
    const rest = css.replace(/:root[^{]*\{[^}]*\}/g, "");
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rest).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it("respeita prefers-reduced-motion e não tem estilos da landing", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).not.toMatch(/\.landing/);
  });

  it("a gaveta fechada some da ordem de tabulação (visibility: hidden) e a recolhida só esconde rótulos visualmente", () => {
    expect(css).toMatch(/\.sidebar\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(
      /\.drawer-open \.sidebar\s*\{[^}]*visibility:\s*visible/,
    );
    expect(css).toMatch(/\.is-collapsed \.nav-label[^{]*\{[^}]*clip:/);
  });
});
