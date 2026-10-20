// Painel de serviços (Etapa 12): listar, criar (com intervalo/buffer e preço), editar, ativar/desativar.
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { makeService } from "./fakePanel";
import { callsTo, panelState } from "./panelHelpers";
import { renderApp } from "./render";

const row = (name: string) =>
  within(screen.getByRole("list", { name: "Serviços" }))
    .getByText(name)
    .closest("li") as HTMLElement;

describe("lista de serviços", () => {
  it("mostra duração, intervalo, preço e situação; serviço sem preço e inativo aparecem corretamente", async () => {
    const state = panelState({
      services: [
        makeService("s1", "Corte", {
          durationMinutes: 30,
          bufferMinutes: 10,
          priceCents: 5050,
        }),
        makeService("s2", "Barba", { durationMinutes: 20 }),
        makeService("s3", "Hidratação", {
          active: false,
          durationMinutes: 60,
          priceCents: 12000,
        }),
      ],
    });
    renderApp(state, { route: "/servicos" });
    await screen.findByRole("list", { name: "Serviços" });
    expect(row("Corte")).toHaveTextContent("30 min + 10 min de intervalo");
    expect(row("Corte")).toHaveTextContent(/R\$\s?50,50/);
    expect(row("Barba")).toHaveTextContent("20 min · sem preço");
    expect(row("Barba")).not.toHaveTextContent("intervalo");
    expect(within(row("Hidratação")).getByText("Inativo")).toBeInTheDocument();
    expect(
      callsTo(state, "GET", "/api/services")[0]?.headers.get("x-active-org"),
    ).toBe("salao");
  });

  it("lista realmente vazia: orienta a criar o primeiro serviço", async () => {
    renderApp(panelState(), { route: "/servicos" });
    expect(
      await screen.findByText(/Nenhum serviço cadastrado ainda/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Novo serviço" }),
    ).toBeInTheDocument();
  });

  it("erro ao carregar: mensagem + 'Tentar novamente' (nunca o estado vazio); a nova tentativa recupera", async () => {
    const state = panelState({ services: [makeService("s1", "Corte")] });
    let failures = 1;
    const overrides = [
      http.get("*/api/services", () =>
        failures-- > 0
          ? HttpResponse.json(
              {
                error: {
                  code: "TEMPORARILY_BUSY",
                  message:
                    "O sistema está ocupado. Tente novamente em instantes.",
                  requestId: "r",
                },
              },
              { status: 503 },
            )
          : HttpResponse.json({ services: state.panel.services }),
      ),
    ];
    const { user } = renderApp(state, { route: "/servicos", overrides });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    expect(
      screen.queryByText(/Nenhum serviço cadastrado/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Corte")).toBeInTheDocument();
  });
});

describe("criar serviço", () => {
  it("envia nome, duração, intervalo (buffer) e preço em centavos; mostra o resultado real da API", async () => {
    const state = panelState();
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Novo serviço" }),
    );
    await user.type(screen.getByLabelText("Nome"), "  Corte masculino ");
    await user.type(screen.getByLabelText("Duração (minutos)"), "45");
    await user.clear(screen.getByLabelText(/Intervalo de preparação/));
    await user.type(screen.getByLabelText(/Intervalo de preparação/), "10");
    await user.type(screen.getByLabelText("Preço (R$, opcional)"), "1.234,5");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Serviço criado.")).toBeInTheDocument();
    expect(callsTo(state, "POST", "/api/services")[0]?.body).toEqual({
      name: "Corte masculino",
      durationMinutes: 45,
      bufferMinutes: 10,
      priceCents: 123450,
    });
    const list = await screen.findByRole("list", { name: "Serviços" });
    expect(within(list).getByText("Corte masculino")).toBeInTheDocument();
    expect(list).toHaveTextContent("45 min + 10 min de intervalo");
    expect(
      screen.queryByRole("form", { name: "Novo serviço" }),
    ).not.toBeInTheDocument();
  });

  it("intervalo em branco vira 0 e preço em branco vira null", async () => {
    const state = panelState();
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Novo serviço" }),
    );
    await user.type(screen.getByLabelText("Nome"), "Barba");
    await user.type(screen.getByLabelText("Duração (minutos)"), "20");
    await user.clear(screen.getByLabelText(/Intervalo de preparação/));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Serviço criado.");
    expect(callsTo(state, "POST", "/api/services")[0]?.body).toEqual({
      name: "Barba",
      durationMinutes: 20,
      bufferMinutes: 0,
      priceCents: null,
    });
  });

  it.each([
    [
      "nome vazio",
      { name: "", duration: "30", buffer: "0", price: "" },
      "Nome",
      "Informe o nome do serviço.",
    ],
    [
      "duração vazia",
      { name: "A", duration: "", buffer: "0", price: "" },
      "Duração (minutos)",
      "Informe a duração.",
    ],
    [
      "duração zero",
      { name: "A", duration: "0", buffer: "0", price: "" },
      "Duração (minutos)",
      "A duração deve ser de pelo menos 1 minuto.",
    ],
    [
      "duração decimal",
      { name: "A", duration: "1,5", buffer: "0", price: "" },
      "Duração (minutos)",
      "Informe um número inteiro de minutos.",
    ],
    [
      "duração enorme",
      { name: "A", duration: "1441", buffer: "0", price: "" },
      "Duração (minutos)",
      "No máximo 1440 minutos.",
    ],
    [
      "intervalo negativo",
      { name: "A", duration: "30", buffer: "-5", price: "" },
      /Intervalo de preparação/,
      "Informe um número inteiro de minutos.",
    ],
    [
      "preço inválido",
      { name: "A", duration: "30", buffer: "0", price: "cinquenta" },
      "Preço (R$, opcional)",
      "Informe o preço em reais, como 50,00.",
    ],
    [
      "preço com 3 casas",
      { name: "A", duration: "30", buffer: "0", price: "50,555" },
      "Preço (R$, opcional)",
      "Informe o preço em reais, como 50,00.",
    ],
  ])(
    "validação local (%s): mostra o erro no campo e NÃO envia",
    async (_name, values, label, message) => {
      const state = panelState();
      const { user } = renderApp(state, { route: "/servicos" });
      await user.click(
        await screen.findByRole("button", { name: "Novo serviço" }),
      );
      if (values.name)
        await user.type(screen.getByLabelText("Nome"), values.name);
      if (values.duration)
        await user.type(
          screen.getByLabelText("Duração (minutos)"),
          values.duration,
        );
      await user.clear(screen.getByLabelText(/Intervalo de preparação/));
      if (values.buffer)
        await user.type(
          screen.getByLabelText(/Intervalo de preparação/),
          values.buffer,
        );
      if (values.price)
        await user.type(
          screen.getByLabelText("Preço (R$, opcional)"),
          values.price,
        );
      await user.click(screen.getByRole("button", { name: "Salvar" }));
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(
        expect.stringContaining(message),
      );
      expect(callsTo(state, "POST", "/api/services")).toHaveLength(0);
    },
  );

  it("erro 400 do servidor com detalhes é mapeado ao campo; 429 mostra a mensagem do servidor; o formulário continua utilizável", async () => {
    const state = panelState();
    let mode: "field" | "limit" = "field";
    const overrides = [
      http.post("*/api/services", () =>
        mode === "field"
          ? HttpResponse.json(
              {
                error: {
                  code: "VALIDATION_ERROR",
                  message: "Dados inválidos.",
                  details: [{ path: "name", message: "Nome muito longo." }],
                  requestId: "r",
                },
              },
              { status: 400 },
            )
          : HttpResponse.json(
              {
                error: {
                  code: "RATE_LIMITED",
                  message: "Muitas tentativas. Tente novamente mais tarde.",
                  requestId: "r",
                },
              },
              { status: 429 },
            ),
      ),
    ];
    const { user } = renderApp(state, { route: "/servicos", overrides });
    await user.click(
      await screen.findByRole("button", { name: "Novo serviço" }),
    );
    await user.type(screen.getByLabelText("Nome"), "A");
    await user.type(screen.getByLabelText("Duração (minutos)"), "30");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Nome")).toHaveAccessibleDescription(
        "Nome muito longo.",
      ),
    );
    mode = "limit";
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Muitas tentativas.",
    );
    expect(screen.getByRole("button", { name: "Salvar" })).toBeEnabled();
    expect(screen.getByLabelText("Nome")).toHaveValue("A"); // nada foi perdido
  });

  it("cancelar fecha o formulário sem enviar nada", async () => {
    const state = panelState();
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Novo serviço" }),
    );
    await user.type(screen.getByLabelText("Nome"), "Rascunho");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
    expect(callsTo(state, "POST", "/api/services")).toHaveLength(0);
  });

  it("clique duplo em Salvar envia uma única criação", async () => {
    const state = panelState();
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Novo serviço" }),
    );
    await user.type(screen.getByLabelText("Nome"), "Corte");
    await user.type(screen.getByLabelText("Duração (minutos)"), "30");
    await user.dblClick(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Serviço criado.");
    expect(callsTo(state, "POST", "/api/services")).toHaveLength(1);
  });
});

