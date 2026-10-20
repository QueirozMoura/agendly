import { Alert } from "./ui";

/** Falha ao carregar dados que a tela precisa: mensagem + "Tentar novamente" (nunca um estado vazio enganoso). */
export function LoadError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="page">
      <Alert kind="error">
        {message ?? "Não foi possível carregar os dados."}
      </Alert>
      <button type="button" className="button" onClick={onRetry}>
        Tentar novamente
      </button>
    </section>
  );
}
