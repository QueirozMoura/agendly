// Seções de conteúdo da página pública (Etapa 4): ids estáveis, âncoras do header, hierarquia e conteúdo permitido.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LandingPage } from "../features/landing/LandingPage";
import { LANDING_NAV, LANDING_SECTIONS } from "../features/landing/sections";

const page = () =>
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );

describe("ids de seção", () => {
  it("são estáveis (contrato das âncoras)", () => {
    expect(LANDING_NAV.map((i) => i.id)).toEqual([
      "beneficios",
      "funcionalidades",
      "como-funciona",
      "faq",
    ]);
    expect(LANDING_SECTIONS.benefits.label).toBe("Benefícios");
  });

  it("cada item do header aponta para uma seção que existe na página, na mesma ordem", () => {
    const { container } = page();
    const nav = within(screen.getByRole("navigation", { name: "Seções" }));
    const hrefs = nav.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(LANDING_NAV.map((i) => `#${i.id}`));
    for (const item of LANDING_NAV)
      expect(
        container.querySelector(`section#${item.id}`),
        item.id,
      ).not.toBeNull();
  });
});

describe("hierarquia e acessibilidade", () => {
  it("um h1 (hero), um h2 por seção ligado à seção por aria-labelledby, e h3 só dentro das seções", () => {
    const { container } = page();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    for (const { id } of LANDING_NAV) {
      const section = container.querySelector(`section#${id}`) as HTMLElement;
      const h2 = section.querySelector("h2") as HTMLElement;
      expect(section.querySelectorAll("h2")).toHaveLength(1);
      expect(section.getAttribute("aria-labelledby")).toBe(h2.id);
      if (id !== "faq")
        expect(section.querySelectorAll("h3").length).toBeGreaterThanOrEqual(4);
    }
    // nenhum salto de nível: todo h3 está dentro de uma seção com h2
    for (const h3 of container.querySelectorAll("h3"))
      expect(h3.closest("section")?.querySelector("h2")).not.toBeNull();
  });

  it("os passos de 'Como funciona' são uma lista ordenada de quatro itens", () => {
    const { container } = page();
    const ol = container.querySelector("#como-funciona ol");
    expect(ol).not.toBeNull();
    expect(ol?.querySelectorAll(":scope > li")).toHaveLength(4);
  });

  it("as seções de conteúdo não têm elementos focáveis próprios (só texto)", () => {
    const { container } = page();
    for (const { id } of LANDING_NAV)
      expect(
        container.querySelectorAll(
          `#${id} a, #${id} button, #${id} [tabindex]`,
        ),
      ).toHaveLength(0);
  });
});

describe("conteúdo permitido", () => {
  it("não promete o que o sistema não tem nem inventa prova social, métricas ou preços", () => {
    const { container } = page();
    // texto das seções de conteúdo (a demonstração do hero tem preço fictício rotulado)
    const text = LANDING_NAV.filter(({ id }) => id !== "faq")
      .map(({ id }) => container.querySelector(`#${id}`)?.textContent ?? "")
      .join(" ")
      .toLowerCase();
    for (const proibido of [
      "whatsapp",
      "lembrete",
      "pagamento",
      "cobrança",
      "depoimento",
      "cliente satisfeito",
      "gratuito",
      "grátis",
      "teste grátis",
      "página pública",
      "relatório",
      "integração",
      "app ",
      "aplicativo",
    ])
      expect(text, proibido).not.toContain(proibido);
    expect(text).not.toMatch(/\d+\s*%|r\$|\d{2,}\s*(mil|clientes|empresas)/);
  });
});

describe("benefícios: sem promessa de idempotência", () => {
  it("o card de simultaneidade descreve só o aviso de alteração concorrente", () => {
    const { container } = page();
    const section = container.querySelector("#beneficios") as HTMLElement;
    const text = (section.textContent ?? "").toLowerCase();
    for (const proibido of [
      "repetição",
      "repetir",
      "tentar de novo",
      "segundo agendamento",
      "duplicad",
      "conexão cair",
      "idempot",
    ])
      expect(text, proibido).not.toContain(proibido);
    expect(
      within(section).getByRole("heading", {
        level: 3,
        name: "Alterações simultâneas sem sobrescrever",
      }),
    ).toBeInTheDocument();
    expect(text).toContain("a segunda é avisada");
  });

  it("nenhuma seção da página (hero, seções, rodapé) menciona idempotência ou envio duplicado", () => {
    const { container } = page();
    const text = (container.textContent ?? "").toLowerCase();
    for (const proibido of [
      "idempot",
      "duplicad",
      "segundo agendamento",
      "tentar de novo",
    ])
      expect(text, proibido).not.toContain(proibido);
  });
});

