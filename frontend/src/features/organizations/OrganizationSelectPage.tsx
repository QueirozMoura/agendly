import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import { LoadError } from "../../components/LoadError";
import { Alert, Field, Loading, SubmitButton } from "../../components/ui";
import {
  fieldErrorsFromApi,
  fieldErrorsFromZod,
  type FieldErrors,
} from "../../components/forms";
import { useOrganizations } from "./OrganizationContext";
import {
  DEFAULT_TIMEZONE,
  organizationSchema,
  slugify,
  timeZoneOptions,
} from "./schemas";

export function OrganizationSelectPage() {
  const orgs = useOrganizations();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const zones = useMemo(timeZoneOptions, []);

  if (orgs.status === "loading") return <Loading />;
  // A lista não pôde ser obtida: não afirma "nenhuma empresa" nem oferece criar (poderia duplicar o que já existe).
  if (orgs.status === "error")
    return (
      <LoadError message={orgs.loadError} onRetry={() => void orgs.retry()} />
    );

  async function choose(slugToSelect: string) {
    setSelectError(null);
    setSelecting(slugToSelect);
    try {
      await orgs.select(slugToSelect);
      navigate("/", { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError && err.handled))
        setSelectError(messageOf(err));
      setSelecting(null);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = organizationSchema.safeParse({ name, slug, timezone });
    if (!parsed.success) return setErrors(fieldErrorsFromZod(parsed.error));
    setErrors({});
    setCreating(true);
    try {
      await orgs.create(parsed.data);
      navigate("/", { replace: true });
    } catch (err) {
      const fields = fieldErrorsFromApi(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else if (err instanceof ApiError && err.code === "SLUG_UNAVAILABLE")
        setErrors({ slug: err.message });
      else if (!(err instanceof ApiError && err.handled))
        setFormError(messageOf(err));
      setCreating(false);
    }
  }

  return (
    <section className="page">
      <h1>Suas empresas</h1>
      <p className="page-sub">
        Escolha a empresa que quer gerenciar ou crie uma nova.
      </p>
      {orgs.organizations.length === 0 ? (
        <p className="empty">
          Você ainda não tem nenhuma empresa. Crie a primeira para começar.
        </p>
      ) : (
        <>
          {selectError && <Alert kind="error">{selectError}</Alert>}
          <ul className="org-list" aria-label="Empresas">
            {orgs.organizations.map((o) => (
              <li key={o.slug}>
                <div className="row-main">
                  <span className="avatar" aria-hidden="true">
                    {o.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{o.name}</strong>
                    <span className="muted"> · {o.slug}</span>
                    {o.slug === orgs.activeSlug && (
                      <span className="badge badge-confirmed">Ativa</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={selecting !== null}
                  onClick={() => void choose(o.slug)}
                  aria-label={`Entrar em ${o.name}`}
                >
                  {selecting === o.slug ? "Entrando…" : "Entrar"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Criar nova empresa</h2>
      <form onSubmit={onCreate} noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <Field
          id="org-name"
          label="Nome da empresa"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          error={errors.name}
        />
        <Field
          id="org-slug"
          label="Endereço"
          hint="Letras minúsculas, números e hífens (3 a 40 caracteres)."
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          error={errors.slug}
        />
        <div className="field">
          <label htmlFor="org-timezone">Fuso horário</label>
          <select
            id="org-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-describedby="org-timezone-hint"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p id="org-timezone-hint" className="hint">
            O fuso horário não poderá ser alterado depois.
          </p>
          {errors.timezone && <p className="field-error">{errors.timezone}</p>}
        </div>
        <SubmitButton pending={creating} pendingText="Criando…">
          Criar empresa
        </SubmitButton>
      </form>
    </section>
  );
}
