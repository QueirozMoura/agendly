import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../features/auth/AuthContext";
import { safeInternalPath } from "../features/auth/redirect";
import { useOrganizations } from "../features/organizations/OrganizationContext";
import { LoadError } from "./LoadError";
import { Loading } from "./ui";

/** Só usuários autenticados passam; os demais vão para o login e voltam depois (`from`). */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Loading />;
  if (status === "anonymous")
    return (
      <Navigate
        to="/entrar"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  return <Outlet />;
}

/** Telas que exigem empresa ativa: sem ela, o usuário escolhe uma em /empresas. */
export function RequireOrganization() {
  const orgs = useOrganizations();
  if (orgs.status === "loading") return <Loading />;
  // Sem confirmação do servidor não dá para saber se há empresa ativa: não redireciona nem esconde o erro.
  if (orgs.status === "error")
    return (
      <LoadError message={orgs.loadError} onRetry={() => void orgs.retry()} />
    );
  if (orgs.activeSlug === null) return <Navigate to="/empresas" replace />;
  return <Outlet />;
}

/**
 * Login/cadastro/recuperação não fazem sentido com sessão ativa. O destino é o mesmo `from` que a tela de login usaria
 * (já validado por `safeInternalPath`): sem isso, esta guarda levaria sempre a "/" assim que o login conclui e
 * atropelaria o retorno à página que o usuário tentava abrir.
 */
export function PublicOnly() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Loading />;
  if (status === "authenticated")
    return (
      <Navigate
        to={safeInternalPath(
          (location.state as { from?: unknown } | null)?.from,
        )}
        replace
      />
    );
  return <Outlet />;
}
