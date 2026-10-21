import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/ApiContext";
import { ApiClient } from "../api/client";
import type { ApiAppointment, ApiOrganization } from "../api/types";
import { AppointmentCard } from "../features/agenda/AppointmentCard";
import * as organizations from "../features/organizations/OrganizationContext";
import { error, makeOrg } from "./fakeBackend";
import { makeAppointment } from "./fakeAgenda";
import { makeProfessional, makeService } from "./fakePanel";
import { server } from "./server";

const NOW = new Date("2031-03-03T12:00:00.000Z");
const PREPARE = "Preparar confirmação pelo WhatsApp";
const SEND = "Enviar confirmação pelo WhatsApp";
let active: ApiOrganization | null;
let appointment: ApiAppointment;
let remote: ApiAppointment;
let phone: unknown;
let requests: Array<{ method: string; path: string; org: string | null }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  active = makeOrg("salao", "Salão da Ana");
  appointment = makeAppointment("a1", "p1", "2031-03-03T13:00:00.000Z", {
    customer: { id: "c1", name: "João" },
  });
  remote = appointment;
  phone = "+5511987654321";
  requests = [];
  vi.spyOn(organizations, "useOrganizations").mockImplementation(() => ({
    active,
    activeSlug: active?.slug ?? null,
    status: "ready",
    organizations: active ? [active] : [],
    loadError: null,
    refresh: vi.fn(),
    retry: vi.fn(),
    select: vi.fn(),
    create: vi.fn(),
  }));
  const record = (request: Request) =>
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      org: request.headers.get("x-active-org"),
    });
  server.use(
    http.get("*/api/appointments/:id", ({ request }) => {
      record(request);
      return HttpResponse.json({ appointment: remote });
    }),
    http.get("*/api/customers/:id", ({ request, params }) => {
      record(request);
      return HttpResponse.json({
        customer: {
          id: params.id,
          name: "João Atual",
          phone,
          email: null,
          notes: null,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount() {
  const onUnauthorized = vi.fn();
  const onActiveOrgChanged = vi.fn();
  const client = new ApiClient({ onUnauthorized, onActiveOrgChanged });
  client.setActiveOrg(active?.slug ?? null);
  const professionals = [makeProfessional("p1", "Carla")];
  // A mensagem deve usar o snapshot "Corte", não este nome atual.
  const services = [makeService("s1", "Serviço renomeado")];
  const card = (a: ApiAppointment, revision = 0) => (
    <ApiProvider client={client}>
      <ul>
        <AppointmentCard
          appointment={a}
          professionals={professionals}
          services={services}
          timeZone={active?.timezone ?? "America/Sao_Paulo"}
          shownDate="2031-03-03"
          confirmationRevision={revision}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>
    </ApiProvider>
  );
  const view = render(card(appointment));
  return {
    ...view,
    client,
    onUnauthorized,
    onActiveOrgChanged,
    user: userEvent.setup(),
    update: (a = appointment, revision = 0) => view.rerender(card(a, revision)),
  };
}

async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: PREPARE }));
  return screen.findByRole("link", { name: SEND });
}

describe("confirmação manual no cartão", () => {
  it("só consulta após o clique e só oferece um link manual com dados reais", async () => {
    const { user } = mount();
    const open = vi.spyOn(window, "open");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    const link = await prepare(user);
    expect(requests).toEqual([
      { method: "GET", path: "/api/appointments/a1", org: "salao" },
      { method: "GET", path: "/api/customers/c1", org: "salao" },
    ]);
    const url = new URL(link.getAttribute("href") as string);
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/5511987654321");
    const message = url.searchParams.get("text");
    expect(message).toContain("João Atual");
    expect(message).toContain("Salão da Ana está marcado!");
    expect(message).toContain("03/03/2031");
    expect(message).toContain("10:00");
    expect(message).toContain("Serviço: Corte");
    expect(message).not.toMatch(/Serviço renomeado|undefined|null/);
    expect(screen.getByText(/Você precisará confirmar o envio/)).toBeVisible();
    expect(
      screen.getByText(/Nenhuma mensagem é enviada automaticamente/),
    ).toBeVisible();
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByRole("link", { name: SEND })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: PREPARE }),
    ).not.toBeInTheDocument();
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(open).not.toHaveBeenCalled();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(appointment.status).toBe("SCHEDULED");
    expect(screen.queryByText(/mensagem enviada/i)).not.toBeInTheDocument();
  });

  it("usa confirmado apenas para CONFIRMED", async () => {
    appointment = { ...appointment, status: "CONFIRMED" };
    remote = appointment;
    const { user } = mount();
    const link = await prepare(user);
    expect(
      new URL(link.getAttribute("href") as string).searchParams.get("text"),
    ).toContain("está confirmado!");
    expect(appointment.status).toBe("CONFIRMED");
  });

  it.each([undefined, null, "", "123", "+55 11 87654-3210"])(
    "não disponibiliza envio com telefone %j",
    async (invalid) => {
      phone = invalid;
      const { user } = mount();
      await user.click(screen.getByRole("button", { name: PREPARE }));
      expect(
        await screen.findByText(/Confira o telefone do cliente/),
      ).toBeVisible();
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["CANCELLED", "COMPLETED", "NO_SHOW"] as const)(
    "oculta a preparação para %s",
    (status) => {
      appointment = { ...appointment, status };
      mount();
      expect(
        screen.queryByRole("button", { name: PREPARE }),
      ).not.toBeInTheDocument();
      expect(requests).toEqual([]);
    },
  );

  it("oculta a preparação no passado e sem empresa ativa", () => {
    appointment = { ...appointment, startsAt: NOW.toISOString() };
    const view = mount();
    expect(
      screen.queryByRole("button", { name: PREPARE }),
    ).not.toBeInTheDocument();
    active = null;
    view.update({ ...appointment, startsAt: "2031-03-03T13:00:00Z" });
    expect(
      screen.queryByRole("button", { name: PREPARE }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { version: 2 },
    { updatedAt: "2031-03-03T12:01:00Z" },
    { startsAt: "2031-03-03T14:00:00Z" },
    { status: "CANCELLED" as const },
    { status: "CONFIRMED" as const },
    { customer: { id: "c2", name: "Outro" } },
  ])(
    "descarta imediatamente mensagem e link após atualização %j",
    async (patch) => {
      const { user, update } = mount();
      await prepare(user);
      update({ ...appointment, ...patch });
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Olá, João Atual/)).not.toBeInTheDocument();
    },
  );

  it("descarta a prévia ao atualizar a agenda, mesmo antes da nova resposta", async () => {
    const { user, update } = mount();
    await prepare(user);
    update(appointment, 1);
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
  });

  it.each(["Remarcar", "Cancelar"])(
    "descarta a prévia ao abrir %s e não a restaura ao fechar",
    async (action) => {
      const { user } = mount();
      await prepare(user);
      await user.click(
        screen.getByRole("button", { name: new RegExp(`^${action} João`) }),
      );
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Voltar" }));
      expect(screen.getByRole("button", { name: PREPARE })).toBeVisible();
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
    },
  );

  it("descarta os dados quando a empresa muda, inclusive com o mesmo agendamento em memória", async () => {
    const { user, update, client } = mount();
    await prepare(user);
    active = makeOrg("outra", "Outra empresa");
    client.setActiveOrg(active.slug);
    update();
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    expect(screen.queryByText(/Olá, João Atual/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: PREPARE })).toBeVisible();
  });

  it("recusa seleção já alterada no servidor antes de buscar o telefone", async () => {
    remote = { ...appointment, version: 2 };
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: PREPARE }));
    expect(
      await screen.findByText(/Este agendamento foi atualizado/),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
  });

  it("recusa cliente diferente do solicitado", async () => {
    server.use(
      http.get("*/api/customers/:id", () =>
        HttpResponse.json({ customer: { id: "outro", name: "Outro", phone } }),
      ),
    );
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: PREPARE }));
    expect(
      await screen.findByText(/Confira o telefone do cliente/),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
  });

  it.each([404, 500])(
    "mostra falha %s com retry, sem expor um link",
    async (status) => {
      server.use(
        http.get("*/api/customers/:id", () =>
          error(status, "NOT_FOUND", "Não foi possível carregar o cliente."),
        ),
      );
      const { user } = mount();
      await user.click(screen.getByRole("button", { name: PREPARE }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Não foi possível carregar o cliente.",
      );
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
      server.use(
        http.get("*/api/customers/:id", () =>
          HttpResponse.json({ customer: { id: "c1", name: "João", phone } }),
        ),
      );
      await user.click(
        screen.getByRole("button", { name: "Tentar novamente" }),
      );
      expect(await screen.findByRole("link", { name: SEND })).toBeVisible();
    },
  );

  it.each([
    [401, "UNAUTHENTICATED"],
    [409, "ACTIVE_ORG_CHANGED"],
  ] as const)("preserva o tratamento central de %s", async (status, code) => {
    server.use(
      http.get("*/api/customers/:id", () =>
        error(status, code, "Contexto inválido."),
      ),
    );
    const { user, onUnauthorized, onActiveOrgChanged } = mount();
    await user.click(screen.getByRole("button", { name: PREPARE }));
    await waitFor(() =>
      expect(
        status === 401 ? onUnauthorized : onActiveOrgChanged,
      ).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
  });

  it.each(["empresa", "agendamento", "atualização da agenda"])(
    "ignora resposta antiga após mudança de %s",
    async (context) => {
      let release: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let oldSignal: AbortSignal | undefined;
      server.use(
        http.get("*/api/customers/:id", async ({ request }) => {
          oldSignal = request.signal;
          await pending;
          return HttpResponse.json({
            customer: { id: "c1", name: "Cliente antigo", phone },
          });
        }),
      );
      const { user, update } = mount();
      await user.click(screen.getByRole("button", { name: PREPARE }));
      await waitFor(() => expect(oldSignal).toBeDefined());
      expect(screen.getByText("Preparando confirmação…")).toBeVisible();
      if (context === "empresa") {
        active = makeOrg("outra");
        update();
      } else if (context === "agendamento") {
        update({ ...appointment, version: appointment.version + 1 });
      } else {
        update(appointment, 1);
      }
      await waitFor(() => expect(oldSignal?.aborted).toBe(true));
      await act(async () => release());
      expect(
        screen.queryByRole("link", { name: SEND }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Cliente antigo/)).not.toBeInTheDocument();
    },
  );

  it("bloqueia o clique se o horário passou após preparar", async () => {
    const { user } = mount();
    const link = await prepare(user);
    vi.setSystemTime(new Date(appointment.startsAt));
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    expect(
      screen.getByText(/O horário deste agendamento já passou/),
    ).toBeVisible();
  });

  it("descarta a mensagem ao sair da aba, exigindo uma nova preparação", async () => {
    const { user } = mount();
    await prepare(user);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
    expect(screen.queryByText(/Olá, João Atual/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: PREPARE })).toBeVisible();
    expect(requests).toHaveLength(2);
  });

  it("preserva foco, teclado e fechamento por Escape", async () => {
    const { user } = mount();
    await prepare(user);
    const region = screen.getByRole("region", {
      name: "Prévia da confirmação pelo WhatsApp",
    });
    expect(region).toHaveFocus();
    expect(
      within(region).getByRole("link", { name: SEND }),
    ).toHaveAccessibleDescription(/Nenhuma mensagem/);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: PREPARE })).toHaveFocus();
    expect(screen.queryByRole("link", { name: SEND })).not.toBeInTheDocument();
  });
});
