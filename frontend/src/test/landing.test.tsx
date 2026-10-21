// Base visual da página pública (Etapa 2): cabeçalho, menu e isolamento/tema do CSS.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hero } from "../features/landing/Hero";
import { LandingHeader } from "../features/landing/LandingHeader";

const ITEMS = [
  { id: "beneficios", label: "Benefícios" },
  { id: "faq", label: "FAQ" },
];
const header = (items?: typeof ITEMS) =>
  render(
    <MemoryRouter>
      <LandingHeader {...(items ? { items } : {})} />
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

function viewport(width: number) {
  const listeners = new Set<() => void>();
  const media = {
    matches: width >= 1024,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  return (nextWidth: number) =>
    act(() => {
      media.matches = nextWidth >= 1024;
      listeners.forEach((listener) => listener());
    });
}

describe("LandingHeader: navegação responsiva", () => {
  it("sincroniza o link ativo ao navegar pelo histórico de âncoras", () => {
    header(ITEMS);
    const previous = window.location.href;
    try {
      window.history.replaceState(null, "", "#faq");
      fireEvent(window, new HashChangeEvent("hashchange"));
      expect(screen.getByRole("link", { name: "FAQ" })).toHaveAttribute(
        "aria-current",
        "location",
      );
      window.history.replaceState(null, "", "#beneficios");
      fireEvent(window, new HashChangeEvent("hashchange"));
      expect(screen.getByRole("link", { name: "FAQ" })).not.toHaveAttribute(
        "aria-current",
      );
      expect(screen.getByRole("link", { name: "Benefícios" })).toHaveAttribute(
        "aria-current",
        "location",
      );
    } finally {
      window.history.replaceState(null, "", previous);
    }
  });
  it.each([320, 375, 640, 768, 1023])(
    "em %i px: menu fechado é inacessível; Escape fecha e restaura foco",
    async (width) => {
      viewport(width);
      const user = userEvent.setup();
      header(ITEMS);
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
      const nav = screen.getByRole("navigation", { hidden: true });
      expect(nav).toHaveAttribute("inert");
      const menu = screen.getByRole("button", { name: "Abrir menu" });
      await user.click(menu);
      expect(nav).not.toHaveAttribute("inert");
      await user.tab();
      expect(screen.getByRole("link", { name: "Benefícios" })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(menu).toHaveFocus();
      expect(menu).toHaveAttribute("aria-expanded", "false");
      expect(nav).toHaveAttribute("aria-hidden", "true");
    },
  );

  it("fecha ao clicar fora, sem impedir foco em outro controle", async () => {
    viewport(320);
    const user = userEvent.setup();
    header(ITEMS);
    const menu = screen.getByRole("button", { name: "Abrir menu" });
    await user.click(menu);
    await user.tab();
    const theme = screen.getByRole("button", { name: /^Tema:/ });
    await user.click(theme);
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(theme).toHaveFocus();
  });

  it("fecha por Tab sem prender nem devolver o foco", async () => {
    viewport(375);
    const user = userEvent.setup();
    header(ITEMS);
    const menu = screen.getByRole("button", { name: "Abrir menu" });
    await user.click(menu);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Tema:/ })).toHaveFocus();
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("navegar fecha o painel, marca o link e move foco para a seção", async () => {
    viewport(320);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LandingHeader items={ITEMS} />
        <section id="faq">Perguntas</section>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Abrir menu" }));
    const link = screen.getByRole("link", { name: "FAQ" });
    await user.click(link);
    expect(screen.getByRole("button", { name: "Abrir menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(link).toHaveAttribute("aria-current", "location");
    expect(screen.getByText("Perguntas")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("Perguntas")).not.toHaveAttribute("tabindex");
  });

  it.each([1024, 1440])(
    "em %i px os links ficam acessíveis; voltar a mobile fecha o menu",
    (width) => {
      const resize = viewport(width);
      header(ITEMS);
      const nav = screen.getByRole("navigation");
      expect(nav).not.toHaveAttribute("inert");
      act(() => screen.getByRole("link", { name: "FAQ" }).focus());
      resize(320);
      expect(nav).toHaveAttribute("inert");
      expect(screen.getByRole("button", { name: "Abrir menu" })).toHaveFocus();
      resize(width);
      expect(nav).not.toHaveAttribute("inert");
    },
  );

  it("usa a altura medida para o deslocamento das âncoras e limpa ao desmontar", () => {
    let notify: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { container, unmount } = render(
      <MemoryRouter>
        <div className="landing">
          <LandingHeader />
        </div>
      </MemoryRouter>,
    );
    const root = container.querySelector<HTMLElement>(".landing")!;
    const element = container.querySelector("header")!;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      height: 124,
    } as DOMRect);
    act(() => notify());
    expect(root.style.getPropertyValue("--l-header-offset")).toBe("140px");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(root.style.getPropertyValue("--l-header-offset")).toBe("");
  });
});

describe("LandingHeader", () => {
  it("tem logo, Entrar (/entrar) e Começar agora (/cadastro)", () => {
    header();
    expect(screen.getByRole("link", { name: "Agendly" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute(
      "href",
      "/entrar",
    );
    expect(screen.getByRole("link", { name: "Começar agora" })).toHaveAttribute(
      "href",
      "/cadastro",
    );
  });

  it("sem seções não mostra navegação nem botão de menu (nada de link morto)", () => {
    header();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /menu/i }),
    ).not.toBeInTheDocument();
  });

  it("com seções: links de âncora e menu acessível que abre, fecha e se fecha ao escolher", async () => {
    const user = userEvent.setup();
    header(ITEMS);
    expect(screen.getByRole("link", { name: "Benefícios" })).toHaveAttribute(
      "href",
      "#beneficios",
    );
    const nav = screen.getByRole("navigation", { name: "Seções" });
    const menu = screen.getByRole("button", { name: "Abrir menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveAttribute("aria-controls", nav.id);
    expect(nav).toHaveAttribute("data-open", "false");
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(nav).toHaveAttribute("data-open", "true");
    expect(menu).toHaveAccessibleName("Fechar menu");
    await user.click(screen.getByRole("link", { name: "FAQ" }));
    expect(nav).toHaveAttribute("data-open", "false");
  });
});

describe("LandingHeader: ordem do foco", () => {
  it("o botão do menu vem antes da navegação no DOM (ao abrir, o próximo Tab entra nos links)", async () => {
    const user = userEvent.setup();
    header(ITEMS);
    const menu = screen.getByRole("button", { name: "Abrir menu" });
    await user.click(menu);
    menu.focus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Benefícios" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "FAQ" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Tema:/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveFocus();
  });
});

describe("landing.css", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/features/landing/landing.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("todo seletor está sob .landing (nada vaza para o painel)", () => {
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) =>
      (m[2] ?? "").split(",").map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(10);
    // `:root[data-theme="dark"] .landing` e a variante do sistema só redefinem tokens da landing sob `.landing`
    for (const sel of selectors)
      expect(sel, sel).toMatch(
        /^(\.landing|:root(\[[^\]]+\]|:not\(\[[^\]]+\]\))+ \.landing)/,
      );
  });

  it("não há regra genérica `.landing a` (ela vence `.landing-primary` e apaga a cor do texto dos botões)", () => {
    expect(css).not.toMatch(/\.landing\s+a\s*[,{]/);
  });

  it("não redefine os tokens do painel", () => {
    expect(css).not.toMatch(/--(bg|surface|text|muted|border|primary)\s*:/);
    expect(css).not.toMatch(/(^|\s)body\s*\{/);
    // `:root` só aparece como prefixo de seletores que terminam em `.landing` (escolha manual do tema)
    for (const sel of css.match(/:root[^{]*/g) ?? [])
      expect(sel.trim(), sel).toMatch(/\.landing$/);
  });

  it("define tema claro e escuro (prefers-color-scheme) com o mesmo conjunto de tokens", () => {
    const light = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(dark).toBeDefined();
    const names = (t: string) =>
      new Set([...t.matchAll(/(--l-[a-z-]+)\s*:/g)].map((m) => m[1]));
    for (const token of [
      "--l-bg",
      "--l-surface",
      "--l-text",
      "--l-muted",
      "--l-border",
      "--l-control-border",
      "--l-hero-glow",
      "--l-ok-bg",
      "--l-ok-text",
      "--l-neutral-bg",
      "--l-neutral-text",
      "--l-off-bg",
      "--l-off-text",
      "--l-shadow",
      "--l-accent",
      "--l-accent-hover",
      "--l-accent-text",
      "--l-focus",
      "--l-header-bg",
    ]) {
      expect(names(light ?? ""), token).toContain(token);
      expect(names(dark ?? "").has(token), `${token} (escuro)`).toBe(true);
    }
  });
});

describe("Hero", () => {
  const hero = () =>
    render(
      <MemoryRouter>
        <Hero />
      </MemoryRouter>,
    );

  it("tem o título (h1), o subtítulo e os dois CTAs com os destinos certos", () => {
    hero();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Sua agenda em ordem\. Seu negócio em movimento\./,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: /Sua agenda em ordem/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Começar agora" })).toHaveAttribute(
      "href",
      "/cadastro",
    );
    expect(
      screen.getByRole("link", { name: "Conhecer funcionalidades" }),
    ).toHaveAttribute("href", "#funcionalidades");
  });

  it("a demonstração é uma figura rotulada como ilustrativa, sem controles e sem tabulação", () => {
    const { container } = hero();
    const figure = screen.getByRole("img", {
      name: /Exemplo ilustrativo da agenda/,
    });
    expect(figure).toBeInTheDocument();
    expect(screen.getByText(/dados fictícios/)).toBeInTheDocument();
    expect(
      figure.querySelectorAll("a, button, input, [tabindex]"),
    ).toHaveLength(0);
    // só os dois CTAs são focáveis no hero
    expect(container.querySelectorAll("a, button")).toHaveLength(2);
  });

  it("só usa status que existem no sistema e não traz outros títulos além do h1", () => {
    const { container } = hero();
    for (const status of ["Agendado", "Confirmado", "Cancelado"])
      expect(container.textContent).toContain(status);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll("h2, h3, h4")).toHaveLength(0);
  });

  it("organiza horários e serviços de um profissional, destacando o confirmado", () => {
    const { container } = hero();
    expect(screen.getByText("Rafael")).toBeInTheDocument();
    const rows = container.querySelectorAll(".landing-preview-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("09:00");
    expect(rows[0]).toHaveTextContent("09:30");
    const confirmed = container.querySelector(".landing-appt.is-confirmed");
    expect(confirmed).toHaveTextContent("Confirmado");
    expect(confirmed).toHaveTextContent("Lucas Oliveira");
    expect(confirmed).toHaveTextContent("Corte e barba");
    expect(confirmed).toHaveTextContent("40 min + 10 min de intervalo");
    expect(
      container.querySelectorAll("[role=button], [role=tab], select, input"),
    ).toHaveLength(0);
  });
});
