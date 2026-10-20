import type { ZodError } from "zod";
import { ApiError } from "../api/client";

export type FieldErrors = Record<string, string>;

/** Primeiro erro de cada campo de um ZodError (validação de conveniência no cliente; o servidor é quem decide). */
export function fieldErrorsFromZod(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    out[key] ??= issue.message;
  }
  return out;
}

/** `400 VALIDATION_ERROR` do servidor traz `details: [{ path, message }]`: mapeia para os campos do formulário. */
export function fieldErrorsFromApi(err: unknown): FieldErrors {
  if (!(err instanceof ApiError) || err.code !== "VALIDATION_ERROR") return {};
  const out: FieldErrors = {};
  if (Array.isArray(err.details)) {
    for (const d of err.details as Array<{
      path?: unknown;
      message?: unknown;
    }>) {
      if (typeof d.path === "string" && typeof d.message === "string") {
        out[d.path.split(".")[0] ?? "_"] ??= d.message;
        // Campo aninhado ("customer.phone"): também disponível pelo caminho completo.
        if (d.path.includes(".")) out[d.path] ??= d.message;
      }
    }
  }
  return out;
}
