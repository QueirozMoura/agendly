import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import { SESSION_ABSOLUTE_MS } from "./session.ts";

// Em produção o prefixo __Host- exige Secure, Path=/ e ausência de Domain (o navegador impõe).
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-agendly_session" : "agendly_session";
}

function baseOptions(secure: boolean): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/" };
}

export function setSessionCookie(
  reply: FastifyReply,
  secure: boolean,
  token: string,
): void {
  reply.setCookie(sessionCookieName(secure), token, {
    ...baseOptions(secure),
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(sessionCookieName(secure), baseOptions(secure));
}
