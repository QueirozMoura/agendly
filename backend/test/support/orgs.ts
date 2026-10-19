import type { LightMyRequestResponse } from "fastify";
import {
  ORIGIN,
  PASSWORD,
  cookieHeader,
  latestToken,
  post,
  registerAndLogin,
  type AuthTestApp,
} from "./auth-app.ts";

export interface TestUser {
  email: string;
  cookie: string;
  userId: string;
}

/** Cadastra, faz login e VERIFICA o e-mail pelo fluxo real (token da outbox). */
export async function signupVerified(
  t: AuthTestApp,
  email: string,
): Promise<TestUser> {
  const { cookie } = await registerAndLogin(t, email);
  const res = await post(t, "/api/auth/verify-email", {
    token: await latestToken(t, "VERIFY_EMAIL", email),
  });
  if (res.statusCode !== 204)
    throw new Error(`verificação falhou: ${res.statusCode}`);
  const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
  return { email, cookie, userId: user.id };
}

/** Cadastra e faz login SEM verificar o e-mail. */
export async function signupUnverified(
  t: AuthTestApp,
  email: string,
): Promise<TestUser> {
  const { cookie } = await registerAndLogin(t, email);
  const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
  return { email, cookie, userId: user.id };
}

export const orgInput = (
  slug: string,
  extra: Record<string, unknown> = {},
) => ({
  name: `Empresa ${slug}`,
  slug,
  timezone: "America/Sao_Paulo",
  ...extra,
});

type Headers = Record<string, string>;

export function api(
  t: AuthTestApp,
  method: "GET" | "POST" | "PATCH",
  url: string,
  user: { cookie: string } | undefined,
  body?: unknown,
  headers: Headers = {},
): Promise<LightMyRequestResponse> {
  const h: Headers = { ...headers };
  if (user) h.cookie = user.cookie;
  if (method !== "GET") {
    h.origin = ORIGIN;
    h["content-type"] = "application/json";
  }
  return t.app.inject({
    method,
    url,
    headers: h,
    ...(method === "GET"
      ? {}
      : {
          payload: typeof body === "string" ? body : JSON.stringify(body ?? {}),
        }),
  });
}

export const createOrg = (
  t: AuthTestApp,
  user: { cookie: string },
  slug: string,
  extra: Record<string, unknown> = {},
) => api(t, "POST", "/api/organizations", user, orgInput(slug, extra));

/** Faz um novo login do mesmo usuário (sessão nova, sem empresa ativa). */
export async function freshSession(
  t: AuthTestApp,
  email: string,
): Promise<{ cookie: string }> {
  const res = await post(t, "/api/auth/login", { email, password: PASSWORD });
  return { cookie: cookieHeader(res) };
}
