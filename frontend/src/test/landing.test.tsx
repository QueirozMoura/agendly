// Base visual da página pública (Etapa 2): cabeçalho, menu e isolamento/tema do CSS.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
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
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.landing/);
  });

  it("não há regra genérica `.landing a` (ela vence `.landing-primary` e apaga a cor do texto dos botões)", () => {
    expect(css).not.toMatch(/\.landing\s+a\s*[,{]/);
  });

  it("não redefine os tokens do painel", () => {
    expect(css).not.toMatch(/--(bg|surface|text|muted|border|primary)\s*:/);
    expect(css).not.toMatch(/:root|(^|\s)body\s*\{/);
  });

  it("define tema claro e escuro (prefers-color-scheme) com o mesmo conjunto de tokens", () => {
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
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
        name: /sem horários em conflito/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: /Sua agenda organizada/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Começar agora" })).toHaveAttribute(
      "href",
      "/cadastro",
    );
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute(
      "href",
      "/entrar",
    );
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
});
