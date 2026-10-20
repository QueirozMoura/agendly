// Estado de autenticação do SPA. A sessão vive num cookie HttpOnly: aqui só há o usuário em memória, obtido de
// `GET /api/me`. Nada é persistido no navegador (nenhum token em localStorage/sessionStorage).
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
import type { ApiUser, MessageResponse } from "../../api/types";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: ApiUser | null;
  /** true quando uma sessão que existia foi encerrada pelo servidor (401 central): a tela de login avisa. */
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<string>;
  logout: () => Promise<void>;
  /** Relê o usuário (ex.: depois de confirmar o e-mail). */
  refresh: () => Promise<void>;
  /** Marca a sessão como encerrada pelo servidor (tratador central de 401). */
  expireSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<ApiUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.request<{ user: ApiUser }>("GET", "/api/me", {
        anonymous: true, // 401 aqui é só "não há sessão", não "sessão expirada"
      });
      setUser(res.user);
      setStatus("authenticated");
    } catch {
      // 401 = sem sessão; erro de rede ou 5xx na consulta inicial também cai em "anônimo" (o login mostra o erro real)
      setUser(null);
      setStatus("anonymous");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const expireSession = useCallback(() => {
    setUser((current) => {
      if (current) setSessionExpired(true);
      return null;
    });
    setStatus("anonymous");
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.request<{ user: ApiUser }>(
        "POST",
        "/api/auth/login",
        {
          body: { email, password },
          anonymous: true,
        },
      );
      setSessionExpired(false);
      setUser(res.user);
      setStatus("authenticated");
    },
    [api],
  );

  const register = useCallback(
    async (input: { name: string; email: string; password: string }) => {
      const res = await api.request<MessageResponse>(
        "POST",
        "/api/auth/register",
        {
          body: input,
          anonymous: true,
        },
      );
      return res.message;
    },
    [api],
  );

  const logout = useCallback(async () => {
    try {
      await api.request("POST", "/api/auth/logout", { anonymous: true });
    } finally {
      // O servidor é idempotente e sempre limpa o cookie; localmente o usuário sai de qualquer forma.
      setSessionExpired(false);
      setUser(null);
      setStatus("anonymous");
    }
  }, [api]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionExpired,
      login,
      register,
      logout,
      refresh: load,
      expireSession,
    }),
    [
      status,
      user,
      sessionExpired,
      login,
      register,
      logout,
      load,
      expireSession,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth fora do AuthProvider");
  return ctx;
}
