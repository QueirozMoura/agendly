import { useEffect, useState } from "react";
import { ApiError, messageOf } from "../api/client";
import { useApi } from "../api/ApiContext";
import type { ApiOrganization } from "../api/types";
import { Link } from "react-router";
import { CalendarIcon, PeopleIcon, ServicesIcon } from "../components/icons";
import { Alert, Loading } from "../components/ui";
import { useOrganizations } from "../features/organizations/OrganizationContext";

/**
 * Início do painel. Lê a empresa ativa pela rota `tenant` (`GET /api/organization`): o servidor valida sessão,
 * membership e o `X-Active-Org` enviado pelo cliente, e os tratadores centrais cuidam de 401/403/409.
 */
export function HomePage() {
  const api = useApi();
  const { activeSlug } = useOrganizations();
  const [org, setOrg] = useState<ApiOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOrg(null);
    setError(null);
    api
      .request<{ organization: ApiOrganization }>("GET", "/api/organization", {
        signal: controller.signal,
      })
      .then((res) => setOrg(res.organization))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (!(err instanceof ApiError && err.handled)) setError(messageOf(err));
      });
    return () => controller.abort();
  }, [api, activeSlug]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!org) return <Loading />;
  return (
    <section className="page">
      <div className="hero-card">
        <span className="avatar" aria-hidden="true">
          {org.name.slice(0, 1).toUpperCase()}
        </span>
        <h1>{org.name}</h1>
      </div>
      <nav className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/agenda" aria-label="Abrir agenda">
          <span className="tile">
            <CalendarIcon />
          </span>
          Agenda
        </Link>
        <Link className="quick-link" to="/servicos" aria-label="Abrir serviços">
          <span className="tile">
            <ServicesIcon />
          </span>
          Serviços
        </Link>
        <Link
          className="quick-link"
          to="/profissionais"
          aria-label="Abrir profissionais"
        >
          <span className="tile">
            <PeopleIcon />
          </span>
          Profissionais
        </Link>
      </nav>
      <dl className="summary">
        <dt>Endereço</dt>
        <dd>{org.slug}</dd>
        <dt>Fuso horário</dt>
        <dd>{org.timezone}</dd>
      </dl>
      <p className="muted">Ainda não há nada para mostrar aqui.</p>
    </section>
  );
}
