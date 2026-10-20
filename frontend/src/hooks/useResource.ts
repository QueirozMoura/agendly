import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, messageOf } from "../api/client";

export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/**
 * Carrega um recurso da API com estados explícitos (carregando / erro / pronto) e `reload`. Um erro NUNCA vira dado
 * vazio: quem consome decide o que mostrar em cada estado. Erros tratados centralmente (401, 409 de empresa...) não
 * viram mensagem local. `deps` refaz a carga; o pedido anterior é cancelado.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): { resource: Resource<T>; reload: () => void; setData: (next: T) => void } {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const previous = useRef<{ deps: readonly unknown[]; nonce: number } | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    const last = previous.current;
    // `reload()` (só o contador muda) atualiza os dados SEM trocar a tela por "carregando": avisos, foco e rolagem
    // permanecem. Mudou algum `dep` (ex.: outro id) ⇒ carga nova, com estado de carregamento.
    const onlyReload =
      last !== null &&
      last.nonce !== nonce &&
      deps.length === last.deps.length &&
      deps.every((d, i) => Object.is(d, last.deps[i]));
    previous.current = { deps, nonce };
    if (!onlyReload) setResource({ status: "loading" });
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResource({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.handled) return;
        setResource({ status: "error", message: messageOf(err) });
      });
    return () => controller.abort();
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (next: T) => setResource({ status: "ready", data: next }),
    [],
  );
  return { resource, reload, setData };
}
