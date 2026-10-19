import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { classifyDbError } from "../lib/db/errors.ts";
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

      // lock_timeout (55P03), deadlock (40P01) e timeout da transação interativa (P2028 de expiração ou de espera por
      // conexão): a transação já sofreu rollback, nada foi gravado (6.5, L10). Os demais P2028 seguem como erro interno.
      const dbKind = classifyDbError(error);
      if (
        dbKind === "lock_timeout" ||
        dbKind === "deadlock" ||
        dbKind === "transaction_timeout"
      ) {
        if (dbKind === "deadlock")
          request.log.error(
            { err: error },
            "deadlock (40P01): erro de implementação, a ordem de locks foi violada em algum ponto",
          );
        else
          request.log.warn(
            { err: error },
            dbKind === "lock_timeout"
              ? "lock_timeout (55P03)"
              : "timeout de transação (P2028)",
          );
        return reply
          .status(503)
          .header("retry-after", "1")
          .send(
            body(
              requestId,
              "TEMPORARILY_BUSY",
              "O sistema está ocupado. Tente novamente em instantes.",
            ),
          );
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
