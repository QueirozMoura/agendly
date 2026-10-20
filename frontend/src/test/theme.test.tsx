// Tema claro/escuro/sistema: lib/theme (persistência só em `agendly-theme`), o botão nos três lugares (painel, telas de
// acesso e landing), o script que evita o flash e os tokens de CSS dos dois temas.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PublicLayout } from "../components/PublicLayout";
import { LandingHeader } from "../features/landing/LandingHeader";
import {
  THEME_KEY,
  initTheme,
  nextPreference,
  readPreference,
  setPreference,
} from "../lib/theme";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { renderApp } from "./render";

const root = document.documentElement;
const read = (p: string) =>
  readFileSync(resolve(import.meta.dirname, p), "utf8");

describe("lib/theme", () => {
  it("a chave de armazenamento é agendly-theme", () => {
    expect(THEME_KEY).toBe("agendly-theme");
  });

  it("sem valor ou com valor inválido a preferência é 'system'", () => {
    expect(readPreference()).toBe("system");
    for (const bad of ["", "azul", "LIGHT", "null"]) {
      localStorage.setItem(THEME_KEY, bad);
      expect(readPreference()).toBe("system");
    }
    localStorage.removeItem(THEME_KEY);
  });

  it("claro e escuro aplicam data-theme e persistem; 'sistema' remove os dois", () => {
    setPreference("dark");
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    setPreference("light");
    expect(root).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    setPreference("system");
    expect(root).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("initTheme aplica o tema salvo (persistência após recarregar)", () => {
    localStorage.setItem(THEME_KEY, "dark");
    initTheme();
    expect(root).toHaveAttribute("data-theme", "dark");
    localStorage.removeItem(THEME_KEY);
    initTheme();
    expect(root).not.toHaveAttribute("data-theme");
  });

  it("mudança em outra aba (evento storage) é aplicada aqui", () => {
    initTheme();
    localStorage.setItem(THEME_KEY, "light");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    });
    expect(root).toHaveAttribute("data-theme", "light");
    localStorage.removeItem(THEME_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(root).not.toHaveAttribute("data-theme");
  });

  it("armazenamento indisponível não quebra: o tema vale na sessão", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("bloqueado");
    };
    try {
      expect(readPreference()).toBe("system");
      expect(() => initTheme()).not.toThrow();
    } finally {
      Storage.prototype.getItem = original;
    }
    const setOriginal = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("cheio");
    };
    try {
      expect(() => setPreference("dark")).not.toThrow();
      expect(root).toHaveAttribute("data-theme", "dark");
    } finally {
      Storage.prototype.setItem = setOriginal;
    }
  });

  it("a ordem do ciclo é sistema → claro → escuro → sistema", () => {
    expect(nextPreference("system")).toBe("light");
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("system");
  });
});

describe("botão de tema", () => {
  it("telas de acesso: cicla pelos três modos, com nome acessível e aviso", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PublicLayout />
      </MemoryRouter>,
    );
    const btn = () => screen.getByRole("button", { name: /^Tema:/ });
    expect(btn()).toHaveAccessibleName("Tema: Sistema. Alterar para claro.");
    await user.click(btn());
    expect(root).toHaveAttribute("data-theme", "light");
    expect(btn()).toHaveAccessibleName("Tema: Claro. Alterar para escuro.");
    expect(screen.getByText("Tema: Claro")).toBeInTheDocument();
    await user.click(btn());
    expect(root).toHaveAttribute("data-theme", "dark");
    await user.click(btn());
    expect(root).not.toHaveAttribute("data-theme");
    expect(btn()).toHaveAccessibleName("Tema: Sistema. Alterar para claro.");
  });

  it("landing: o botão existe no cabeçalho e usa o mesmo estado", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LandingHeader />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /^Tema:/ }));
    expect(root).toHaveAttribute("data-theme", "light");
  });

  it("painel: o botão está na barra lateral e a escolha vale ao navegar entre páginas", async () => {
    const user = userEvent.setup();
    renderApp(
      makeState({
        user: ANA,
        organizations: [makeOrg("salao", "Salão da Ana")],
        activeSlug: "salao",
      }),
      { route: "/servicos" },
    );
    const btn = await screen.findByRole("button", { name: /^Tema:/ });
    expect(btn).toHaveTextContent("Tema: Sistema");
    await user.click(btn);
    expect(btn).toHaveTextContent("Tema: Claro");
    expect(root).toHaveAttribute("data-theme", "light");
    await user.click(await screen.findByRole("link", { name: /agenda/i }));
    expect(root).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: /^Tema:/ })).toHaveTextContent(
      "Tema: Claro",
    );
  });
});

describe("script anti-flash (public/theme-init.js)", () => {
  const script = read("../../public/theme-init.js");
  const run = () => new Function(script)();

  it("usa a mesma chave de lib/theme e é carregado de forma síncrona no <head>, sem script inline", () => {
    expect(script).toContain(`"${THEME_KEY}"`);
    const html = read("../../index.html");
    expect(html).toMatch(/<script src="\/theme-init\.js"><\/script>/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // nenhum <script> inline
    expect(html.indexOf("theme-init.js")).toBeLessThan(
      html.indexOf("/src/main.tsx"),
    );
    expect(html.indexOf("theme-init.js")).toBeLessThan(html.indexOf("</head>"));
  });

  it("aplica só 'light' e 'dark' e ignora o resto", () => {
    localStorage.setItem(THEME_KEY, "dark");
    run();
    expect(root).toHaveAttribute("data-theme", "dark");
    root.removeAttribute("data-theme");
    localStorage.setItem(THEME_KEY, "<script>");
    run();
    expect(root).not.toHaveAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  });

  it("não quebra se o armazenamento lançar", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("bloqueado");
    };
    try {
      expect(run).not.toThrow();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("CSS dos temas", () => {
  const panel = read("../styles.css");
  const landing = read("../features/landing/landing.css");
  const tokens = (css: string, selector: string) => {
    const m = css.indexOf(selector);
    expect(m, selector).toBeGreaterThan(-1);
    const body = css.slice(css.indexOf("{", m) + 1, css.indexOf("}", m));
    return [...body.matchAll(/(--[\w-]+):/g)].map((x) => x[1]).sort();
  };

  it("painel: o escuro manual e o escuro do sistema definem os mesmos tokens do claro", () => {
    const light = tokens(panel, ":root {").filter(
      (t) => !/^--(radius|sidebar-w)/.test(t!),
    );
    expect(tokens(panel, ':root[data-theme="dark"]')).toEqual(light);
    expect(
      tokens(panel, ':root:not([data-theme="light"]):not([data-theme="dark"])'),
    ).toEqual(light);
    expect(panel).toMatch(
      /:root\[data-theme="light"\]\s*\{\s*color-scheme: light;/,
    );
  });

  it("landing: o escuro manual e o do sistema definem os mesmos tokens", () => {
    expect(tokens(landing, ':root[data-theme="dark"] .landing')).toEqual(
      tokens(
        landing,
        ':root:not([data-theme="light"]):not([data-theme="dark"]) .landing',
      ),
    );
  });

  it("o sistema escuro nunca vence uma escolha manual de claro", () => {
    for (const css of [panel, landing])
      expect(css).not.toMatch(
        /@media \(prefers-color-scheme: dark\)\s*\{\s*(:root|\.landing)\s*\{/,
      );
  });
});
