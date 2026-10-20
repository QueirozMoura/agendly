// Empresas do usuário e empresa ativa. A empresa ativa é da SESSÃO (4.1): o servidor é a fonte da verdade e este
// estado só a espelha (por slug). O slug exibido segue em `X-Active-Org` como asserção entre abas.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError, messageOf } from "../../api/client";
import type { ApiOrganization, OrganizationsResponse } from "../../api/types";
import { useAuth } from "../auth/AuthContext";

/** `error`: a lista NÃO pôde ser obtida (rede, 5xx). Diferente de `ready` com lista vazia, que é um fato confirmado pelo servidor. */
export type OrganizationStatus = "idle" | "loading" | "ready" | "error";

export interface OrganizationContextValue {
  status: OrganizationStatus;
  organizations: ApiOrganization[];
  activeSlug: string | null;
  active: ApiOrganization | null;
  /** Mensagem pt-BR da última falha ao listar (só com `status === "error"`). */
  loadError: string | null;
  /** Relê as empresas; falhas viram `status: "error"` (não lançam). */
  refresh: () => Promise<void>;
  /** "Tentar novamente" depois de uma falha: volta a `loading` e relê. */
  retry: () => Promise<void>;
  select: (slug: string) => Promise<void>;
  create: (input: {
    name: string;
    slug: string;
    timezone: string;
  }) => Promise<ApiOrganization>;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(
  null,
);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user, status: authStatus } = useAuth();
  const userId = user?.id ?? null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<ApiOrganization[]>([]);
  const [activeSlug, setActiveSlugState] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const setActive = useCallback(
    (slug: string | null) => {
      setActiveSlugState(slug);
      api.setActiveOrg(slug);
    },
    [api],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await api.request<OrganizationsResponse>(
        "GET",
        "/api/organizations",
      );
      setOrganizations(res.organizations);
      setActive(res.activeSlug);
      setLoadError(null);
    } catch (err) {
      // 401 já foi tratado centralmente (a sessão acabou); qualquer outra falha NÃO prova que a lista está vazia.
      if (!(err instanceof ApiError && err.handled))
        setLoadError(messageOf(err));
    }
    setLoadedFor(userId);
  }, [api, setActive, userId]);

  const retry = useCallback(async () => {
    setLoadError(null);
    setLoadedFor(null); // volta ao estado de carregamento
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !userId) {
      setOrganizations([]);
      setActive(null);
      setLoadedFor(null);
      setLoadError(null);
      return;
    }
    void refresh();
  }, [authStatus, userId, refresh, setActive]);

  const select = useCallback(
    async (slug: string) => {
      const res = await api.request<{ organization: ApiOrganization }>(
        "POST",
        "/api/session/active-organization",
        { body: { slug } },
      );
      setActive(res.organization.slug);
    },
    [api, setActive],
  );

  const create = useCallback(
    async (input: { name: string; slug: string; timezone: string }) => {
      const res = await api.request<{ organization: ApiOrganization }>(
        "POST",
        "/api/organizations",
        { body: input },
      );
      // Criar uma empresa a torna a ativa da sessão (4.1).
      setOrganizations((list) => [...list, res.organization]);
      setActive(res.organization.slug);
      return res.organization;
    },
    [api, setActive],
  );

  const status: OrganizationStatus = !userId
    ? "idle"
    : loadedFor !== userId
      ? "loading"
      : loadError !== null
        ? "error"
        : "ready";
  const active = organizations.find((o) => o.slug === activeSlug) ?? null;

  const value = useMemo<OrganizationContextValue>(
    () => ({
      status,
      organizations,
      activeSlug,
      active,
      loadError,
      refresh,
      retry,
      select,
      create,
    }),
    [
      status,
      organizations,
      activeSlug,
      active,
      loadError,
      refresh,
      retry,
      select,
      create,
    ],
  );
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganizations(): OrganizationContextValue {
  const ctx = useContext(OrganizationContext);
  if (!ctx) throw new Error("useOrganizations fora do OrganizationProvider");
  return ctx;
}
