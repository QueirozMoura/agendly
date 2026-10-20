// Painel de profissionais (Etapa 12): lista, criação, dados, ativar/desativar e vínculos com serviços.
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { makeProfessional, makeService } from "./fakePanel";
import { callsTo, panelState } from "./panelHelpers";
import { currentPath, renderApp } from "./render";

describe("lista e criação", () => {
  it("lista com situação e quantidade de serviços; link para gerenciar", async () => {
    const state = panelState({
      services: [makeService("s1", "Corte"), makeService("s2", "Barba")],
      professionals: [
        makeProfessional("p1", "Carla", { serviceIds: ["s1", "s2"] }),
        makeProfessional("p2", "Davi", { serviceIds: ["s1"], active: false }),
        makeProfessional("p3", "Eva"),
      ],
    });
    renderApp(state, { route: "/profissionais" });
    const list = await screen.findByRole("list", { name: "Profissionais" });
    const carla = within(list).getByText("Carla").closest("li") as HTMLElement;
    expect(carla).toHaveTextContent("2 serviços");
    expect(within(list).getByText("Davi").closest("li")).toHaveTextContent(
      "1 serviço",
    );
    expect(within(list).getByText("Davi").closest("li")).toHaveTextContent(
      "Inativo",
    );
    expect(within(list).getByText("Eva").closest("li")).toHaveTextContent(
      "Nenhum serviço vinculado",
    );
    expect(
      screen.getByRole("link", { name: "Gerenciar Carla" }),
    ).toHaveAttribute("href", "/profissionais/p1");
  });

  it("lista vazia legítima mostra o convite; erro de carga mostra erro + tentar novamente (sem o convite)", async () => {
    const { unmount } = renderApp(panelState(), { route: "/profissionais" });
    expect(
      await screen.findByText(/Nenhum profissional cadastrado ainda/),
    ).toBeInTheDocument();
    unmount();
    renderApp(panelState(), {
      route: "/profissionais",
      overrides: [http.get("*/api/professionals", () => HttpResponse.error())],
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível conectar ao servidor.",
    );
    expect(
      screen.queryByText(/Nenhum profissional cadastrado/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Tentar novamente" }),
    ).toBeInTheDocument();
  });

  it("criar leva à página do novo profissional (para vincular serviços e horários)", async () => {
    const state = panelState();
    const { user, container } = renderApp(state, { route: "/profissionais" });
    await user.type(await screen.findByLabelText("Nome"), "  Fernanda ");
    await user.click(
      screen.getByRole("button", { name: "Criar profissional" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Fernanda" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toMatch(/^\/profissionais\/pro-\d+$/);
    expect(callsTo(state, "POST", "/api/professionals")[0]?.body).toEqual({
      name: "Fernanda",
    });
  });

  it("nome vazio não envia; erro do servidor aparece no campo", async () => {
    const state = panelState();
    const { user } = renderApp(state, {
      route: "/profissionais",
      overrides: [
        http.post("*/api/professionals", () =>
          HttpResponse.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "Dados inválidos.",
                details: [{ path: "name", message: "Nome muito longo." }],
                requestId: "r",
              },
            },
            { status: 400 },
          ),
        ),
      ],
    });
    await user.click(
      await screen.findByRole("button", { name: "Criar profissional" }),
    );
    expect(screen.getByLabelText("Nome")).toHaveAccessibleDescription(
      "Informe o nome do profissional.",
    );
    expect(callsTo(state, "POST", "/api/professionals")).toHaveLength(0);
    await user.type(screen.getByLabelText("Nome"), "X");
    await user.click(
      screen.getByRole("button", { name: "Criar profissional" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Nome")).toHaveAccessibleDescription(
        "Nome muito longo.",
      ),
    );
  });
});

describe("página do profissional", () => {
  const withPro = (over = {}) =>
    panelState({
      services: [
        makeService("s1", "Corte"),
        makeService("s2", "Barba"),
        makeService("s3", "Hidratação", { active: false }),
      ],
      professionals: [makeProfessional("p1", "Carla", { serviceIds: ["s1"] })],
      ...over,
    });

  it("profissional inexistente ou de outra empresa (404): erro + volta à lista; nada de dados falsos", async () => {
    renderApp(withPro(), { route: "/profissionais/de-outra-empresa" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recurso não encontrado.",
    );
    expect(
      screen.getByRole("link", { name: "Voltar aos profissionais" }),
    ).toHaveAttribute("href", "/profissionais");
    expect(
      screen.queryByRole("heading", { name: "Horário de trabalho" }),
    ).not.toBeInTheDocument();
  });

  it("o id da URL nunca vira outro caminho da API (../me é codificado, não normalizado)", async () => {
    const state = withPro();
    renderApp(state, { route: "/profissionais/..%2Fme" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const paths = state.calls.map((c) => c.path);
    // só a consulta inicial da sessão chama /api/me; o id da URL foi codificado em UM segmento de /api/professionals/…
    expect(paths.filter((p) => p === "/api/me")).toHaveLength(1);
    expect(
      paths.some((p) => /^\/api\/professionals\/\.\.%2[Ff]me$/.test(p)),
    ).toBe(true);
  });

  it("renomear envia o nome limpo e mostra o aviso; nome vazio não envia", async () => {
    const state = withPro();
    const { user } = renderApp(state, { route: "/profissionais/p1" });
    const input = await screen.findByLabelText("Nome");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));
    expect(input).toHaveAccessibleDescription(
      "Informe o nome do profissional.",
    );
    expect(callsTo(state, "PATCH", "/api/professionals/p1")).toHaveLength(0);
    await user.type(input, "  Carla Souza ");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));
    expect(await screen.findByText("Nome atualizado.")).toBeInTheDocument();
    expect(callsTo(state, "PATCH", "/api/professionals/p1")[0]?.body).toEqual({
      name: "Carla Souza",
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Carla Souza",
      ),
    );
  });

  it("desativar e reativar o profissional (agendamentos existentes permanecem)", async () => {
    const state = withPro();
    const { user } = renderApp(state, { route: "/profissionais/p1" });
    await user.click(
      await screen.findByRole("button", { name: "Desativar profissional" }),
    );
    expect(
      await screen.findByText(
        /Profissional desativado\. Agendamentos já existentes permanecem\./,
      ),
    ).toBeInTheDocument();
    expect(callsTo(state, "PATCH", "/api/professionals/p1")[0]?.body).toEqual({
      active: false,
    });
    expect(
      await screen.findByRole("button", { name: "Ativar profissional" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Situação: inativo")).toBeInTheDocument();
  });

  it("vínculos: reflete o conjunto atual, marca/desmarca, salva o conjunto COMPLETO (PUT) e sinaliza serviço inativo", async () => {
    const state = withPro();
    const { user } = renderApp(state, { route: "/profissionais/p1" });
    const corte = await screen.findByRole("checkbox", { name: "Corte" });
    expect(corte).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Barba" })).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Hidratação/ }),
    ).toHaveAccessibleName(/Inativo/);
    await user.click(screen.getByRole("checkbox", { name: "Barba" }));
    await user.click(screen.getByRole("checkbox", { name: /Hidratação/ }));
    await user.click(corte); // desmarca
    await user.click(screen.getByRole("button", { name: "Salvar serviços" }));
    expect(
      await screen.findByText("Serviços atualizados."),
    ).toBeInTheDocument();
    expect(
      callsTo(state, "PUT", "/api/professionals/p1/services")[0]?.body,
    ).toEqual({ serviceIds: expect.arrayContaining(["s2", "s3"]) });
    expect(
      (
        callsTo(state, "PUT", "/api/professionals/p1/services")[0]?.body as {
          serviceIds: string[];
        }
      ).serviceIds,
    ).toHaveLength(2);
    expect(state.panel.professionals[0]?.serviceIds).toEqual(["s2", "s3"]);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Corte" })).not.toBeChecked(),
    );
  });

  it("desmarcar tudo envia a lista vazia (desvincula tudo)", async () => {
    const state = withPro();
    const { user } = renderApp(state, { route: "/profissionais/p1" });
    await user.click(await screen.findByRole("checkbox", { name: "Corte" }));
    await user.click(screen.getByRole("button", { name: "Salvar serviços" }));
    await screen.findByText("Serviços atualizados.");
    expect(
      callsTo(state, "PUT", "/api/professionals/p1/services")[0]?.body,
    ).toEqual({ serviceIds: [] });
  });

  it("erro do servidor ao salvar vínculos (404, serviço sumiu): mostra o erro e mantém a seleção do usuário", async () => {
    const state = withPro();
    const { user } = renderApp(state, { route: "/profissionais/p1" });
    await user.click(await screen.findByRole("checkbox", { name: "Barba" }));
    state.panel.services = state.panel.services.filter((s) => s.id !== "s2");
    await user.click(screen.getByRole("button", { name: "Salvar serviços" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recurso não encontrado.",
    );
    expect(screen.getByRole("checkbox", { name: "Barba" })).toBeChecked();
    expect(state.panel.professionals[0]?.serviceIds).toEqual(["s1"]); // nada foi aplicado
  });

  it("sem serviços cadastrados: convida a cadastrar e não mostra caixas de seleção", async () => {
    renderApp(
      panelState({ professionals: [makeProfessional("p1", "Carla")] }),
      { route: "/profissionais/p1" },
    );
    expect(
      await screen.findByRole("link", { name: "Cadastre um serviço" }),
    ).toHaveAttribute("href", "/servicos");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("acessibilidade básica: seções com nome acessível e campos com rótulo", async () => {
    renderApp(withPro(), { route: "/profissionais/p1" });
    await screen.findByRole("heading", { name: "Carla" });
    for (const name of [
      "Dados do profissional",
      "Serviços do profissional",
      "Horário de trabalho",
      "Folgas",
    ])
      expect(
        screen.getByRole(
          name === "Dados do profissional" ||
            name === "Serviços do profissional"
            ? "form"
            : "region",
          { name },
        ),
      ).toBeInTheDocument();
  });
});
