import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ApiError, messageOf } from "../api/client";
import { useApi } from "../api/ApiContext";
import { useAuth } from "../features/auth/AuthContext";
import { useOrganizations } from "../features/organizations/OrganizationContext";
import {
  BrandMark,
  BuildingIcon,
  CalendarIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  PeopleIcon,
  ServicesIcon,
} from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { Alert } from "./ui";

// Na gaveta (telas estreitas) o botão de recolher não existe (`display: none`): fora da lista do foco circular.
const FOCUSABLE =
  "a[href], button:not([disabled]):not([data-desktop-only]), select:not([disabled])";

/** Itens da navegação principal (só com empresa ativa), em grupos. Rotas e nomes são os de sempre. */
const GROUPS = [
  {
    label: "Operação",
    items: [
      { to: "/", label: "Início", icon: <HomeIcon />, end: true },
      { to: "/agenda", label: "Agenda", icon: <CalendarIcon /> },
    ],
  },
  {
    label: "Cadastros",
    items: [
      { to: "/servicos", label: "Serviços", icon: <ServicesIcon /> },
      { to: "/profissionais", label: "Profissionais", icon: <PeopleIcon /> },
    ],
  },
] as const;

/**
 * Casca das telas autenticadas: barra lateral (navegação, empresa ativa, conta), aviso de e-mail e conteúdo.
 * Desktop: lateral fixa, que pode ser recolhida (estado só em memória: o app não usa armazenamento do navegador).
 * Celular/tablet estreito: a lateral vira gaveta (botão na barra superior, Esc, fundo e navegação a fecham).
 */
export function AppLayout() {
  const api = useApi();
  const { user, logout } = useAuth();
  const orgs = useOrganizations();
  const navigate = useNavigate();
  const location = useLocation();
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  // Trocar de página fecha a gaveta (o foco já vai para o conteúdo novo).
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    closeButton.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawerOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function closeDrawer() {
    setDrawerOpen(false);
    menuButton.current?.focus();
  }

  // Com a gaveta aberta o Tab circula dentro dela.
  function trapTab(e: KeyboardEvent<HTMLElement>) {
    if (!drawerOpen || e.key !== "Tab" || !sidebar.current) return;
    const items = [...sidebar.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

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

  const activeName = orgs.active?.name ?? null;
  const tip = (label: string) => (collapsed ? label : undefined);

  return (
    <div
      className={`app-shell${collapsed ? " is-collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}
    >
      <div className="mobile-bar">
        <button
          type="button"
          ref={menuButton}
          className="icon-button"
          aria-label="Abrir menu"
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon />
        </button>
        <span className="mobile-title" aria-hidden="true">
          <BrandMark /> Agendly
        </span>
      </div>

      <aside
        id="app-sidebar"
        ref={sidebar}
        className="sidebar"
        aria-label="Menu lateral"
        onKeyDown={trapTab}
      >
        <div className="sidebar-head">
          <Link to="/" className="brand" title={tip("Agendly")}>
            <BrandMark />
            <span className="nav-label">Agendly</span>
          </Link>
          <button
            type="button"
            ref={closeButton}
            className="icon-button drawer-close"
            aria-label="Fechar menu"
            onClick={closeDrawer}
          >
            <CloseIcon />
          </button>
        </div>

        {orgs.organizations.length > 0 &&
          (collapsed ? (
            <Link
              to="/empresas"
              className="org-chip"
              aria-label={`Empresa ativa: ${activeName ?? "nenhuma"}`}
              title={activeName ?? "Escolher empresa"}
            >
              {(activeName ?? "?").slice(0, 1).toUpperCase()}
            </Link>
          ) : (
            <label className="org-switch">
              <span className="org-switch-label">Empresa ativa</span>
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
          ))}

        <div className="sidebar-scroll">
          {orgs.activeSlug !== null && (
            <nav aria-label="Principal" className="nav">
              {GROUPS.map((group) => (
                <div key={group.label} className="nav-group">
                  <p className="nav-group-label">{group.label}</p>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={"end" in item ? item.end : false}
                      className="nav-item"
                      title={tip(item.label)}
                    >
                      {item.icon}
                      <span className="nav-label">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
          )}
          <nav aria-label="Conta e empresas" className="nav">
            <div className="nav-group">
              <p className="nav-group-label">Conta</p>
              <NavLink
                to="/empresas"
                className="nav-item"
                title={tip("Empresas")}
              >
                <BuildingIcon />
                <span className="nav-label">Empresas</span>
              </NavLink>
            </div>
          </nav>
        </div>

        <div className="sidebar-foot">
          <div className="user-row">
            <span className="avatar" aria-hidden="true">
              {(user?.name ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="user nav-label">{user?.name}</span>
          </div>
          <ThemeToggle variant="nav" />
          <button
            type="button"
            className="nav-item nav-button"
            aria-label="Sair"
            title={tip("Sair")}
            onClick={() => void signOut()}
          >
            <LogoutIcon />
            <span className="nav-label" aria-hidden="true">
              Sair
            </span>
          </button>
          <button
            type="button"
            className="nav-item nav-button collapse-toggle"
            data-desktop-only
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            title={tip("Expandir menu")}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <ExpandIcon /> : <CollapseIcon />}
            <span className="nav-label" aria-hidden="true">
              Recolher
            </span>
          </button>
        </div>
      </aside>

      <button
        type="button"
        className="drawer-overlay"
        aria-hidden="true"
        tabIndex={-1}
        onClick={closeDrawer}
      />

      <main className="app-content">
        {switchError && <Alert kind="error">{switchError}</Alert>}
        {user && !user.emailVerified && (
          <Alert kind="info">
            {user.emailVerificationRequired
              ? "Confirme seu e-mail para criar empresas."
              : "Seu e-mail ainda não foi confirmado. Neste ambiente de desenvolvimento a confirmação não é exigida."}{" "}
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
