import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useApi } from "../../api/ApiContext";
import type { ApiProfessional } from "../../api/types";
import { LoadError } from "../../components/LoadError";
import { Alert, Field, Loading, SubmitButton } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import { useResource } from "../../hooks/useResource";

export function ProfessionalsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { resource, reload } = useResource(
    async (signal) =>
      (
        await api.request<{ professionals: ApiProfessional[] }>(
          "GET",
          "/api/professionals",
          { signal },
        )
      ).professionals,
    [api],
  );
  const create = useAction();
  const [name, setName] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  if (resource.status === "loading") return <Loading />;
  if (resource.status === "error")
    return <LoadError message={resource.message} onRetry={reload} />;
  const professionals = resource.data;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return setLocalError("Informe o nome do profissional.");
    if (trimmed.length > 100) return setLocalError("Nome muito longo.");
    setLocalError(null);
    const res = await create.run(() =>
      api.request<{ professional: ApiProfessional }>(
        "POST",
        "/api/professionals",
        { body: { name: trimmed } },
      ),
    );
    if (res.ok) navigate(`/profissionais/${res.value.professional.id}`);
  }

  return (
    <section className="page">
      <h1>Profissionais</h1>
      <p className="page-sub">
        Quem atende e quais serviços cada pessoa realiza.
      </p>
      {professionals.length === 0 ? (
        <p className="empty">
          Nenhum profissional cadastrado ainda. Cadastre o primeiro abaixo.
        </p>
      ) : (
        <ul className="rows" aria-label="Profissionais">
          {professionals.map((p) => (
            <li key={p.id} className={p.active ? "" : "inactive"}>
              <div className="row-main">
                <span className="avatar" aria-hidden="true">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{p.name}</strong>{" "}
                  {!p.active && <span className="badge">Inativo</span>}
                  <div className="muted">
                    {p.serviceIds.length === 0
                      ? "Nenhum serviço vinculado"
                      : `${p.serviceIds.length} ${p.serviceIds.length === 1 ? "serviço" : "serviços"}`}
                  </div>
                </div>
              </div>
              <Link
                className="button"
                to={`/profissionais/${p.id}`}
                aria-label={`Gerenciar ${p.name}`}
              >
                Gerenciar
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Novo profissional</h2>
      <form className="panel" onSubmit={onCreate} noValidate>
        {create.error && <Alert kind="error">{create.error}</Alert>}
        <Field
          id="pro-name"
          label="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={localError ?? create.fieldErrors.name}
        />
        <SubmitButton pending={create.pending} pendingText="Criando…">
          Criar profissional
        </SubmitButton>
      </form>
    </section>
  );
}
