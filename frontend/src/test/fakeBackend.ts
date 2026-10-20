// Backend FALSO (MSW) que reproduz o CONTRATO real da API para os testes de componente: mesmos caminhos, códigos,
// mensagens e a regra de CSRF (Content-Type JSON em todo método que altera estado). Não substitui o teste contra o
// backend de verdade (documentado em STAGE-11-VALIDATIONS.md); serve para exercitar a UI de forma determinística.
import { http, HttpResponse } from "msw";
import type { ApiOrganization, ApiUser } from "../api/types";

export interface FakeState {
  user: ApiUser | null; // sessão atual (cookie)
  accounts: Array<{ email: string; password: string; user: ApiUser }>;
  organizations: ApiOrganization[];
  activeSlug: string | null;
  validVerifyToken: string;
  validResetToken: string;
  calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Headers;
  }>;
}

export function makeOrg(
  slug: string,
  name = `Empresa ${slug}`,
): ApiOrganization {
  return {
    name,
    slug,
    timezone: "America/Sao_Paulo",
    status: "ACTIVE",
    publishedAt: null,
    publicMinNoticeMinutes: 120,
    publicMaxAdvanceDays: 60,
    publicMaxActiveBookingsPerPhone: 3,
    createdAt: "2031-03-01T12:00:00.000Z",
    role: "OWNER",
  };
}

export const ANA: ApiUser = {
  id: "00000000-0000-7000-8000-000000000001",
  email: "ana@example.com",
  name: "Ana",
  emailVerified: true,
};

export function makeState(over: Partial<FakeState> = {}): FakeState {
  return {
    user: null,
    accounts: [
      { email: ANA.email, password: "uma-senha-bem-longa-9X", user: ANA },
    ],
    organizations: [],
    activeSlug: null,
    validVerifyToken: "token-de-verificacao",
    validResetToken: "token-de-reset",
    calls: [],
    ...over,
  };
}

const error = (
  status: number,
  code: string,
  message: string,
  extra: object = {},
  headers?: HeadersInit,
) =>
  HttpResponse.json(
    { error: { code, message, requestId: "req-1", ...extra } },
    { status, ...(headers ? { headers } : {}) },
  );

const unauthorized = () =>
  error(401, "UNAUTHENTICATED", "Sessão inválida ou expirada.");