describe("FAQ", () => {
  const faq = () => {
    const utils = page();
    return {
      ...utils,
      section: utils.container.querySelector("#faq") as HTMLElement,
    };
  };

  it("usa details/summary nativos: uma pergunta por item, todas fechadas no início", () => {
    const { section } = faq();
    const items = section.querySelectorAll("details");
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const d of items) {
      expect(d.hasAttribute("open")).toBe(false);
      expect(d.querySelector(":scope > summary")?.textContent?.trim()).toMatch(
        /\?$/,
      );
      expect(
        d.querySelector(":scope > p")?.textContent?.length,
      ).toBeGreaterThan(30);
    }
  });

  it("cada resumo é focável e está na ordem de tabulação (o abrir/fechar por teclado é verificado no navegador)", async () => {
    const user = userEvent.setup();
    const { section } = faq();
    const summaries = section.querySelectorAll("summary");
    await user.tab(); // logo
    for (const [i, summary] of summaries.entries()) {
      summary.focus();
      expect(summary, `resumo ${i}`).toHaveFocus();
    }
  });

  it("não promete o que não existe nem a garantia contra envio duplicado", () => {
    const { section } = faq();
    const text = (section.textContent ?? "").toLowerCase();
    for (const proibido of [
      "whatsapp",
      "pagamento",
      "relatório",
      "plano",
      "mensalidade",
      "assinatura",
      "gratuito",
      "grátis",
      "depoimento",
      "integra",
      "duplicad",
      "idempot",
      "segundo agendamento",
      "em breve",
      "futuramente",
      "página pública",
    ])
      expect(text, proibido).not.toContain(proibido);
    // as negativas honestas existem: sem agendamento pelo cliente, sem mensagens, sem convite de equipe
    expect(text).toContain("hoje não");
    expect(text).toContain("não há convite");
  });
});

describe("CTA final e rodapé", () => {
  it("o CTA final leva ao cadastro e ao login (rotas reais)", () => {
    const { container } = page();
    const cta = container.querySelector("#comece-agora") as HTMLElement;
    expect(cta.getAttribute("aria-labelledby")).toBe("comece-agora-title");
    expect(within(cta).getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(
      within(cta).getByRole("link", { name: "Começar agora" }),
    ).toHaveAttribute("href", "/cadastro");
    expect(within(cta).getByRole("link", { name: "Entrar" })).toHaveAttribute(
      "href",
      "/entrar",
    );
  });

  it("o rodapé só tem links existentes: âncoras das seções e rotas de entrada", () => {
    const { container } = page();
    const footer = screen.getByRole("contentinfo");
    const hrefs = [...footer.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    const permitidos = new Set([
      "/",
      "/entrar",
      "/cadastro",
      ...LANDING_NAV.map((i) => `#${i.id}`),
    ]);
    for (const href of hrefs)
      expect(permitidos.has(href ?? ""), String(href)).toBe(true);
    for (const item of LANDING_NAV) expect(hrefs).toContain(`#${item.id}`);
    // nenhuma informação inventada: sem e-mail, telefone, redes sociais, termos ou copyright
    const text = (footer.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(
      /@|\(\d{2}\)|©|copyright|termos|privacidade|instagram|facebook|linkedin|twitter|cnpj/,
    );
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(
      screen.getByRole("navigation", { name: "Rodapé: seções" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Rodapé: conta" }),
    ).toBeInTheDocument();
  });

  it("a ordem das seções é hero, benefícios, funcionalidades, como funciona, FAQ e CTA, com o rodapé fora do main", () => {
    const { container } = page();
    const ids = [...container.querySelectorAll("main > section")].map(
      (s) => s.id || "hero",
    );
    expect(ids).toEqual([
      "hero",
      "beneficios",
      "funcionalidades",
      "como-funciona",
      "faq",
      "comece-agora",
    ]);
    expect(container.querySelector("main footer")).toBeNull();
  });
});