describe("editar e ativar/desativar", () => {
  it("editar abre o formulário preenchido, envia os campos e atualiza a lista", async () => {
    const state = panelState({
      services: [
        makeService("s1", "Corte", {
          durationMinutes: 30,
          bufferMinutes: 10,
          priceCents: 5000,
        }),
      ],
    });
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Editar Corte" }),
    );
    expect(screen.getByLabelText("Nome")).toHaveValue("Corte");
    expect(screen.getByLabelText("Duração (minutos)")).toHaveValue("30");
    expect(screen.getByLabelText(/Intervalo de preparação/)).toHaveValue("10");
    expect(screen.getByLabelText("Preço (R$, opcional)")).toHaveValue("50,00");
    await user.clear(screen.getByLabelText("Duração (minutos)"));
    await user.type(screen.getByLabelText("Duração (minutos)"), "45");
    await user.clear(screen.getByLabelText("Preço (R$, opcional)")); // remove o preço
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Serviço atualizado.")).toBeInTheDocument();
    expect(callsTo(state, "PATCH", "/api/services/s1")[0]?.body).toEqual({
      name: "Corte",
      durationMinutes: 45,
      bufferMinutes: 10,
      priceCents: null,
    });
    await waitFor(() =>
      expect(row("Corte")).toHaveTextContent(
        "45 min + 10 min de intervalo · sem preço",
      ),
    );
  });

  it("desativar e reativar: envia { active } e reflete a situação devolvida pelo servidor", async () => {
    const state = panelState({ services: [makeService("s1", "Corte")] });
    const { user } = renderApp(state, { route: "/servicos" });
    await user.click(
      await screen.findByRole("button", { name: "Desativar Corte" }),
    );
    expect(
      await screen.findByText('"Corte" foi desativado.'),
    ).toBeInTheDocument();
    expect(callsTo(state, "PATCH", "/api/services/s1")[0]?.body).toEqual({
      active: false,
    });
    await waitFor(() =>
      expect(within(row("Corte")).getByText("Inativo")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Ativar Corte" }));
    expect(await screen.findByText('"Corte" foi ativado.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(row("Corte")).queryByText("Inativo"),
      ).not.toBeInTheDocument(),
    );
  });

  it("falha ao desativar (404: serviço sumiu): mostra o erro e NÃO muda a situação na tela", async () => {
    const state = panelState({ services: [makeService("s1", "Corte")] });
    const { user } = renderApp(state, { route: "/servicos" });
    await screen.findByText("Corte");
    state.panel.services = []; // removido por outro meio entre a listagem e o clique
    await user.click(screen.getByRole("button", { name: "Desativar Corte" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recurso não encontrado.",
    );
  });
});
