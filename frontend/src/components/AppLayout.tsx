import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { ApiError, messageOf } from "../api/client";
import { useApi } from "../api/ApiContext";
import { useAuth } from "../features/auth/AuthContext";
import { useOrganizations } from "../features/organizations/OrganizationContext";
import { Alert } from "./ui";

/** Casca das telas autenticadas: cabeçalho com empresa ativa, troca de empresa, aviso de e-mail e saída. */
export function AppLayout() {
  const api = useApi();
  const { user, logout } = useAuth();
  const orgs = useOrganizations();
  const navigate = useNavigate();
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function resend() {
    setResendMessage(null);
    setResendError(null);
    setResending(true);
    try {
      const res = await api.request<{ message: string }>(
        "POST",
        "/api/auth/resend-verification",
      );
      setResendMessage(res.message);
    } catch (err) {
      if (!(err instanceof ApiError && err.handled))
        setResendError(messageOf(err));
    } finally {
      setResending(false);
    }
  }

  async function switchTo(slug: string) {
    setSwitchError(null);
    try {
      await orgs.select(slug);
      navigate("/", { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError && err.handled))
        setSwitchError(messageOf(err));
    }
  }

  async function signOut() {
    await logout();
    navigate("/entrar", { replace: true });
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Agendly
        </Link>
        {orgs.activeSlug !== null && (
          <nav aria-label="Principal" className="mainnav">
            <NavLink to="/" end>
              Início
            </NavLink>
            <NavLink to="/servicos">Serviços</NavLink>
            <NavLink to="/profissionais">Profissionais</NavLink>
          </nav>
        )}
        <div className="topbar-actions">
          {orgs.organizations.length > 0 && (
            <label className="inline-label">
              <span className="visually-hidden">Empresa ativa</span>
              <select
                aria-label="Empresa ativa"
                value={orgs.activeSlug ?? ""}
                onChange={(e) => void switchTo(e.target.value)}
              >
                {orgs.activeSlug === null && (
                  <option value="">Escolha uma empresa</option>
                )}
                {orgs.organizations.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Link to="/empresas">Empresas</Link>
          <span className="user">{user?.name}</span>
          <button
            type="button"
            className="button"
            onClick={() => void signOut()}
          >
            Sair
          </button>
        </div>
      </header>
      <main className="content">
        {switchError && <Alert kind="error">{switchError}</Alert>}
        {user && !user.emailVerified && (
          <Alert kind="info">
            Confirme seu e-mail para criar empresas e publicar sua página.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void resend()}
              disabled={resending}
            >
              Reenviar e-mail de confirmação
            </button>
            {resendMessage && <span> {resendMessage}</span>}
            {resendError && <span> {resendError}</span>}
          </Alert>
        )}
        <Outlet />
      </main>
    </div>
  );
}
