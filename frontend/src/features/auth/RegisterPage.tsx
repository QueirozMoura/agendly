import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import { Alert, Field, SubmitButton } from "../../components/ui";
import {
  fieldErrorsFromApi,
  fieldErrorsFromZod,
  type FieldErrors,
} from "../../components/forms";
import { useAuth } from "./AuthContext";
import { PASSWORD_MIN, registerSchema } from "./schemas";

export function RegisterPage() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = registerSchema.safeParse({ name, email, password });
    if (!parsed.success) return setErrors(fieldErrorsFromZod(parsed.error));
    setErrors({});
    setPending(true);
    try {
      // A resposta é a mesma exista a conta ou não (sem enumeração): a mensagem vem do servidor.
      setDone(await auth.register(parsed.data));
    } catch (err) {
      const fields = fieldErrorsFromApi(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else if (!(err instanceof ApiError && err.handled))
        setFormError(messageOf(err));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <>
        <h1>Verifique seu e-mail</h1>
        <Alert kind="success">{done}</Alert>
        <p className="links">
          <Link to="/entrar">Ir para o login</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Criar conta</h1>
      <form onSubmit={onSubmit} noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <Field
          id="name"
          label="Nome"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />
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
          autoComplete="new-password"
          hint={`Mínimo de ${PASSWORD_MIN} caracteres.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <SubmitButton pending={pending} pendingText="Criando…">
          Criar conta
        </SubmitButton>
      </form>
      <p className="links">
        <Link to="/entrar">Já tenho conta</Link>
      </p>
    </>
  );
}
