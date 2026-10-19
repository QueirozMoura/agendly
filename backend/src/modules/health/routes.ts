import type { FastifyInstance } from "fastify";
import { AppError } from "../../lib/errors.ts";

export interface HealthDeps {
  checkDatabase: () => Promise<void>;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps,
): void {
  // Liveness: o processo responde.
  app.get("/api/health", { config: { access: "none" } }, async () => ({
    status: "ok",
  }));

  // Readiness: o banco responde.
  app.get("/api/ready", { config: { access: "none" } }, async (request) => {
    try {
      await deps.checkDatabase();
    } catch (err) {
      request.log.error({ err }, "readiness check failed");
      throw new AppError("NOT_READY", 503, "Serviço indisponível.");
    }
    return { status: "ready" };
  });
}
