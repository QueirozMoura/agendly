import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, messageOf } from "../../api/client";
import { useApi } from "../../api/ApiContext";
import { Alert, SubmitButton } from "../../components/ui";
import { useAuth } from "./AuthContext";
import { tokenFromHash } from "./hashToken";

type State =
  | { kind: "ready" } // há token e o usuário ainda não confirmou: espera o clique
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "missing" };

/** O que o estado do histórico guarda depois de confirmar: sobrevive ao recarregar a página (o token já saiu da URL). */
interface VerifiedState {
  emailVerified?: boolean;
}

/**
 * Confirmação de e-mail. O token (fragmento `#token=…`) só é ENVIADO depois de um clique explícito em "Confirmar e-mail":
 * abrir o link não consome nada, então um verificador de links que renderize a página não gasta o token de uso único.
 * O token fica só em memória; o fragmento sai da barra de endereço e do histórico assim que a página abre.
 */
export function VerifyEmailPage() {
  const api = useApi();
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const alreadyVerified =
    (location.state as VerifiedState | null)?.emailVerified === true;
  const [token, setToken] = useState(() => tokenFromHash(location.hash));
  const [state, setState] = useState<State>(() =>
    alreadyVerified
      ? { kind: "success" }
      : token
        ? { kind: "ready" }
        : { kind: "missing" },
  );

  // Roda na abertura E a cada mudança do fragmento: um link novo aberto na MESMA aba (só o `#` muda, sem remontar a
  // página) também é adotado. Em ambos os casos o fragmento sai da barra de endereço e do histórico.
  useEffect(() => {
    if (!location.hash) return;
    const fresh = tokenFromHash(location.hash);
    if (fresh) {
      setToken(fresh);
      setState({ kind: "ready" });
    }
    navigate({ hash: "" }, { replace: true, state: location.state });
  }, [location.hash, location.state, navigate]);

  async function confirm() {
    if (state.kind === "submitting") return;
    setState({ kind: "submitting" });
    try {
      await api.request("POST", "/api/auth/verify-email", {
        body: { token },
        anonymous: true,
      });
      // Marca a confirmação no histórico: recarregar a página continua mostrando o sucesso (e não "link incompleto").
      navigate(
        { hash: "" },
        {
          replace: true,
          state: { emailVerified: true } satisfies VerifiedState,
        },
      );
      setState({ kind: "success" });
      await auth.refresh(); // com sessão, o aviso de e-mail não confirmado some; sem sessão, nada muda
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // Falha transitória (rede, 429, 5xx): o token continua válido, então permite tentar de novo.
      const retryable = status === 0 || status === 429 || status >= 500;
      setState({ kind: "error", message: messageOf(err), retryable });
    }
  }

  const signedIn = auth.status === "authenticated";
  return (
    <>
      <h1>Confirmação de e-mail</h1>
      {(state.kind === "ready" || state.kind === "submitting") && (
        <>
          <p>Para concluir o cadastro, confirme o seu e-mail.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <SubmitButton
              pending={state.kind === "submitting"}
              pendingText="Confirmando…"
            >
              Confirmar e-mail
            </SubmitButton>
          </form>
        </>
      )}
      {state.kind === "success" && (
        <>
          <Alert kind="success">E-mail confirmado com sucesso.</Alert>
          <p className="links">
            <Link to={signedIn ? "/" : "/entrar"}>
              {signedIn ? "Continuar" : "Entrar"}
            </Link>
          </p>
        </>
      )}
      {state.kind === "error" && (
        <>
          <Alert kind="error">{state.message}</Alert>
          {state.retryable ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              <SubmitButton pending={false}>Tentar novamente</SubmitButton>
            </form>
          ) : (
            <>
              <p>
                Se você já confirmou o seu e-mail, basta entrar na sua conta. Se
                o link expirou, entre e peça um novo envio.
              </p>
              <p className="links">
                <Link to={signedIn ? "/" : "/entrar"}>
                  {signedIn ? "Ir para o painel" : "Ir para o login"}
                </Link>
              </p>
            </>
          )}
        </>
      )}
      {state.kind === "missing" && (
        <>
          <Alert kind="error">
            O link de confirmação está incompleto ou já foi usado.
          </Alert>
          <p>
            Se você já confirmou o seu e-mail, basta entrar na sua conta. Caso
            contrário, abra o link do e-mail novamente ou peça um novo envio
            depois de entrar.
          </p>
          <p className="links">
            <Link to={signedIn ? "/" : "/entrar"}>
              {signedIn ? "Ir para o painel" : "Ir para o login"}
            </Link>
          </p>
        </>
      )}
    </>
  );
}
