import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import { useApi } from "../../api/ApiContext";
import { Alert, Field, SubmitButton } from "../../components/ui";
import {
  fieldErrorsFromApi,
  fieldErrorsFromZod,
  type FieldErrors,
} from "../../components/forms";
import { tokenFromHash } from "./hashToken";
import { PASSWORD_MIN, resetSchema } from "./schemas";

export function ResetPasswordPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { hash } = useLocation();
  // O token é lido UMA vez e mantido só em memória; o fragmento sai da barra de endereço e do histórico.
  const [token, setToken] = useState(() => tokenFromHash(hash));
  // Também a cada mudança do fragmento: um link novo aberto na MESMA aba (só o `#` muda) é adotado e sai da URL.
  useEffect(() => {
    if (!hash) return;
    const fresh = tokenFromHash(hash);
    if (fresh) setToken(fresh);
    navigate({ hash: "" }, { replace: true });
  }, [hash, navigate]);

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = resetSchema.safeParse({ newPassword, confirm });
    if (!parsed.success) return setErrors(fieldErrorsFromZod(parsed.error));
    setErrors({});
    setPending(true);
    try {
      await api.request("POST", "/api/auth/reset-password", {
        body: { token, newPassword: parsed.data.newPassword },
        anonymous: true,
      });
      navigate("/entrar", {
        replace: true,
        state: { notice: "Senha redefinida. Entre com a nova senha." },
      });
    } catch (err) {
      const fields = fieldErrorsFromApi(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else if (!(err instanceof ApiError && err.handled))
        setFormError(messageOf(err));
      setPending(false);
    }
  }

  if (!token) {
    return (
      <>
        <h1>Redefinir senha</h1>
        <Alert kind="error">
          O link está incompleto ou expirou. Peça um novo link para redefinir
          sua senha.
        </Alert>
        <p className="links">
          <Link to="/esqueci-senha">Pedir novo link</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Redefinir senha</h1>
      <form onSubmit={onSubmit} noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <Field
          id="newPassword"
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          hint={`Mínimo de ${PASSWORD_MIN} caracteres.`}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          error={errors.newPassword}
        />
        <Field
          id="confirm"
          label="Confirme a nova senha"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <SubmitButton pending={pending} pendingText="Salvando…">
          Redefinir senha
        </SubmitButton>
      </form>
    </>
  );
}
