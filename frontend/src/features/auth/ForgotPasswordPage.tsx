import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import type { MessageResponse } from "../../api/types";
import { useApi } from "../../api/ApiContext";
import { Alert, Field, SubmitButton } from "../../components/ui";
import { fieldErrorsFromZod, type FieldErrors } from "../../components/forms";
import { forgotSchema } from "./schemas";

export function ForgotPasswordPage() {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = forgotSchema.safeParse({ email });
    if (!parsed.success) return setErrors(fieldErrorsFromZod(parsed.error));
    setErrors({});
    setPending(true);
    try {
      // Mesma resposta exista o e-mail ou não (3.4): nada aqui revela se a conta existe.
      const res = await api.request<MessageResponse>(
        "POST",
        "/api/auth/forgot-password",
        {
          body: parsed.data,
          anonymous: true,
        },
      );
      setDone(res.message);
    } catch (err) {
      if (!(err instanceof ApiError && err.handled))
        setFormError(messageOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1>Recuperar senha</h1>
      {done ? (
        <Alert kind="success">{done}</Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <p>
            Informe o e-mail da conta. Enviaremos um link para criar uma nova
            senha.
          </p>
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
          <SubmitButton pending={pending} pendingText="Enviando…">
            Enviar link
          </SubmitButton>
        </form>
      )}
      <p className="links">
        <Link to="/entrar">Voltar ao login</Link>
      </p>
    </>
  );
}
