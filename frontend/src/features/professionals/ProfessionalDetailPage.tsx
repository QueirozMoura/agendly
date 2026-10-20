import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../../api/ApiContext";
import type { ApiProfessional, ApiService } from "../../api/types";
import { LoadError } from "../../components/LoadError";
import { Alert, Field, Loading, SubmitButton } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import { useResource } from "../../hooks/useResource";
import { useOrganizations } from "../organizations/OrganizationContext";
import { TimeOffSection } from "../availability/TimeOffSection";
import { WorkingHoursSection } from "../availability/WorkingHoursSection";

export function ProfessionalDetailPage() {
  const api = useApi();
  const { id = "" } = useParams();
  const { active } = useOrganizations();
  const { resource, reload } = useResource(
    async (signal) => {
      const [p, s] = await Promise.all([
        api.request<{ professional: ApiProfessional }>(
          "GET",
          `/api/professionals/${encodeURIComponent(id)}`,
          { signal },
        ),
        api.request<{ services: ApiService[] }>("GET", "/api/services", {
          signal,
        }),
      ]);
      return { professional: p.professional, services: s.services };
    },
    [api, id],
  );

  if (resource.status === "loading") return <Loading />;
  if (resource.status === "error")
    return (
      <>
        <LoadError message={resource.message} onRetry={reload} />
        <p className="page">
          <Link to="/profissionais">Voltar aos profissionais</Link>
        </p>
      </>
    );
  const { professional, services } = resource.data;
  // A timezone vem da empresa ativa já validada pelo servidor (imutável, R9), nunca de entrada do usuário.
  const timeZone = active?.timezone ?? "America/Sao_Paulo";

  return (
    <section className="page">
      <p>
        <Link to="/profissionais">← Profissionais</Link>
      </p>
      <h1>{professional.name}</h1>
      <Basics professional={professional} onSaved={reload} />
      <ServiceLinks
        professional={professional}
        services={services}
        onSaved={reload}
      />
      <WorkingHoursSection professionalId={professional.id} />
      <TimeOffSection professionalId={professional.id} timeZone={timeZone} />
    </section>
  );
}

function Basics({
  professional,
  onSaved,
}: {
  professional: ApiProfessional;
  onSaved: () => void;
}) {
  const api = useApi();
  const save = useAction();
  const [name, setName] = useState(professional.name);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function rename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return setLocalError("Informe o nome do profissional.");
    setLocalError(null);
    setNotice(null);
    const res = await save.run(() =>
      api.request("PATCH", `/api/professionals/${professional.id}`, {
        body: { name: trimmed },
      }),
    );
    if (res.ok) {
      setNotice("Nome atualizado.");
      onSaved();
    }
  }

  async function toggleActive() {
    setNotice(null);
    const next = !professional.active;
    const res = await save.run(() =>
      api.request("PATCH", `/api/professionals/${professional.id}`, {
        body: { active: next },
      }),
    );
    if (res.ok) {
      setNotice(
        next
          ? "Profissional ativado."
          : "Profissional desativado. Agendamentos já existentes permanecem.",
      );
      onSaved();
    }
  }

  return (
    <form
      className="panel"
      onSubmit={rename}
      noValidate
      aria-label="Dados do profissional"
    >
      <h2>Dados</h2>
      {save.error && <Alert kind="error">{save.error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <Field
        id="pro-edit-name"
        label="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={localError ?? save.fieldErrors.name}
      />
      <div className="form-actions">
        <SubmitButton pending={save.pending} pendingText="Salvando…">
          Salvar nome
        </SubmitButton>
        <button
          type="button"
          className="button"
          disabled={save.pending}
          onClick={() => void toggleActive()}
        >
          {professional.active
            ? "Desativar profissional"
            : "Ativar profissional"}
        </button>
        <span className="muted">
          Situação: {professional.active ? "ativo" : "inativo"}
        </span>
      </div>
    </form>
  );
}

function ServiceLinks({
  professional,
  services,
  onSaved,
}: {
  professional: ApiProfessional;
  services: ApiService[];
  onSaved: () => void;
}) {
  const api = useApi();
  const save = useAction();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(professional.serviceIds),
  );
  const [notice, setNotice] = useState<string | null>(null);

  function toggle(id: string) {
    setNotice(null);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    // O PUT substitui o conjunto COMPLETO de vínculos; a ordem é irrelevante.
    const res = await save.run(() =>
      api.request("PUT", `/api/professionals/${professional.id}/services`, {
        body: { serviceIds: [...selected] },
      }),
    );
    if (res.ok) {
      setNotice("Serviços atualizados.");
      onSaved();
    }
  }

  return (
    <form
      className="panel"
      onSubmit={submit}
      aria-label="Serviços do profissional"
    >
      <h2>Serviços que realiza</h2>
      {save.error && <Alert kind="error">{save.error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {services.length === 0 ? (
        <p className="empty">
          Ainda não há serviços. <Link to="/servicos">Cadastre um serviço</Link>{" "}
          para poder vinculá-lo.
        </p>
      ) : (
        <fieldset>
          <legend className="visually-hidden">Serviços vinculados</legend>
          {services.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <span>
                {s.name}
                {!s.active && <span className="badge">Inativo</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {services.length > 0 && (
        <SubmitButton pending={save.pending} pendingText="Salvando…">
          Salvar serviços
        </SubmitButton>
      )}
    </form>
  );
}
