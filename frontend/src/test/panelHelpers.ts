import { ANA, makeOrg, makeState, type FakeState } from "./fakeBackend";
import { makePanel, type PanelState } from "./fakePanel";

/** Estado com usuário autenticado, empresa ativa (na timezone dada) e os dados do painel. */
export function panelState(
  panel: Partial<PanelState> = {},
  timezone = "America/Sao_Paulo",
): FakeState {
  return makeState({
    user: ANA,
    organizations: [{ ...makeOrg("salao", "Salão da Ana"), timezone }],
    activeSlug: "salao",
    panel: makePanel(panel),
  });
}

export const callsTo = (
  state: FakeState,
  method: string,
  path: string | RegExp,
) =>
  state.calls.filter(
    (c) =>
      c.method === method &&
      (typeof path === "string" ? c.path === path : path.test(c.path)),
  );
