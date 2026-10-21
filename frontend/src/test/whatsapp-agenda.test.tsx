// Integração com os providers e as rotas reais da SPA, sem substituir o contexto de empresa.
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgenda, makeAppointment } from "./fakeAgenda";
import { error, makeOrg } from "./fakeBackend";
import { makeProfessional, makeService } from "./fakePanel";
import { panelState } from "./panelHelpers";
import { renderApp } from "./render";

const NOW = new Date("2031-03-03T12:00:00.000Z");
const PREPARE = "Preparar confirmação pelo WhatsApp";
const SEND = "Enviar confirmação pelo WhatsApp";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function setup() {
  const state = panelState({
    professionals: [makeProfessional("p1", "Carla")],
    services: [makeService("s1", "Serviço atual")],
  });
  state.agenda = makeAgenda({
    appointments: [makeAppointment("a1", "p1", "2031-03-03T13:00:00.000Z")],
  });
  const reads: Array<{ path: string; org: string | null }> = [];
  const handlers = [
    http.get("*/api/appointments/:id", ({ request }) => {
      reads.push({
        path: new URL(request.url).pathname,
        org: request.headers.get("x-active-org"),
      });
      return HttpResponse.json({ appointment: state.agenda.appointments[0] });
    }),
    http.get("*/api/customers/:id", ({ request, params }) => {
      reads.push({
        path: new URL(request.url).pathname,
        org: request.headers.get("x-active-org"),
      });
      if (
        !state.user ||
        request.headers.get("x-active-org") !== state.activeSlug
      )
        return error(404, "NOT_FOUND", "Recurso não encontrado.");
      return HttpResponse.json({
        customer: { id: params.id, name: "Cliente", phone: "+5511987654321" },
      });
    }),
  ];
  return { state, reads, handlers };
}

describe("WhatsApp na agenda real", () => {
  it.each(["Dia", "Semana"])(
    "prepara uma única ação por cartão na visão %s, com a empresa ativa",
    async (view) => {
      const { state, reads, handlers } = setup();
      const { user } = renderApp(state, {
        route: "/agenda",
        overrides: handlers,
      });
      await screen.findByRole("button", { name: PREPARE });
      if (view === "Semana")
        await user.click(screen.getByRole("button", { name: "Semana" }));
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: PREPARE })).toHaveLength(
          1,
        ),
      );
      expect(reads).toEqual([]);
      await user.click(screen.getByRole("button", { name: PREPARE }));
      expect(await screen.findByRole("link", { name: SEND })).toBeVisible();
      expect(reads).toEqual([
        { path: "/api/appointments/a1", org: "salao" },
        { path: "/api/customers/c-a1", org: "salao" },
      ]);
      expect(state.calls.filter((c) => c.method !== "GET")).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Atualizar" }));
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Olá, Cliente!/)).not.toBeInTheDocument();
    },
  );

  it("não prepara para usuário anônimo", async () => {
    const { state, reads, handlers } = setup();
    state.user = null;
    renderApp(state, { route: "/agenda", overrides: handlers });
    await screen.findByRole("heading", { name: "Entrar" });
    expect(
      screen.queryByRole("button", { name: PREPARE }),
    ).not.toBeInTheDocument();
    expect(reads).toEqual([]);
  });

  it("não conserva a mensagem ao selecionar outra empresa", async () => {
    const { state, reads, handlers } = setup();
    state.organizations.push(makeOrg("outra", "Outra empresa"));
    const { user, go } = renderApp(state, {
      route: "/agenda",
      overrides: handlers,
    });
    await user.click(await screen.findByRole("button", { name: PREPARE }));
    await screen.findByRole("link", { name: SEND });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Empresa ativa" }),
      "outra",
    );
    await waitFor(() => expect(state.activeSlug).toBe("outra"));
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    // A empresa nova tem sua própria agenda; não se deve transportar o cartão antigo.
    state.agenda.appointments = [];
    await go("/agenda");
    expect(
      await screen.findByText("Nenhum agendamento neste período."),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    expect(reads.every((r) => r.org === "salao")).toBe(true);
  });
});