export function fakeBackend(state: FakeState) {
  /** Registra a chamada e aplica a regra de CSRF do backend (415 sem Content-Type JSON em escrita). */
  async function guard(request: Request, path: string) {
    let body: unknown = undefined;
    if (request.method !== "GET") {
      const type = request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (type !== "application/json") {
        return {
          rejected: error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "O tipo de conteúdo deve ser application/json.",
          ),
          body,
        };
      }
      body = await request.json();
    }
    state.calls.push({
      method: request.method,
      path,
      body,
      headers: request.headers,
    });
    return { rejected: null, body };
  }
  const route = (
    method: "get" | "post",
    path: string,
    fn: (ctx: {
      body: Record<string, string>;
      request: Request;
    }) => Response | Promise<Response>,
  ) =>
    http[method](`*${path}`, async ({ request }) => {
      const { rejected, body } = await guard(request, path);
      return rejected ?? fn({ body: body as Record<string, string>, request });
    });
  const tenant = (request: Request): Response | null => {
    if (!state.user) return unauthorized();
    if (!state.activeSlug)
      return error(
        403,
        "NO_ACTIVE_ORGANIZATION",
        "Selecione uma empresa para continuar.",
      );
    const asserted = request.headers.get("x-active-org");
    if (asserted !== null && asserted !== state.activeSlug)
      return error(
        409,
        "ACTIVE_ORG_CHANGED",
        "A empresa ativa mudou em outra aba. Recarregue a página.",
      );
    return null;
  };

  return [
    route("get", "/api/me", () =>
      state.user ? HttpResponse.json({ user: state.user }) : unauthorized(),
    ),
    route("post", "/api/auth/login", ({ body }) => {
      const account = state.accounts.find(
        (a) => a.email === body.email && a.password === body.password,
      );
      if (!account)
        return error(401, "INVALID_CREDENTIALS", "E-mail ou senha incorretos.");
      state.user = account.user;
      return HttpResponse.json({ user: account.user });
    }),
    route("post", "/api/auth/logout", () => {
      state.user = null;
      state.activeSlug = null;
      return new HttpResponse(null, { status: 204 });
    }),
    route("post", "/api/auth/register", ({ body }) => {
      if (typeof body.password !== "string" || body.password.length < 10)
        return error(400, "VALIDATION_ERROR", "Dados inválidos.", {
          details: [
            {
              path: "password",
              message: "A senha deve ter pelo menos 10 caracteres.",
            },
          ],
        });
      return HttpResponse.json(
        {
          message:
            "Cadastro recebido. Use seu e-mail e senha para entrar. Se já houver uma conta com este e-mail, nada foi alterado.",
        },
        { status: 202 },
      );
    }),
    route("post", "/api/auth/verify-email", ({ body }) => {
      if (body.token !== state.validVerifyToken)
        return error(
          400,
          "TOKEN_INVALID_OR_EXPIRED",
          "Link inválido, expirado ou já utilizado.",
        );
      state.validVerifyToken = "";
      if (state.user) state.user = { ...state.user, emailVerified: true };
      return new HttpResponse(null, { status: 204 });
    }),
    route("post", "/api/auth/resend-verification", () => {
      if (!state.user) return unauthorized();
      return HttpResponse.json(
        {
          message:
            "Se a confirmação de e-mail ainda for necessária, enviaremos um novo link.",
        },
        { status: 202 },
      );
    }),
    route("post", "/api/auth/forgot-password", () =>
      HttpResponse.json(
        {
          message:
            "Se o e-mail estiver cadastrado, enviaremos as instruções para redefinir a senha.",
        },
        { status: 202 },
      ),
    ),
    route("post", "/api/auth/reset-password", ({ body }) => {
      if (body.token !== state.validResetToken)
        return error(
          400,
          "TOKEN_INVALID_OR_EXPIRED",
          "Link inválido, expirado ou já utilizado.",
        );
      return new HttpResponse(null, { status: 204 });
    }),
    route("get", "/api/organizations", () => {
      if (!state.user) return unauthorized();
      return HttpResponse.json({
        organizations: state.organizations,
        activeSlug: state.activeSlug,
      });
    }),
    route("post", "/api/organizations", ({ body }) => {
      if (!state.user) return unauthorized();
      if (!state.user.emailVerified)
        return error(
          403,
          "EMAIL_NOT_VERIFIED",
          "Confirme seu e-mail antes de criar uma empresa.",
        );
      if (state.organizations.some((o) => o.slug === body.slug))
        return error(
          409,
          "SLUG_UNAVAILABLE",
          "Este endereço já está em uso. Escolha outro.",
        );
      const org = {
        ...makeOrg(body.slug ?? "", body.name),
        timezone: body.timezone ?? "UTC",
      };
      state.organizations.push(org);
      state.activeSlug = org.slug;
      return HttpResponse.json({ organization: org }, { status: 201 });
    }),
    route("post", "/api/session/active-organization", ({ body }) => {
      if (!state.user) return unauthorized();
      const org = state.organizations.find((o) => o.slug === body.slug);
      if (!org) return error(404, "NOT_FOUND", "Recurso não encontrado.");
      state.activeSlug = org.slug;
      return HttpResponse.json({ organization: org });
    }),
    route("get", "/api/organization", ({ request }) => {
      const denied = tenant(request);
      if (denied) return denied;
      const org = state.organizations.find((o) => o.slug === state.activeSlug)!;
      return HttpResponse.json({ organization: org });
    }),
  ];
}
