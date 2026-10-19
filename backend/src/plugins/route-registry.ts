import type { FastifyInstance } from "fastify";

/**
 * Classificação obrigatória de cada rota (4.4, item 4):
 * - `tenant`: escopada pela empresa ativa da sessão; exige teste A×B;
 * - `auth`: autenticação/conta (com ou sem sessão), sem escopo de empresa;
 * - `public`: página pública de agendamento (resolvida por slug; ainda não existe);
 * - `none`: infraestrutura (health/ready).
 */
export type RouteAccess = "tenant" | "auth" | "public" | "none";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
    /** Ação de `can()` exigida (rotas `tenant`). */
    action?: string;
  }
  interface FastifyInstance {
    routeRegistry: readonly RegisteredRoute[];
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  access: RouteAccess | undefined;
  action: string | undefined;
}

/** Registra todas as rotas declaradas DEPOIS desta chamada. Chamar antes de registrar qualquer rota. */
export function installRouteRegistry(app: FastifyInstance): void {
  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routes.push({
        method,
        url: route.url,
        access: route.config?.access,
        action: route.config?.action,
      });
    }
  });
  app.decorate("routeRegistry", routes);
}
