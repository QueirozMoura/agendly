import { useState, type FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import type { ApiService } from "../../api/types";
import { fieldErrorsFromZod, type FieldErrors } from "../../components/forms";
import { LoadError } from "../../components/LoadError";
import { Alert, Field, Loading, SubmitButton } from "../../components/ui";
import { useAction } from "../../hooks/useAction";
import { useResource } from "../../hooks/useResource";
import { centsToInput, formatCents } from "../../lib/money";
import { serviceFormSchema } from "./schemas";

export function ServicesPage() {
  const api = useApi();
  const { resource, reload } = useResource(
    async (signal) =>
      (
        await api.request<{ services: ApiService[] }>("GET", "/api/services", {
          signal,
        })
      ).services,
    [api],
  );
  const [editing, setEditing] = useState<ApiService | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toggle = useAction();
  const [toggling, setToggling] = useState<string | null>(null);

  if (resource.status === "loading") return <Loading />;
  if (resource.status === "error")
    return <LoadError message={resource.message} onRetry={reload} />;
  const services = resource.data;

  async function setActive(service: ApiService, active: boolean) {
    setNotice(null);
    setToggling(service.id);
    const res = await toggle.run(() =>
      api.request("PATCH", `/api/services/${service.id}`, { body: { active } }),
    );
    setToggling(null);
    if (res.ok) {
      setNotice(
        active
          ? `"${service.name}" foi ativado.`
          : `"${service.name}" foi desativado.`,
      );
      reload();
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Serviços</h1>
        {editing === null && (
          <button
            type="button"
            className="button primary-inline"
            onClick={() => {
              setNotice(null);
              setEditing("new");
            }}
          >
            Novo serviço
          </button>
        )}
      </div>
      {notice && <Alert kind="success">{notice}</Alert>}
      {toggle.error && <Alert kind="error">{toggle.error}</Alert>}

      {editing !== null && (
        <ServiceForm
          key={editing === "new" ? "new" : editing.id}
          service={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            reload();
          }}
        />
      )}

      {services.length === 0 ? (
        editing === null && (
          <p>
            Nenhum serviço cadastrado ainda. Crie o primeiro para poder
            vinculá-lo aos profissionais.
          </p>
        )
      ) : (
        <ul className="rows" aria-label="Serviços">
          {services.map((s) => (
            <li key={s.id} className={s.active ? "" : "inactive"}>
              <div>
                <strong>{s.name}</strong>{" "}
                {!s.active && <span className="badge">Inativo</span>}
                <div className="muted">
                  {s.durationMinutes} min
                  {s.bufferMinutes > 0
                    ? ` + ${s.bufferMinutes} min de intervalo`
                    : ""}{" "}
                  ·{" "}
                  {s.priceCents === null
                    ? "sem preço"
                    : formatCents(s.priceCents)}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setNotice(null);
                    setEditing(s);
                  }}
                  aria-label={`Editar ${s.name}`}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={toggling !== null}
                  onClick={() => void setActive(s, !s.active)}
                  aria-label={`${s.active ? "Desativar" : "Ativar"} ${s.name}`}
                >
                  {s.active ? "Desativar" : "Ativar"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ServiceForm({
  service,
  onCancel,
  onSaved,
}: {
  service: ApiService | null;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState(service?.name ?? "");
  const [duration, setDuration] = useState(
    service ? String(service.durationMinutes) : "",
  );
  const [buffer, setBuffer] = useState(
    service ? String(service.bufferMinutes) : "0",
  );
  const [price, setPrice] = useState(
    service ? centsToInput(service.priceCents) : "",
  );
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = serviceFormSchema.safeParse({
      name,
      durationMinutes: duration,
      bufferMinutes: buffer,
      price,
    });
    if (!parsed.success)
      return setLocalErrors(fieldErrorsFromZod(parsed.error));
    setLocalErrors({});
    const body = {
      name: parsed.data.name,
      durationMinutes: parsed.data.durationMinutes,
      bufferMinutes: parsed.data.bufferMinutes,
      priceCents: parsed.data.price,
    };
    const res = await action.run(() =>
      service
        ? api.request("PATCH", `/api/services/${service.id}`, { body })
        : api.request("POST", "/api/services", { body }),
    );
    if (res.ok) onSaved(service ? "Serviço atualizado." : "Serviço criado.");
  }
  const errors = { ...action.fieldErrors, ...localErrors };

  return (
    <form
      className="panel"
      onSubmit={submit}
      noValidate
      aria-label={service ? `Editar ${service.name}` : "Novo serviço"}
    >
      <h2>{service ? "Editar serviço" : "Novo serviço"}</h2>
      {service && (
        <p className="muted">
          Agendamentos já criados não mudam: guardam a duração, o intervalo e o
          preço de quando foram feitos.
        </p>
      )}
      {action.error && <Alert kind="error">{action.error}</Alert>}
      <Field
        id="svc-name"
        label="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
      />
      <Field
        id="svc-duration"
        label="Duração (minutos)"
        inputMode="numeric"
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
        error={errors.durationMinutes}
      />
      <Field
        id="svc-buffer"
        label="Intervalo de preparação depois do atendimento (minutos)"
        hint="Tempo em que o profissional fica indisponível para o próximo atendimento. Pode passar do fim do expediente."
        inputMode="numeric"
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        error={errors.bufferMinutes}
      />
      <Field
        id="svc-price"
        label="Preço (R$, opcional)"
        inputMode="decimal"
        placeholder="50,00"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        error={errors.price ?? errors.priceCents}
      />
      <div className="form-actions">
        <SubmitButton pending={action.pending} pendingText="Salvando…">
          Salvar
        </SubmitButton>
        <button
          type="button"
          className="button"
          onClick={onCancel}
          disabled={action.pending}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
