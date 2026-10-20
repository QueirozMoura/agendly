import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import { Alert, Field, SubmitButton } from "../../components/ui";
import { fieldErrorsFromZod, type FieldErrors } from "../../components/forms";
import { useAuth } from "./AuthContext";
import { safeInternalPath } from "./redirect";
import { loginSchema } from "./schemas";

interface LocationState {
  from?: string;
  notice?: string;
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const state = (useLocation().state ?? {}) as LocationState;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) return setErrors(fieldErrorsFromZod(parsed.error));
    setErrors({});
    setPending(true);
    try {
      await auth.login(parsed.data.email, parsed.data.password);
      navigate(safeInternalPath(state.from), { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError && err.handled))
        setFormError(messageOf(err));
      setPending(false);
    }
  }

  return (
    <>
      <h1>Entrar</h1>
      {state.notice && <Alert kind="success">{state.notice}</Alert>}
      {auth.sessionExpired && (
        <Alert kind="info">
          Sua sessão terminou. Entre novamente para continuar.
        </Alert>
      )}
      <form onSubmit={onSubmit} noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <Field
          id="email"
          label="E-mail"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          id="password"
          label="Senha"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <SubmitButton pending={pending} pendingText="Entrando…">
          Entrar
        </SubmitButton>
      </form>
      <p className="links">
        <Link to="/esqueci-senha">Esqueci minha senha</Link>
        <Link to="/cadastro">Criar conta</Link>
      </p>
    </>
  );
}
