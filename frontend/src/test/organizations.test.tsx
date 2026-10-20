// Seletor de empresa, criação de empresa e casca autenticada (cabeçalho, troca de empresa, X-Active-Org).
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";

const calls = (state: ReturnType<typeof makeState>, path: string) =>
  state.calls.filter((c) => c.path === path);

describe("seletor de empresa", () => {
  it("sem empresa: sessão sem empresa ativa é levada a /empresas e vê o formulário de criação", async () => {
    const { container } = renderApp(makeState({ user: ANA }), { route: "/" });
    expect(
      await screen.findByRole("heading", { name: "Suas empresas" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/empresas");
    expect(
      screen.getByText(/ainda não tem nenhuma empresa/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Criar nova empresa" }),
    ).toBeInTheDocument();
  });

  it("lista as empresas do usuário, marca a ativa e escolher outra troca a empresa da SESSÃO (por slug)", async () => {
    const state = makeState({
      user: ANA,
      organizations: [
        makeOrg("salao", "Salão da Ana"),
        makeOrg("barbearia", "Barbearia"),
      ],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/empresas" });
    const list = await screen.findByRole("list", { name: "Empresas" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Ativa")).toBeInTheDocument();
    expect(within(items[1]!).queryByText("Ativa")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Entrar em Barbearia" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Barbearia" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
    // o corpo leva SÓ o slug (nunca um organizationId)
    expect(calls(state, "/api/session/active-organization")[0]?.body).toEqual({
      slug: "barbearia",
    });
    expect(state.activeSlug).toBe("barbearia");
  });

  it("depois de escolher, as chamadas de empresa levam X-Active-Org com o slug exibido (asserção entre abas)", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    renderApp(state, { route: "/" });
    await screen.findByRole("heading", { name: "Salão da Ana" });
    const tenantCall = calls(state, "/api/organization")[0];
    expect(tenantCall?.headers.get("x-active-org")).toBe("salao");
    // listar as empresas (rota do usuário, anterior à escolha) ainda não afirma nenhuma empresa
    expect(
      calls(state, "/api/organizations")[0]?.headers.get("x-active-org"),
    ).toBeNull();
  });

  it("empresa que o servidor não conhece (404): mostra o erro e continua na tela", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
    });
    const { user } = renderApp(state, { route: "/empresas" });
    await screen.findByRole("list", { name: "Empresas" });
    state.organizations = []; // sumiu no servidor entre a listagem e o clique
    await user.click(
      screen.getByRole("button", { name: "Entrar em Salão da Ana" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recurso não encontrado.",
    );
  });
});

describe("criar empresa", () => {
  it("sugere o endereço a partir do nome (sem acentos), envia nome/slug/fuso e vai para o painel", async () => {
    const state = makeState({ user: ANA });
    const { user, container } = renderApp(state, { route: "/empresas" });
    await user.type(
      await screen.findByLabelText("Nome da empresa"),
      "Salão da Açaí & Cia",
    );
    expect(screen.getByLabelText("Endereço")).toHaveValue("salao-da-acai-cia");
    await user.selectOptions(
      screen.getByLabelText("Fuso horário"),
      "America/Manaus",
    );
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));
    expect(
      await screen.findByRole("heading", { name: "Salão da Açaí & Cia" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
    expect(
      calls(state, "/api/organizations").find((c) => c.method === "POST")?.body,
    ).toEqual({
      name: "Salão da Açaí & Cia",
      slug: "salao-da-acai-cia",
      timezone: "America/Manaus",
    });
    expect(state.activeSlug).toBe("salao-da-acai-cia"); // criar torna a empresa a ativa da sessão
  });

  it("endereço editado à mão deixa de seguir o nome; validação local do formato do endereço", async () => {
    const state = makeState({ user: ANA });
    const { user } = renderApp(state, { route: "/empresas" });
    await user.type(await screen.findByLabelText("Nome da empresa"), "Salão");
    await user.clear(screen.getByLabelText("Endereço"));
    await user.type(screen.getByLabelText("Endereço"), "Meu_Endereço!");
    await user.type(screen.getByLabelText("Nome da empresa"), " Novo");
    expect(screen.getByLabelText("Endereço")).toHaveValue("Meu_Endereço!");
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));
    expect(screen.getByLabelText("Endereço")).toHaveAccessibleDescription(
      expect.stringContaining("Use apenas letras minúsculas"),
    );
    expect(
      calls(state, "/api/organizations").filter((c) => c.method === "POST"),
    ).toHaveLength(0);
  });

  it("nome vazio e endereço curto não geram requisição", async () => {
    const state = makeState({ user: ANA });
    const { user } = renderApp(state, { route: "/empresas" });
    await user.click(
      await screen.findByRole("button", { name: "Criar empresa" }),
    );
    expect(
      screen.getByLabelText("Nome da empresa"),
    ).toHaveAccessibleDescription("Informe o nome da empresa.");
    expect(
      calls(state, "/api/organizations").filter((c) => c.method === "POST"),
    ).toHaveLength(0);
  });

  it("endereço já em uso (409 SLUG_UNAVAILABLE): erro no campo do endereço, sem sair da tela", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao")],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/empresas" });
    await user.type(await screen.findByLabelText("Nome da empresa"), "Salão");
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Endereço")).toHaveAccessibleDescription(
        expect.stringContaining("Este endereço já está em uso."),
      ),
    );
    expect(currentPath(container)).toBe("/empresas");
    expect(screen.getByRole("button", { name: "Criar empresa" })).toBeEnabled();
  });

  it("e-mail não confirmado: o aviso aparece UMA vez e o servidor recusa a criação com a mensagem dele", async () => {
    const state = makeState({ user: { ...ANA, emailVerified: false } });
    const { user } = renderApp(state, { route: "/empresas" });
    const input = await screen.findByLabelText("Nome da empresa");
    expect(screen.getAllByText(/Confirme seu e-mail/)).toHaveLength(1); // só a faixa da casca, sem duplicata no formulário
    await user.type(input, "Salão da Ana");
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));
    expect(
      await screen.findByText(
        "Confirme seu e-mail antes de criar uma empresa.",
      ),
    ).toBeInTheDocument();
    expect(state.organizations).toHaveLength(0);
  });
});

