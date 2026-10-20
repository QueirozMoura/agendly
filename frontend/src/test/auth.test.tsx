// Fluxos de autenticação da SPA (testes de componente com Testing Library + MSW): login, cadastro, verificação de
// e-mail, recuperação e redefinição de senha, saída e proteção de rotas.
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ANA, makeOrg, makeState } from "./fakeBackend";
import { currentPath, renderApp } from "./render";
import { server } from "./server";

const PASSWORD = "uma-senha-bem-longa-9X";
const calls = (state: ReturnType<typeof makeState>, path: string) =>
  state.calls.filter((c) => c.path === path);

describe("proteção de rotas", () => {
  it("anônimo em rota protegida vai para /entrar e volta depois do login (from)", async () => {
    const state = makeState({ organizations: [makeOrg("salao")] });
    const { user, container } = renderApp(state, { route: "/empresas" });
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/entrar");
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(
      await screen.findByRole("heading", { name: "Suas empresas" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/empresas");
  });

  it("autenticado em /entrar ou /cadastro é levado ao início", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { container } = renderApp(state, { route: "/entrar" });
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/");
  });

  it("rota inexistente mostra a página 404 em pt-BR", async () => {
    renderApp(makeState(), { route: "/nao-existe" });
    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeInTheDocument();
  });
});

describe("login", () => {
  it("credenciais erradas: mostra a mensagem do servidor, permanece na tela e o formulário volta a ficar utilizável", async () => {
    const state = makeState();
    const { user, container } = renderApp(state, { route: "/entrar" });
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "senha-errada-123");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "E-mail ou senha incorretos.",
    );
    expect(currentPath(container)).toBe("/entrar");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(
      screen.queryByText(
        "Sua sessão terminou. Entre novamente para continuar.",
      ),
    ).not.toBeInTheDocument();
  });

  it("validação local: campos vazios e e-mail inválido não geram requisição", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/entrar" });
    await user.click(await screen.findByRole("button", { name: "Entrar" }));
    expect(screen.getByLabelText("E-mail")).toHaveAccessibleDescription(
      "E-mail inválido.",
    );
    expect(screen.getByLabelText("Senha")).toHaveAccessibleDescription(
      "Informe a senha.",
    );
    expect(screen.getByLabelText("E-mail")).toBeInvalid();
    await user.type(screen.getByLabelText("E-mail"), "isso-nao-e-email");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(screen.getByLabelText("E-mail")).toHaveAccessibleDescription(
      "E-mail inválido.",
    );
    expect(calls(state, "/api/auth/login")).toHaveLength(0);
  });

  it("normaliza o e-mail (minúsculas, sem espaços) e envia JSON; sucesso sem empresa leva a /empresas", async () => {
    const state = makeState();
    const { user, container } = renderApp(state, { route: "/entrar" });
    await user.type(
      await screen.findByLabelText("E-mail"),
      "  ANA@Example.COM ",
    );
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(
      await screen.findByRole("heading", { name: "Suas empresas" }),
    ).toBeInTheDocument();
    expect(currentPath(container)).toBe("/empresas");
    const [login] = calls(state, "/api/auth/login");
    expect(login?.body).toEqual({
      email: "ana@example.com",
      password: PASSWORD,
    });
    expect(login?.headers.get("content-type")).toBe("application/json");
  });

  it("login com empresa ativa na sessão cai direto no painel dela", async () => {
    const state = makeState({
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user } = renderApp(state, { route: "/entrar" });
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
  });

  it("não envia duas vezes: o botão fica desabilitado enquanto a requisição está em andamento", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/entrar" });
    await user.type(await screen.findByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    const button = screen.getByRole("button", { name: "Entrar" });
    await user.dblClick(button);
    await screen.findByRole("heading", { name: "Suas empresas" });
    expect(calls(state, "/api/auth/login")).toHaveLength(1);
  });
});

