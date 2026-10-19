import type { FastifyInstance } from "fastify";
import { AppError } from "../lib/errors.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Proteção CSRF (3.1): SameSite=Lax no cookie + Origin obrigatório e permitido + Content-Type JSON
 * em todo método que altera estado. Corpos vazios também precisam do Content-Type (o cliente envia `{}`).
 * Registrar ANTES das rotas: o hook vale para tudo o que for registrado depois.
 */
export function registerCsrfProtection(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): void {
  const allowed = new Set(allowedOrigins);
  app.addHook("onRequest", async (request) => {
    if (SAFE_METHODS.has(request.method)) return;

    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) {
      throw new AppError(
        "FORBIDDEN_ORIGIN",
        403,
        "Origem da requisição não permitida.",
      );
    }

    const mediaType = request.headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new AppError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "O tipo de conteúdo deve ser application/json.",
      );
    }
  });
}
