import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import type { RequestHandler } from "msw";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { App } from "../app";
import { ApiClient } from "../api/client";
import { server } from "./server";
import { fakeBackend, type FakeState } from "./fakeBackend";

type Navigate = ReturnType<typeof useNavigate>;

/** Expõe o `navigate` do router para os testes simularem uma navegação externa (ex.: abrir outro link na mesma aba). */
function NavigateProbe({ into }: { into: { current: Navigate | null } }) {
  into.current = useNavigate();
  return null;
}

function LocationProbe() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="location">{`${pathname}${search}${hash}`}</div>;
}

/** Monta o app inteiro (providers + rotas) sobre o backend falso do estado dado. */
export function renderApp(
  state: FakeState,
  options: {
    route?: string;
    /** `location.state` da rota inicial (ex.: `{ from }` do login, ou `{ emailVerified }` depois de recarregar). */
    routeState?: unknown;
    /** Handlers que valem ANTES do backend falso (instalados depois dele: o mais recente tem prioridade). */
    overrides?: RequestHandler[];
    onReload?: () => void;
    client?: ApiClient;
    /** Monta dentro de <StrictMode> (efeitos em dobro), como em desenvolvimento. */
    strict?: boolean;
  } = {},
) {
  server.use(...fakeBackend(state));
  if (options.overrides) server.use(...options.overrides);
  const onReload = options.onReload ?? (() => undefined);
  const [pathAndQuery = "/", hash = ""] = (options.route ?? "/").split("#");
  const [pathname = "/", search = ""] = pathAndQuery.split("?");
  const entry = {
    pathname,
    search: search ? `?${search}` : "",
    hash: hash ? `#${hash}` : "",
    ...(options.routeState === undefined ? {} : { state: options.routeState }),
  };
  const navigateRef: { current: Navigate | null } = { current: null };
  const tree = (
    <MemoryRouter initialEntries={[entry]}>
      <App
        onReload={onReload}
        {...(options.client ? { client: options.client } : {})}
      />
      <LocationProbe />
      <NavigateProbe into={navigateRef} />
    </MemoryRouter>
  );
  const utils = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  /** Navega como se o usuário abrisse outro endereço (mesma aba, sem recarregar o app). */
  const go = (to: string) => act(async () => void navigateRef.current?.(to));
  return { ...utils, user: userEvent.setup(), onReload, go };
}

export const currentPath = (container: HTMLElement) =>
  container.ownerDocument.querySelector('[data-testid="location"]')
    ?.textContent ?? "";