describe("cadastro", () => {
  it("validação local (nome, e-mail e senha curta) não gera requisição", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/cadastro" });
    await user.click(
      await screen.findByRole("button", { name: "Criar conta" }),
    );
    expect(screen.getByLabelText("Nome")).toHaveAccessibleDescription(
      "Informe seu nome.",
    );
    await user.type(screen.getByLabelText("Nome"), "Ana");
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "curta");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(screen.getByLabelText("Senha")).toHaveAccessibleDescription(
      expect.stringContaining("A senha deve ter pelo menos 10 caracteres."),
    );
    expect(calls(state, "/api/auth/register")).toHaveLength(0);
  });

  it("sucesso: mostra a mensagem do servidor (idêntica exista a conta ou não) e o link para o login", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/cadastro" });
    await user.type(await screen.findByLabelText("Nome"), " Ana Maria ");
    await user.type(screen.getByLabelText("E-mail"), "ANA@example.com");
    await user.type(screen.getByLabelText("Senha"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(
      await screen.findByRole("heading", { name: "Verifique seu e-mail" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cadastro recebido.");
    expect(
      screen.getByRole("link", { name: "Ir para o login" }),
    ).toHaveAttribute("href", "/entrar");
    expect(calls(state, "/api/auth/register")[0]?.body).toEqual({
      name: "Ana Maria",
      email: "ana@example.com",
      password: PASSWORD,
    });
  });

  it("erro 400 do servidor com detalhes é mapeado para o campo certo (regra que só o servidor conhece)", async () => {
    const { user } = renderApp(makeState(), { route: "/cadastro" });
    // instalado DEPOIS do backend falso: handlers mais recentes têm prioridade
    server.use(
      http.post("*/api/auth/register", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Dados inválidos.",
              details: [
                {
                  path: "password",
                  message: "Essa senha é muito comum. Escolha outra.",
                },
              ],
              requestId: "r",
            },
          },
          { status: 400 },
        ),
      ),
    );
    await user.type(await screen.findByLabelText("Nome"), "Ana");
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "1234567890");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Senha")).toHaveAccessibleDescription(
        expect.stringContaining("Essa senha é muito comum. Escolha outra."),
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "Verifique seu e-mail" }),
    ).not.toBeInTheDocument();
  });
});