describe("falha ao listar as empresas (erro NÃO é lista vazia)", () => {
  const failList = (status: number, body?: object) =>
    http.get("*/api/organizations", () =>
      body === undefined
        ? HttpResponse.error()
        : HttpResponse.json(body, { status }),
    );
  const busy = {
    error: {
      code: "TEMPORARILY_BUSY",
      message: "O sistema está ocupado. Tente novamente em instantes.",
      requestId: "r",
    },
  };

  it("carga inicial com 503: alerta + 'Tentar novamente'; sem a frase de lista vazia e sem o formulário de criação", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
    });
    const overrides = [failList(503, busy)];
    renderApp(state, { route: "/empresas", overrides });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    expect(
      screen.getByRole("button", { name: "Tentar novamente" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/ainda não tem nenhuma empresa/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Criar nova empresa" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Criar empresa" }),
    ).not.toBeInTheDocument();
  });

  it("falha de rede: mensagem de conexão em pt-BR (sem detalhes técnicos) e nova tentativa", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
    });
    const overrides = [failList(0)];
    renderApp(state, { route: "/empresas", overrides });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível conectar ao servidor.");
    expect(alert).not.toHaveTextContent(
      /Failed to fetch|NetworkError|TypeError/,
    );
    expect(
      screen.queryByText(/ainda não tem nenhuma empresa/),
    ).not.toBeInTheDocument();
  });

  it("'Tentar novamente' volta a carregar e, com sucesso, mostra a lista de verdade", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
    });
    let failures = 1;
    const overrides = [
      http.get("*/api/organizations", () =>
        failures-- > 0
          ? HttpResponse.json(busy, { status: 503 })
          : HttpResponse.json({
              organizations: state.organizations,
              activeSlug: state.activeSlug,
            }),
      ),
    ];
    const { user } = renderApp(state, { route: "/empresas", overrides });
    await user.click(
      await screen.findByRole("button", { name: "Tentar novamente" }),
    );
    const list = await screen.findByRole("list", { name: "Empresas" });
    expect(within(list).getByText("Salão da Ana")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a nova tentativa pode falhar de novo: continua mostrando o erro (e nunca a lista vazia)", async () => {
    const state = makeState({ user: ANA, organizations: [] });
    const overrides = [failList(503, busy)];
    const { user } = renderApp(state, { route: "/empresas", overrides });
    await user.click(
      await screen.findByRole("button", { name: "Tentar novamente" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    expect(
      screen.queryByText(/ainda não tem nenhuma empresa/),
    ).not.toBeInTheDocument();
  });

  it("lista REALMENTE vazia (200 com []): é um fato do servidor, então mostra o estado vazio e o formulário", async () => {
    renderApp(makeState({ user: ANA, organizations: [] }), {
      route: "/empresas",
    });
    expect(
      await screen.findByText(/ainda não tem nenhuma empresa/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Criar empresa" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tentar novamente" }),
    ).not.toBeInTheDocument();
  });

  it("no painel (/), a falha NÃO redireciona para /empresas: mostra o erro e, ao acertar, abre o painel", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    let failures = 1;
    const overrides = [
      http.get("*/api/organizations", () =>
        failures-- > 0
          ? HttpResponse.json(busy, { status: 503 })
          : HttpResponse.json({
              organizations: state.organizations,
              activeSlug: state.activeSlug,
            }),
      ),
    ];
    const { user, container } = renderApp(state, { route: "/", overrides });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    expect(currentPath(container)).toBe("/");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
  });
});

describe("casca autenticada", () => {
  it("mostra o usuário e a empresa ativa; trocar a empresa pelo cabeçalho atualiza o painel", async () => {
    const state = makeState({
      user: ANA,
      organizations: [
        makeOrg("salao", "Salão da Ana"),
        makeOrg("barbearia", "Barbearia"),
      ],
      activeSlug: "salao",
    });
    const { user } = renderApp(state, { route: "/" });
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Empresa ativa" });
    expect(select).toHaveValue("salao");
    await user.selectOptions(select, "barbearia");
    expect(
      await screen.findByRole("heading", { name: "Barbearia" }),
    ).toBeInTheDocument();
    expect(state.activeSlug).toBe("barbearia");
    // a asserção de consistência acompanha a troca
    await waitFor(() =>
      expect(
        calls(state, "/api/organization").at(-1)?.headers.get("x-active-org"),
      ).toBe("barbearia"),
    );
  });
});
