import { useEffect, useMemo, type ReactNode } from "react";
import { ApiProvider, useApi } from "./api/ApiContext";
import { ApiClient } from "./api/client";
import { AuthProvider, useAuth } from "./features/auth/AuthContext";
import {
  OrganizationProvider,
  useOrganizations,
} from "./features/organizations/OrganizationContext";
import { AppRoutes } from "./routes/AppRoutes";

/**
 * Tratamento CENTRAL das respostas que afetam o app inteiro (seção 7): 401 ⇒ volta ao login; 409 ACTIVE_ORG_CHANGED ⇒
 * recarrega o app; 403 sem empresa ativa ⇒ relê as empresas (e o guarda leva a /empresas).
 */
function CentralErrorHandling({
  onReload,
  children,
}: {
  onReload: () => void;
  children: ReactNode;
}) {
  const api = useApi();
  const auth = useAuth();
  const orgs = useOrganizations();
  const { expireSession } = auth;
  const { refresh } = orgs;
  useEffect(() => {
    api.setEvents({
      onUnauthorized: expireSession,
      onActiveOrgChanged: onReload,
      onOrganizationRequired: () => {
        void refresh().catch(() => undefined);
      },
    });
  }, [api, expireSession, onReload, refresh]);
  return <>{children}</>;
}

export interface AppProps {
  /** Injetável nos testes; o padrão recarrega a página. */
  onReload?: () => void;
  client?: ApiClient;
}

const reloadPage = () => window.location.reload();

export function App({ onReload = reloadPage, client }: AppProps) {
  const api = useMemo(() => client ?? new ApiClient(), [client]);
  return (
    <ApiProvider client={api}>
      <AuthProvider>
        <OrganizationProvider>
          <CentralErrorHandling onReload={onReload}>
            <AppRoutes />
          </CentralErrorHandling>
        </OrganizationProvider>
      </AuthProvider>
    </ApiProvider>
  );
}