describe("verificação de e-mail (link do e-mail: /verificar-email#token=…, com clique explícito)", () => {
  it("abrir o link NÃO consome o token: mostra o botão, tira o token da URL e só envia depois do clique", async () => {
    const state = makeState();
    const { user, container } = renderApp(state, {
      route: "/verificar-email#token=token-de-verificacao",
      strict: true,
    });
    expect(
      await screen.findByRole("button", { name: "Confirmar e-mail" }),
    ).toBeEnabled();
    // dá tempo de qualquer efeito colateral (StrictMode roda os efeitos duas vezes) e nada é enviado
    await new Promise((r) => setTimeout(r, 150));
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(0);
    expect(state.validVerifyToken).toBe("token-de-verificacao"); // continua válido: um scanner não o gastou
    expect(currentPath(container)).toBe("/verificar-email"); // fragmento removido da barra de endereço
    await user.click(screen.getByRole("button", { name: "Confirmar e-mail" }));
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(1);
    expect(calls(state, "/api/auth/verify-email")[0]?.body).toEqual({
      token: "token-de-verificacao",
    });
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute(
      "href",
      "/entrar",
    );
    expect(currentPath(container)).toBe("/verificar-email");
  });

  it("clique duplo envia UMA requisição (o botão fica desabilitado enquanto confirma)", async () => {
    const state = makeState();
    const { user } = renderApp(state, {
      route: "/verificar-email#token=token-de-verificacao",
    });
    await user.dblClick(
      await screen.findByRole("button", { name: "Confirmar e-mail" }),
    );
    await screen.findByText("E-mail confirmado com sucesso.");
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(1);
  });

  it("durante a confirmação mostra o progresso e desabilita o botão", async () => {
    const state = makeState();
    const { user } = renderApp(state, {
      route: "/verificar-email#token=token-de-verificacao",
    });
    await screen.findByRole("button", { name: "Confirmar e-mail" });
    server.use(
      http.post("*/api/auth/verify-email", async () => {
        await new Promise((r) => setTimeout(r, 200));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await user.click(screen.getByRole("button", { name: "Confirmar e-mail" }));
    expect(screen.getByRole("button", { name: "Confirmando…" })).toBeDisabled();
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
  });

  it("token inválido, expirado ou já usado: mostra a mensagem do servidor, orienta a entrar e NÃO oferece repetir", async () => {
    const state = makeState();
    const { user } = renderApp(state, {
      route: "/verificar-email#token=outro",
    });
    await user.click(
      await screen.findByRole("button", { name: "Confirmar e-mail" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Link inválido, expirado ou já utilizado.",
    );
    expect(
      screen.getByText(/Se você já confirmou o seu e-mail, basta entrar/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ir para o login" }),
    ).toHaveAttribute("href", "/entrar");
    expect(
      screen.queryByRole("button", { name: "Tentar novamente" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirmar e-mail" }),
    ).not.toBeInTheDocument();
  });

  it("falha transitória (503): o token continua válido e dá para tentar de novo", async () => {
    const state = makeState();
    const { user } = renderApp(state, {
      route: "/verificar-email#token=token-de-verificacao",
    });
    await screen.findByRole("button", { name: "Confirmar e-mail" });
    let failures = 1;
    server.use(
      http.post("*/api/auth/verify-email", () => {
        if (failures-- > 0)
          return HttpResponse.json(
            {
              error: {
                code: "TEMPORARILY_BUSY",
                message:
                  "O sistema está ocupado. Tente novamente em instantes.",
                requestId: "r",
              },
            },
            { status: 503 },
          );
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await user.click(screen.getByRole("button", { name: "Confirmar e-mail" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
  });

  it("sem token: explica, orienta a entrar se já confirmou e NÃO chama a API", async () => {
    const state = makeState();
    renderApp(state, { route: "/verificar-email" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O link de confirmação está incompleto ou já foi usado.",
    );
    expect(
      screen.getByText(/Se você já confirmou o seu e-mail, basta entrar/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirmar e-mail" }),
    ).not.toBeInTheDocument();
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(0);
  });

  it("recarregar a página depois de confirmar continua mostrando o sucesso (e não 'link incompleto')", async () => {
    const state = makeState();
    // o estado do histórico gravado pela confirmação sobrevive ao F5; o token já não está na URL
    renderApp(state, {
      route: "/verificar-email",
      routeState: { emailVerified: true },
    });
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/incompleto/)).not.toBeInTheDocument();
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(0);
  });

  it("novo link aberto na MESMA aba (só o fragmento muda, a página não remonta): o token novo é adotado", async () => {
    const state = makeState();
    const { user, go, container } = renderApp(state, {
      route: "/verificar-email",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "incompleto ou já foi usado",
    );
    await go("/verificar-email#token=token-de-verificacao");
    const button = await screen.findByRole("button", {
      name: "Confirmar e-mail",
    });
    expect(currentPath(container)).toBe("/verificar-email"); // o novo fragmento também saiu da URL
    expect(calls(state, "/api/auth/verify-email")).toHaveLength(0);
    await user.click(button);
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
    expect(calls(state, "/api/auth/verify-email")[0]?.body).toEqual({
      token: "token-de-verificacao",
    });
  });

  it("logado com e-mail não confirmado: ao confirmar, o usuário é relido e o aviso do painel some", async () => {
    const state = makeState({
      user: { ...ANA, emailVerified: false },
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user } = renderApp(state, {
      route: "/verificar-email#token=token-de-verificacao",
    });
    await user.click(
      await screen.findByRole("button", { name: "Confirmar e-mail" }),
    );
    expect(
      await screen.findByText("E-mail confirmado com sucesso."),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("link", { name: "Continuar" }));
    expect(
      await screen.findByRole("heading", { name: "Salão da Ana" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reenviar e-mail de confirmação" }),
    ).not.toBeInTheDocument();
  });
});

describe("recuperação de senha", () => {
  it("pede o link e mostra a MESMA mensagem genérica; envia o e-mail normalizado", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/esqueci-senha" });
    await user.type(
      await screen.findByLabelText("E-mail"),
      "Alguem@Exemplo.com",
    );
    await user.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Se o e-mail estiver cadastrado, enviaremos as instruções para redefinir a senha.",
    );
    expect(calls(state, "/api/auth/forgot-password")[0]?.body).toEqual({
      email: "alguem@exemplo.com",
    });
  });

  it("e-mail inválido não gera requisição", async () => {
    const state = makeState();
    const { user } = renderApp(state, { route: "/esqueci-senha" });
    await user.type(await screen.findByLabelText("E-mail"), "x");
    await user.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(screen.getByLabelText("E-mail")).toHaveAccessibleDescription(
      "E-mail inválido.",
    );
    expect(calls(state, "/api/auth/forgot-password")).toHaveLength(0);
  });

  it("redefinir: token vem do fragmento, sai da URL, senhas precisam conferir e o sucesso leva ao login com aviso", async () => {
    const state = makeState();
    const { user, container } = renderApp(state, {
      route: "/redefinir-senha#token=token-de-reset",
    });
    const field = await screen.findByLabelText("Nova senha");
    expect(currentPath(container)).toBe("/redefinir-senha");
    await user.type(field, "nova-senha-bem-longa-1");
    await user.type(
      screen.getByLabelText("Confirme a nova senha"),
      "diferente-da-outra-2",
    );
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(
      screen.getByLabelText("Confirme a nova senha"),
    ).toHaveAccessibleDescription("As senhas não conferem.");
    expect(calls(state, "/api/auth/reset-password")).toHaveLength(0);
    await user.clear(screen.getByLabelText("Confirme a nova senha"));
    await user.type(
      screen.getByLabelText("Confirme a nova senha"),
      "nova-senha-bem-longa-1",
    );
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Senha redefinida. Entre com a nova senha.",
    );
    expect(calls(state, "/api/auth/reset-password")[0]?.body).toEqual({
      token: "token-de-reset",
      newPassword: "nova-senha-bem-longa-1",
    });
    expect(currentPath(container)).toBe("/entrar");
  });

  it("token inválido: mostra o erro do servidor e permite tentar de novo", async () => {
    const state = makeState();
    const { user } = renderApp(state, {
      route: "/redefinir-senha#token=velho",
    });
    await user.type(
      await screen.findByLabelText("Nova senha"),
      "nova-senha-bem-longa-1",
    );
    await user.type(
      screen.getByLabelText("Confirme a nova senha"),
      "nova-senha-bem-longa-1",
    );
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Link inválido, expirado ou já utilizado.",
    );
    expect(
      screen.getByRole("button", { name: "Redefinir senha" }),
    ).toBeEnabled();
  });

  it("novo link aberto na MESMA aba: o token novo é adotado e sai da URL", async () => {
    const state = makeState();
    const { user, go, container } = renderApp(state, {
      route: "/redefinir-senha",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O link está incompleto ou expirou.",
    );
    await go("/redefinir-senha#token=token-de-reset");
    await user.type(
      await screen.findByLabelText("Nova senha"),
      "nova-senha-bem-longa-1",
    );
    await user.type(
      screen.getByLabelText("Confirme a nova senha"),
      "nova-senha-bem-longa-1",
    );
    expect(currentPath(container)).toBe("/redefinir-senha");
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(calls(state, "/api/auth/reset-password")[0]?.body).toMatchObject({
      token: "token-de-reset",
    });
  });

  it("sem token: orienta a pedir um novo link e não mostra o formulário", async () => {
    renderApp(makeState(), { route: "/redefinir-senha" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O link está incompleto ou expirou.",
    );
    expect(
      screen.getByRole("link", { name: "Pedir novo link" }),
    ).toHaveAttribute("href", "/esqueci-senha");
    expect(screen.queryByLabelText("Nova senha")).not.toBeInTheDocument();
  });
});

describe("sessão", () => {
  it("sair encerra a sessão no servidor, volta ao login e as rotas protegidas voltam a redirecionar", async () => {
    const state = makeState({
      user: ANA,
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user, container } = renderApp(state, { route: "/" });
    await screen.findByRole("heading", { name: "Salão da Ana" });
    await user.click(screen.getByRole("button", { name: "Sair" }));
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(state.user).toBeNull();
    expect(calls(state, "/api/auth/logout")).toHaveLength(1);
    expect(currentPath(container)).toBe("/entrar");
    expect(
      screen.queryByText(
        "Sua sessão terminou. Entre novamente para continuar.",
      ),
    ).not.toBeInTheDocument();
  });

  it("reenviar a confirmação de e-mail mostra a resposta genérica do servidor", async () => {
    const state = makeState({
      user: { ...ANA, emailVerified: false },
      organizations: [makeOrg("salao", "Salão da Ana")],
      activeSlug: "salao",
    });
    const { user } = renderApp(state, { route: "/" });
    await user.click(
      await screen.findByRole("button", {
        name: "Reenviar e-mail de confirmação",
      }),
    );
    const banner = (await screen.findByText(/enviaremos um novo link/)).closest(
      "[role='status']",
    ) as HTMLElement;
    expect(within(banner).getByText(/Confirme seu e-mail/)).toBeInTheDocument();
    expect(calls(state, "/api/auth/resend-verification")).toHaveLength(1);
  });
});
