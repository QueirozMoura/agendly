import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.ts";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

function body(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId,
    },
  };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(body(request.id, "NOT_FOUND", "Recurso não encontrado."));
  });

  app.setErrorHandler(
    (error: FastifyError | AppError | ZodError, request, reply) => {
      const requestId = request.id;

      if (error instanceof AppError) {
        return reply
          .status(error.httpStatus)
          .send(body(requestId, error.code, error.message, error.details));
      }
      if (error instanceof ZodError) {
        const details = error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        }));
        return reply
          .status(400)
          .send(
            body(requestId, "VALIDATION_ERROR", "Dados inválidos.", details),
          );
      }
      // Erros do próprio Fastify (JSON malformado, corpo grande demais etc.) trazem statusCode 4xx.
      const status = "statusCode" in error ? error.statusCode : undefined;
      if (status && status >= 400 && status < 500) {
        return reply
          .status(status)
          .send(body(requestId, "BAD_REQUEST", "Requisição inválida."));
      }

      request.log.error({ err: error }, "unhandled error");
      return reply
        .status(500)
        .send(
          body(
            requestId,
            "INTERNAL_ERROR",
            "Erro interno. Tente novamente mais tarde.",
          ),
        );
    },
  );
}
