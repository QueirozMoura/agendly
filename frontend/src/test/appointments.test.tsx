// Agenda e agendamentos (Etapa 13): visões dia/semana, criação com Idempotency-Key, conflitos 409, remarcar/cancelar
// com `version`, R7 (passado) e timezone da empresa. Testa a UI real contra o backend falso (contratos das Etapas 9–10).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, rangeUtc, visibleDays, weekStart } from "../lib/agenda";
import { error } from "./fakeBackend";
import { makeAgenda, makeAppointment } from "./fakeAgenda";
import { makeProfessional, makeService } from "./fakePanel";
import { callsTo, panelState } from "./panelHelpers";
import { currentPath, renderApp } from "./render";

// Segunda-feira 03/03/2031, 09:00 em São Paulo (UTC-3, sem horário de verão desde 2019).
const NOW = new Date("2031-03-03T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const SLOTS_TODAY = ["2031-03-03T14:00:00.000Z", "2031-03-03T15:00:00.000Z"]; // 11:00 e 12:00 em SP

function state(
  over: {
    appointments?: ReturnType<typeof makeAppointment>[];
    slots?: Record<string, string[]>;
  } = {},
  tz?: string,
) {
  const s = panelState(
    {
      services: [
        makeService("s1", "Corte", {
          durationMinutes: 30,
          bufferMinutes: 10,
          priceCents: 5050,
        }),
        makeService("s2", "Barba", { active: false }),
      ],
      professionals: [
        makeProfessional("p1", "Carla", { serviceIds: ["s1"] }),
        makeProfessional("p2", "Davi", { serviceIds: ["s1"] }),
      ],
    },
    tz,
  );
  s.agenda = makeAgenda({
    appointments: over.appointments ?? [
      makeAppointment("a1", "p1", "2031-03-03T13:00:00.000Z", {
        customer: { id: "c1", name: "Marina" },
        version: 3,
        service: {
          name: "Corte",
          durationMinutes: 30,
          bufferMinutes: 10,
          priceCents: 5050,
        },
      }),
      makeAppointment("a2", "p2", "2031-03-03T17:30:00.000Z", {
        customer: { id: "c2", name: "Paulo" },
      }),
    ],
    slots: {
      "p1|s1|2031-03-03": SLOTS_TODAY,
      "p2|s1|2031-03-03": ["2031-03-03T16:00:00.000Z"],
      "p1|s1|2031-03-04": ["2031-03-04T13:00:00.000Z"],
      ...over.slots,
    },
  });
  for (const a of s.agenda.appointments)
    s.agenda.taken.add(`${a.professionalId}|${a.startsAt}`);
  return s;
}

const pro = (name: string) =>
  screen.findByRole("region", { name: `Agenda de ${name}` });
const apptCalls = (s: ReturnType<typeof state>) =>
  callsTo(s, "GET", "/api/appointments");
const slotCalls = (s: ReturnType<typeof state>) =>
  callsTo(s, "GET", "/api/availability/slots");
const posts = (
  s: ReturnType<typeof state>,
  path: string | RegExp = "/api/appointments",
) => callsTo(s, "POST", path);

async function openForm(user: ReturnType<typeof renderApp>["user"]) {
  await screen.findByRole("region", { name: "Agenda de Carla" });
  await user.click(screen.getByRole("button", { name: "Novo agendamento" }));
  return screen.findByRole("form", { name: "Novo agendamento" });
}

async function fillContact(
  user: ReturnType<typeof renderApp>["user"],
  form: HTMLElement,
) {
  await user.type(within(form).getByLabelText("Nome do cliente"), "Joana Lima");
  await user.type(within(form).getByLabelText("Telefone"), "(11) 98765-4321");
  await user.type(
    within(form).getByLabelText("E-mail (opcional)"),
    "joana@example.com",
  );
}

async function chooseService(
  user: ReturnType<typeof renderApp>["user"],
  form: HTMLElement,
  professional = "Carla",
) {
  await user.selectOptions(
    within(form).getByLabelText("Profissional"),
    professional,
  );
  await user.selectOptions(within(form).getByLabelText("Serviço"), "Corte");
}

describe("visão diária", () => {
  it("lista o dia local da empresa, agrupa por profissional e mostra o horário local de cada um", async () => {
    const s = state();
    renderApp(s, { route: "/agenda" });
    const carla = await pro("Carla");
    const davi = await pro("Davi");
    expect(
      screen.getByRole("heading", { name: /segunda-feira, 03\/03\/2031/ }),
    ).toBeInTheDocument();
    const marina = within(carla).getByRole("article", { name: /Marina/ });
    expect(within(marina).getByText("10:00–10:30")).toBeInTheDocument();
    expect(within(marina).getByText("Agendado")).toBeInTheDocument();
    expect(within(carla).queryByText(/Paulo/)).not.toBeInTheDocument();
    expect(within(davi).getByText("14:30–15:00")).toBeInTheDocument();
    expect(within(davi).getByText("Paulo")).toBeInTheDocument();
    expect(screen.getByText(/America\/Sao_Paulo/)).toBeInTheDocument();
  });

  it("consulta somente o dia local exibido: [00:00 local, 00:00 do dia seguinte) em UTC", async () => {
    const s = state();
    renderApp(s, { route: "/agenda" });
    await pro("Carla");
    const q = new URLSearchParams(apptCalls(s)[0]?.search);
    expect(q.get("from")).toBe("2031-03-03T03:00:00.000Z");
    expect(q.get("to")).toBe("2031-03-04T03:00:00.000Z");
    expect([...q.keys()].sort()).toEqual(["from", "to"]);
  });

  it("um agendamento às 23:30 locais pertence ao dia local, mesmo sendo o dia seguinte em UTC", async () => {
    const s = state({
      appointments: [
        makeAppointment("late", "p1", "2031-03-04T02:30:00.000Z", {
          customer: { id: "c9", name: "Noturna" },
        }),
      ],
    });
    renderApp(s, { route: "/agenda" });
    const carla = await pro("Carla");
    expect(within(carla).getByText("23:30–00:00")).toBeInTheDocument();
  });

  it("mostra o preço, a duração e o intervalo do SNAPSHOT do agendamento (R3), não o serviço atual", async () => {
    const s = state({
      appointments: [
        makeAppointment("old", "p1", "2031-03-03T13:00:00.000Z", {
          customer: { id: "c1", name: "Marina" },
          service: {
            name: "Corte antigo",
            durationMinutes: 45,
            bufferMinutes: 15,
            priceCents: 8000,
          },
        }),
      ],
    });
    // o serviço atual vale outra coisa
    s.panel.services[0] = makeService("s1", "Corte novo", {
      durationMinutes: 20,
      bufferMinutes: 0,
      priceCents: 1000,
    });
    renderApp(s, { route: "/agenda" });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    expect(marina).toHaveTextContent("Corte antigo");
    expect(marina).toHaveTextContent("45 min + 15 min de intervalo");
    expect(marina).toHaveTextContent("R$ 80,00");
    expect(marina).not.toHaveTextContent("Corte novo");
  });
});

describe("navegação e visão semanal", () => {
  it("navega entre dias, volta a hoje e aceita uma data digitada", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    await pro("Carla");
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    expect(
      await screen.findByRole("heading", { name: /terça-feira, 04\/03\/2031/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(new URLSearchParams(apptCalls(s).at(-1)?.search).get("from")).toBe(
        "2031-03-04T03:00:00.000Z",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Anterior" }));
    await user.click(screen.getByRole("button", { name: "Anterior" }));
    expect(
      await screen.findByRole("heading", { name: /domingo, 02\/03\/2031/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hoje" }));
    expect(
      await screen.findByRole("heading", {
        name: /segunda-feira, 03\/03\/2031/,
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: "2031-03-20" },
    });
    expect(
      await screen.findByRole("heading", {
        name: /quinta-feira, 20\/03\/2031/,
      }),
    ).toBeInTheDocument();
  });

  it("alterna para a semana (segunda a domingo), consulta os 7 dias e põe cada agendamento no seu dia", async () => {
    const s = state({
      appointments: [
        makeAppointment("a1", "p1", "2031-03-03T13:00:00.000Z", {
          customer: { id: "c1", name: "Marina" },
        }),
        makeAppointment("a3", "p1", "2031-03-05T14:00:00.000Z", {
          customer: { id: "c3", name: "Quarta" },
        }),
        // sábado 23:30 local (já domingo em UTC) e domingo 23:30 local (segunda em UTC): ambos dentro da semana
        makeAppointment("a4", "p1", "2031-03-09T02:30:00.000Z", {
          customer: { id: "c4", name: "Sabado" },
        }),
        makeAppointment("a5", "p2", "2031-03-10T02:30:00.000Z", {
          customer: { id: "c5", name: "Domingo" },
        }),
        // segunda 10/03 00:00 local: fora da semana (o servidor nem devolve)
        makeAppointment("a6", "p2", "2031-03-10T03:00:00.000Z", {
          customer: { id: "c6", name: "Fora" },
        }),
      ],
    });
    const { user } = renderApp(s, { route: "/agenda" });
    await pro("Carla");
    await user.click(screen.getByRole("button", { name: "Semana" }));
    expect(screen.getByRole("button", { name: "Semana" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const carla = await pro("Carla");
    const q = new URLSearchParams(apptCalls(s).at(-1)?.search);
    expect(q.get("from")).toBe("2031-03-03T03:00:00.000Z");
    expect(q.get("to")).toBe("2031-03-10T03:00:00.000Z");
    const day = (name: RegExp) => within(carla).getByRole("region", { name });
    expect(
      within(day(/segunda-feira 03\/03\/2031/)).getByText("Marina"),
    ).toBeInTheDocument();
    expect(
      within(day(/quarta-feira 05\/03\/2031/)).getByText("Quarta"),
    ).toBeInTheDocument();
    expect(
      within(day(/sábado 08\/03\/2031/)).getByText("Sabado"),
    ).toBeInTheDocument();
    expect(
      within(day(/terça-feira 04\/03\/2031/)).getByText("—"),
    ).toBeInTheDocument();
    const davi = await pro("Davi");
    expect(within(davi).getByText("Domingo")).toBeInTheDocument();
    expect(
      within(davi).getByRole("region", { name: /domingo 09\/03\/2031/ }),
    ).toHaveTextContent("23:30–00:00");
    expect(screen.queryByText("Fora")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /segunda-feira, 03\/03\/2031 a domingo, 09\/03\/2031/,
      }),
    ).toBeInTheDocument();
  });

  it("na semana, Próximo/Anterior andam 7 dias", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    await pro("Carla");
    await user.click(screen.getByRole("button", { name: "Semana" }));
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    expect(
      await screen.findByRole("heading", {
        name: /segunda-feira, 10\/03\/2031 a domingo, 16\/03\/2031/,
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(new URLSearchParams(apptCalls(s).at(-1)?.search).get("from")).toBe(
        "2031-03-10T03:00:00.000Z",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Dia" }));
    expect(
      await screen.findByRole("heading", {
        name: /segunda-feira, 10\/03\/2031$/,
      }),
    ).toBeInTheDocument();
  });

  it("usa a timezone da EMPRESA (Nova York ≠ São Paulo ≠ navegador) para o dia, o horário e os limites, inclusive na virada do horário de verão", async () => {
    const s = state(
      {
        appointments: [
          makeAppointment("ny", "p1", "2031-03-03T13:00:00.000Z", {
            customer: { id: "c1", name: "Marina" },
          }),
        ],
      },
      "America/New_York",
    );
    const { user } = renderApp(s, { route: "/agenda" });
    const carla = await pro("Carla");
    // 13:00Z = 08:00 em Nova York (UTC-5), e não 10:00 como em São Paulo
    expect(within(carla).getByText("08:00–08:30")).toBeInTheDocument();
    expect(new URLSearchParams(apptCalls(s)[0]?.search).get("from")).toBe(
      "2031-03-03T05:00:00.000Z",
    );
    await user.click(screen.getByRole("button", { name: "Semana" }));
    await pro("Carla");
    const q = new URLSearchParams(apptCalls(s).at(-1)?.search);
    // domingo 09/03/2031 tem 23h (o horário de verão começa); segunda 10/03 00:00 local já é UTC-4
    expect(q.get("from")).toBe("2031-03-03T05:00:00.000Z");
    expect(q.get("to")).toBe("2031-03-10T04:00:00.000Z");
  });

  it("hoje depende da timezone da empresa: às 01:30Z de 04/03 ainda é 03/03 em São Paulo, mas já é 04/03 em Sydney", async () => {
    vi.setSystemTime(new Date("2031-03-04T01:30:00.000Z"));
    const sp = state();
    const first = renderApp(sp, { route: "/agenda" });
    await pro("Carla");
    expect(
      screen.getByRole("heading", { name: /segunda-feira, 03\/03\/2031/ }),
    ).toBeInTheDocument();
    first.unmount();
    const sydney = state({}, "Australia/Sydney");
    renderApp(sydney, { route: "/agenda" });
    await screen.findByRole("heading", { name: /terça-feira, 04\/03\/2031/ });
  });
});

describe("estados da tela", () => {
  it("carregando, depois a lista", async () => {
    const s = state();
    renderApp(s, {
      route: "/agenda",
      overrides: [
        http.get("*/api/appointments", async () => {
          await delay(60);
        }),
      ],
    });
    expect(
      await screen.findByText("Carregando agendamentos…"),
    ).toBeInTheDocument();
    await pro("Carla");
    expect(
      screen.queryByText("Carregando agendamentos…"),
    ).not.toBeInTheDocument();
  });

  it("período sem agendamentos: lista vazia, sem erro", async () => {
    const s = state({ appointments: [] });
    renderApp(s, { route: "/agenda" });
    expect(
      await screen.findByText("Nenhum agendamento neste período."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sem profissionais cadastrados orienta a cadastrar (e não parece uma agenda vazia)", async () => {
    const s = state();
    s.panel.professionals = [];
    renderApp(s, { route: "/agenda" });
    expect(
      await screen.findByText(/Cadastre um profissional/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nenhum agendamento neste período."),
    ).not.toBeInTheDocument();
  });

  it("erro da API NÃO vira lista vazia: mostra o erro e 'Tentar novamente' recupera", async () => {
    const s = state();
    let fail = true;
    renderApp(s, {
      route: "/agenda",
      overrides: [
        http.get("*/api/appointments", () =>
          fail
            ? error(500, "INTERNAL_ERROR", "Falha interna. Tente novamente.")
            : undefined,
        ),
      ],
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Falha interna. Tente novamente.",
    );
    expect(
      screen.queryByText("Nenhum agendamento neste período."),
    ).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await pro("Carla");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("'Atualizar' relê a agenda e mostra o que mudou", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    await pro("Carla");
    s.agenda.appointments.push(
      makeAppointment("new", "p1", "2031-03-03T19:00:00.000Z", {
        customer: { id: "c7", name: "Recém Chegada" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    expect(await screen.findByText("Recém Chegada")).toBeInTheDocument();
  });

  it("lista que atinge o teto de 500 avisa que pode estar incompleta", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      makeAppointment(`m${i}`, "p1", "2031-03-03T13:00:00.000Z", {
        customer: { id: `c${i}`, name: `C${i}` },
      }),
    );
    renderApp(state({ appointments: many }), { route: "/agenda" });
    expect(
      await screen.findByText(/Mostrando os 500 primeiros agendamentos/),
    ).toBeInTheDocument();
  });

  it("agendamentos cancelados aparecem como cancelados, com o motivo, e sem ações", async () => {
    const s = state({
      appointments: [
        makeAppointment("x", "p1", "2031-03-03T13:00:00.000Z", {
          customer: { id: "c1", name: "Marina" },
          status: "CANCELLED",
          cancelReason: "Viagem",
        }),
      ],
    });
    renderApp(s, { route: "/agenda" });
    const card = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    expect(card).toHaveTextContent("Cancelado");
    expect(card).toHaveTextContent("Motivo: Viagem");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
  });

  it("'Agenda' está no menu principal, com a página atual indicada, sob autenticação e empresa ativa", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const nav = await screen.findByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Agenda" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(nav).getByRole("link", { name: "Serviços" }));
    await user.click(within(nav).getByRole("link", { name: "Agenda" }));
    await pro("Carla");
    expect(currentPath(document.body)).toBe("/agenda");
  });

  it("sem sessão, /agenda leva ao login e o login volta à agenda", async () => {
    const s = state();
    s.user = null;
    const { user } = renderApp(s, { route: "/agenda" });
    await screen.findByRole("heading", { name: "Entrar" });
    await user.type(screen.getByLabelText("E-mail"), "ana@example.com");
    await user.type(screen.getByLabelText("Senha"), "uma-senha-bem-longa-9X");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await pro("Carla");
    expect(currentPath(document.body)).toBe("/agenda");
  });

  it("sessão expirada durante o uso: volta ao login com o aviso, sem mostrar o erro cru", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    await pro("Carla");
    s.user = null;
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sua sessão terminou.",
    );
    expect(
      screen.queryByText("Sessão inválida ou expirada."),
    ).not.toBeInTheDocument();
  });

  it("sessão expirada ao cancelar: nada é mostrado como sucesso", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    await user.click(
      within(marina).getByRole("button", { name: /^Cancelar Marina/ }),
    );
    s.user = null;
    await user.click(
      screen.getByRole("button", { name: "Confirmar cancelamento" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Entrar" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Agendamento cancelado."),
    ).not.toBeInTheDocument();
    expect(s.agenda.appointments[0]?.status).toBe("SCHEDULED");
  });
});

describe("criar agendamento", () => {
  it("consulta os horários reais (profissional + serviço + dia local), cria com 201 e atualiza a agenda", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    // só os serviços ATIVOS e vinculados ao profissional são oferecidos
    await user.selectOptions(
      within(form).getByLabelText("Profissional"),
      "Carla",
    );
    expect(
      within(within(form).getByLabelText("Serviço")).queryByRole("option", {
        name: "Barba",
      }),
    ).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText("Serviço"), "Corte");
    const radios = await within(form).findAllByRole("radio");
    expect(radios.map((r) => r.parentElement?.textContent)).toEqual([
      "11:00",
      "12:00",
    ]);
    const q = new URLSearchParams(slotCalls(s).at(-1)?.search);
    expect(Object.fromEntries(q)).toEqual({
      professionalId: "p1",
      serviceId: "s1",
      date: "2031-03-03",
    });

    await fillContact(user, form);
    await user.click(within(form).getByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));

    expect(await screen.findByText("Agendamento criado.")).toBeInTheDocument();
    expect(
      screen.queryByRole("form", { name: "Novo agendamento" }),
    ).not.toBeInTheDocument();
    const [post] = posts(s);
    expect(post?.body).toEqual({
      professionalId: "p1",
      serviceId: "s1",
      startsAt: "2031-03-03T14:00:00.000Z",
      customer: {
        name: "Joana Lima",
        phone: "(11) 98765-4321",
        email: "joana@example.com",
      },
    });
    expect(post?.headers.get("idempotency-key")).toMatch(UUID);
    // a agenda foi relida e mostra o novo agendamento no horário local correto
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Joana Lima/,
    });
    expect(within(card).getByText("11:00–11:30")).toBeInTheDocument();
    expect(apptCalls(s).length).toBeGreaterThanOrEqual(2);
  });

  it("refaz a consulta de horários quando profissional, serviço ou data mudam", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    await within(form).findAllByRole("radio");
    expect(slotCalls(s)).toHaveLength(1);

    await user.selectOptions(
      within(form).getByLabelText("Profissional"),
      "Davi",
    );
    // trocar o profissional limpa o serviço: sem serviço não há consulta
    expect(slotCalls(s)).toHaveLength(1);
    await user.selectOptions(within(form).getByLabelText("Serviço"), "Corte");
    expect(await within(form).findAllByRole("radio")).toHaveLength(1);
    expect(
      new URLSearchParams(slotCalls(s).at(-1)?.search).get("professionalId"),
    ).toBe("p2");

    fireEvent.change(within(form).getByLabelText("Data"), {
      target: { value: "2031-03-04" },
    });
    await waitFor(() => expect(slotCalls(s)).toHaveLength(3));
    expect(new URLSearchParams(slotCalls(s).at(-1)?.search).get("date")).toBe(
      "2031-03-04",
    );
  });

  it("dia sem horários livres", async () => {
    const s = state({ slots: { "p1|s1|2031-03-03": [] } });
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    expect(
      await within(form).findByText("Nenhum horário disponível neste dia."),
    ).toBeInTheDocument();
  });

  it("erro ao buscar horários mostra o erro e permite tentar de novo", async () => {
    const s = state();
    let fail = true;
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.get("*/api/availability/slots", () =>
          fail
            ? error(500, "INTERNAL_ERROR", "Falha ao buscar horários.")
            : undefined,
        ),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    expect(
      await within(form).findByText("Falha ao buscar horários."),
    ).toBeInTheDocument();
    fail = false;
    await user.click(
      within(form).getByRole("button", { name: "Tentar novamente" }),
    );
    expect(await within(form).findAllByRole("radio")).toHaveLength(2);
  });

  it("validações locais: nada é enviado sem nome, telefone, profissional, serviço e horário", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(
      await within(form).findByText("Informe o nome do cliente."),
    ).toBeInTheDocument();
    expect(within(form).getByText("Informe o telefone.")).toBeInTheDocument();
    expect(
      within(form).getByText("Escolha o profissional."),
    ).toBeInTheDocument();
    expect(within(form).getByText("Escolha o serviço.")).toBeInTheDocument();
    expect(within(form).getByText("Escolha um horário.")).toBeInTheDocument();
    expect(posts(s)).toHaveLength(0);
  });

  it("400 do servidor (telefone inválido) aparece no campo e preserva o que foi digitado", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    await user.type(within(form).getByLabelText("Nome do cliente"), "Joana");
    await user.type(within(form).getByLabelText("Telefone"), "12");
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(
      await within(form).findByText("Telefone inválido."),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText("Nome do cliente")).toHaveValue("Joana");
    expect(within(form).getByRole("radio", { name: "11:00" })).toBeChecked();
    expect(s.agenda.appointments).toHaveLength(2);
  });

  it("não envia organizationId (nem no corpo nem na query) e manda X-Active-Org em todas as chamadas", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "12:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    await screen.findByRole("button", { name: /^Remarcar Joana/ });
    const relevant = s.calls.filter((c) =>
      /^\/api\/(appointments|availability|professionals|services)/.test(c.path),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(6);
    for (const c of relevant) {
      expect(c.headers.get("x-active-org")).toBe("salao");
      expect(JSON.stringify(c.body)).not.toMatch(/organization/i);
      expect(c.search ?? "").not.toMatch(/organization/i);
    }
  });

  it("retry da mesma operação (erro de rede) reaproveita Idempotency-Key e conteúdo; uma nova operação gera outra chave", async () => {
    const s = state();
    const keys: Array<string | null> = [];
    const bodies: string[] = [];
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.post("*/api/appointments", async ({ request }) => {
          keys.push(request.headers.get("idempotency-key"));
          bodies.push(await request.clone().text());
          if (keys.length === 1) return HttpResponse.error();
        }),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(
      await within(form).findByText(/Não foi possível conectar ao servidor/),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText("Nome do cliente")).toHaveValue(
      "Joana Lima",
    );
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(s.agenda.appointments).toHaveLength(3);

    // nova operação lógica depois do sucesso: chave nova
    const form2 = await openForm(user);
    await chooseService(user, form2);
    await fillContact(user, form2);
    await user.click(
      await within(form2).findByRole("radio", { name: "12:00" }),
    );
    await user.click(within(form2).getByRole("button", { name: "Agendar" }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).toMatch(UUID);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("mudar o conteúdo depois de uma falha gera nova chave (mesma chave com outro corpo seria IDEMPOTENCY_KEY_REUSED)", async () => {
    const s = state();
    const keys: Array<string | null> = [];
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.post("*/api/appointments", ({ request }) => {
          keys.push(request.headers.get("idempotency-key"));
          if (keys.length === 1) return HttpResponse.error();
        }),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await within(form).findByText(/Não foi possível conectar/);
    await user.click(within(form).getByRole("radio", { name: "12:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    expect(keys[1]).toMatch(UUID);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("o servidor deduplica o mesmo pedido pela chave: replay devolve o mesmo agendamento (contrato do backend falso)", async () => {
    const s = state();
    const key = "11111111-2222-4333-8444-555555555555";
    const body = {
      professionalId: "p1",
      serviceId: "s1",
      startsAt: "2031-03-03T14:00:00.000Z",
      customer: { name: "Joana", phone: "11987654321" },
    };
    const send = (b: object) =>
      fetch("http://localhost/api/appointments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(b),
      });
    renderApp(s, { route: "/agenda" });
    await pro("Carla");
    const first = await send(body);
    const second = await send(body);
    expect(first.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(
      s.agenda.appointments.filter((a) => a.customer.name === "Joana"),
    ).toHaveLength(1);
    expect((await send({ ...body, serviceId: "s2" })).status).toBe(409);
  });

  it("clique duplo no botão envia UM pedido só", async () => {
    const s = state();
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.post("*/api/appointments", async () => {
          await delay(80);
        }),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.dblClick(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    expect(posts(s)).toHaveLength(1);
    expect(s.agenda.appointments).toHaveLength(3);
  });

  it("409 SLOT_UNAVAILABLE: avisa, mantém os dados de contato, relê os horários e NÃO troca de horário sozinho", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    const slotRequests = slotCalls(s).length;
    // outra pessoa pega o horário antes da submissão
    s.agenda.taken.add("p1|2031-03-03T14:00:00.000Z");
    await user.click(within(form).getByRole("button", { name: "Agendar" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "O horário escolhido não está mais disponível.",
    );
    expect(within(form).getByLabelText("Nome do cliente")).toHaveValue(
      "Joana Lima",
    );
    expect(within(form).getByLabelText("Telefone")).toHaveValue(
      "(11) 98765-4321",
    );
    expect(within(form).getByLabelText("E-mail (opcional)")).toHaveValue(
      "joana@example.com",
    );
    expect(within(form).getByLabelText("Profissional")).toHaveValue("p1");
    expect(within(form).getByLabelText("Serviço")).toHaveValue("s1");
    await waitFor(() => expect(slotCalls(s).length).toBe(slotRequests + 1));
    await waitFor(() =>
      expect(
        within(form).queryByRole("radio", { name: "11:00" }),
      ).not.toBeInTheDocument(),
    );
    const remaining = within(form).getByRole("radio", { name: "12:00" });
    expect(remaining).not.toBeChecked(); // nada foi escolhido por conta própria
    expect(posts(s)).toHaveLength(1);

    await user.click(remaining);
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    const [first, second] = posts(s);
    expect(second?.headers.get("idempotency-key")).toMatch(UUID);
    expect(second?.headers.get("idempotency-key")).not.toBe(
      first?.headers.get("idempotency-key"),
    );
    expect((second?.body as { startsAt: string }).startsAt).toBe(
      "2031-03-03T15:00:00.000Z",
    );
  });

  it("R7: horário que passou entre a escolha e o envio é bloqueado ANTES de enviar", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    vi.setSystemTime(new Date("2031-03-03T14:30:00.000Z")); // 11:30 local: o das 11:00 já passou
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(
      await within(form).findByText(
        "Esse horário já passou. Escolha outro horário.",
      ),
    ).toBeInTheDocument();
    expect(posts(s)).toHaveLength(0);
    expect(within(form).getByLabelText("Nome do cliente")).toHaveValue(
      "Joana Lima",
    );
  });

  it("R7: horários passados devolvidos pela API não são oferecidos e datas passadas não consultam horários", async () => {
    const s = state({
      slots: {
        "p1|s1|2031-03-03": [
          "2031-03-03T11:00:00.000Z",
          "2031-03-03T14:00:00.000Z",
        ], // 08:00 já passou
        "p1|s1|2031-03-02": ["2031-03-02T14:00:00.000Z"],
      },
    });
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    const radios = await within(form).findAllByRole("radio");
    expect(radios.map((r) => r.parentElement?.textContent)).toEqual(["11:00"]);

    expect(within(form).getByLabelText("Data")).toHaveAttribute(
      "min",
      "2031-03-03",
    );
    fireEvent.change(within(form).getByLabelText("Data"), {
      target: { value: "2031-03-02" },
    });
    expect(
      await within(form).findByText(
        /Escolha profissional, serviço e uma data de hoje em diante/,
      ),
    ).toBeInTheDocument();
    expect(slotCalls(s).some((c) => c.search?.includes("2031-03-02"))).toBe(
      false,
    );
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(
      await within(form).findByText(
        "Não é possível agendar em uma data passada.",
      ),
    ).toBeInTheDocument();
    expect(posts(s)).toHaveLength(0);
  });

  it("422 do servidor (passado) não quebra o formulário: mostra a mensagem, mantém os dados e permite escolher outro horário", async () => {
    const s = state();
    let reject = true;
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.post("*/api/appointments", () =>
          reject
            ? error(
                422,
                "STARTS_AT_IN_PAST",
                "Não é possível agendar no passado.",
              )
            : undefined,
        ),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Não é possível agendar no passado.",
    );
    expect(within(form).getByLabelText("Nome do cliente")).toHaveValue(
      "Joana Lima",
    );
    expect(within(form).getByRole("button", { name: "Agendar" })).toBeEnabled();
    reject = false;
    await user.click(await within(form).findByRole("radio", { name: "12:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(await screen.findByText("Agendamento criado.")).toBeInTheDocument();
  });

  it("403 do servidor é mostrado com clareza e nada é criado", async () => {
    const s = state();
    const { user } = renderApp(s, {
      route: "/agenda",
      overrides: [
        http.post("*/api/appointments", () =>
          error(403, "FORBIDDEN", "Você não tem permissão para esta ação."),
        ),
      ],
    });
    const form = await openForm(user);
    await chooseService(user, form);
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Você não tem permissão para esta ação.",
    );
    expect(screen.queryByText("Agendamento criado.")).not.toBeInTheDocument();
    expect(s.agenda.appointments).toHaveLength(2);
  });

  it("criar em outro dia leva a agenda até esse dia", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/agenda" });
    const form = await openForm(user);
    await chooseService(user, form);
    fireEvent.change(within(form).getByLabelText("Data"), {
      target: { value: "2031-03-04" },
    });
    await fillContact(user, form);
    await user.click(await within(form).findByRole("radio", { name: "10:00" }));
    await user.click(within(form).getByRole("button", { name: "Agendar" }));
    await screen.findByText("Agendamento criado.");
    expect(
      await screen.findByRole("heading", { name: /terça-feira, 04\/03\/2031/ }),
    ).toBeInTheDocument();
    expect(
      await within(await pro("Carla")).findByText("Joana Lima"),
    ).toBeInTheDocument();
  });
});

describe("remarcar", () => {
  const openReschedule = async (s: ReturnType<typeof state>) => {
    const r = renderApp(s, { route: "/agenda" });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    await r.user.click(
      within(marina).getByRole("button", { name: /^Remarcar Marina/ }),
    );
    return {
      ...r,
      form: await screen.findByRole("form", { name: "Remarcar Marina" }),
    };
  };

  it("envia startsAt e a version vista; os snapshots não mudam; a agenda é atualizada", async () => {
    const s = state();
    const { user, form } = await openReschedule(s);
    expect(within(form).getByLabelText("Nova data")).toHaveValue("2031-03-03");
    await user.click(await within(form).findByRole("radio", { name: "12:00" }));
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    expect(
      await screen.findByText("Agendamento remarcado."),
    ).toBeInTheDocument();
    const [post] = posts(s, "/api/appointments/a1/reschedule");
    expect(post?.body).toEqual({
      startsAt: "2031-03-03T15:00:00.000Z",
      version: 3,
    });
    expect(post?.headers.get("x-active-org")).toBe("salao");
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Marina/,
    });
    expect(within(card).getByText("12:00–12:30")).toBeInTheDocument();
    expect(card).toHaveTextContent("30 min + 10 min de intervalo");
    expect(card).toHaveTextContent("R$ 50,50");
  });

  it("pode trocar de profissional: envia professionalId só quando muda, e o cartão muda de grupo", async () => {
    const s = state();
    const { user, form } = await openReschedule(s);
    await user.selectOptions(
      within(form).getByLabelText("Profissional"),
      "Davi",
    );
    await user.click(await within(form).findByRole("radio", { name: "13:00" }));
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    await screen.findByText("Agendamento remarcado.");
    expect(posts(s, "/api/appointments/a1/reschedule")[0]?.body).toEqual({
      startsAt: "2031-03-03T16:00:00.000Z",
      professionalId: "p2",
      version: 3,
    });
    expect(
      await within(await pro("Davi")).findByText("Marina"),
    ).toBeInTheDocument();
    expect(
      within(await pro("Carla")).queryByText("Marina"),
    ).not.toBeInTheDocument();
  });

  it("sem escolher horário nada é enviado; 'Voltar' fecha sem enviar", async () => {
    const s = state();
    const { user, form } = await openReschedule(s);
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    expect(
      await within(form).findByText("Escolha o novo horário."),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Voltar" }));
    expect(
      screen.queryByRole("form", { name: "Remarcar Marina" }),
    ).not.toBeInTheDocument();
    expect(posts(s, /reschedule/)).toHaveLength(0);
  });

  it("409 STALE_VERSION: avisa, recarrega, não sobrescreve; uma nova tentativa usa a versão atual", async () => {
    const s = state();
    const { user, form } = await openReschedule(s);
    await user.click(await within(form).findByRole("radio", { name: "12:00" }));
    // outra sessão alterou o agendamento (versão 4, agora às 10:15 locais)
    const current = s.agenda.appointments[0]!;
    current.version = 4;
    current.startsAt = "2031-03-03T13:15:00.000Z";
    current.endsAt = "2031-03-03T13:45:00.000Z";
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );

    expect(
      await screen.findByText(/alterado em outra sessão/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Agendamento remarcado."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("form", { name: "Remarcar Marina" }),
    ).not.toBeInTheDocument();
    // os dados atuais foram recarregados e a alteração concorrente foi preservada
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Marina/,
    });
    expect(await within(card).findByText("10:15–10:45")).toBeInTheDocument();
    expect(s.agenda.appointments[0]?.startsAt).toBe("2031-03-03T13:15:00.000Z");
    expect(s.agenda.appointments[0]?.version).toBe(4);

    await user.click(
      within(card).getByRole("button", { name: /^Remarcar Marina/ }),
    );
    const form2 = await screen.findByRole("form", { name: "Remarcar Marina" });
    await user.click(
      await within(form2).findByRole("radio", { name: "12:00" }),
    );
    await user.click(
      within(form2).getByRole("button", { name: "Confirmar remarcação" }),
    );
    await screen.findByText("Agendamento remarcado.");
    expect(
      posts(s, /reschedule/).map(
        (c) => (c.body as { version: number }).version,
      ),
    ).toEqual([3, 4]);
  });

  it("409 SLOT_UNAVAILABLE ao remarcar: mantém o formulário, relê os horários e não escolhe outro sozinho", async () => {
    const s = state();
    const { user, form } = await openReschedule(s);
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    s.agenda.taken.add("p1|2031-03-03T14:00:00.000Z");
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "não está mais disponível",
    );
    await waitFor(() =>
      expect(
        within(form).queryByRole("radio", { name: "11:00" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(form).getByRole("radio", { name: "12:00" }),
    ).not.toBeChecked();
    expect(s.agenda.appointments[0]?.startsAt).toBe("2031-03-03T13:00:00.000Z");
  });

  it("422 ao remarcar para o passado é exibido sem quebrar a tela", async () => {
    const s = state();
    const { user, form } = await (async () => {
      const r = renderApp(s, {
        route: "/agenda",
        overrides: [
          http.post("*/reschedule", () =>
            error(
              422,
              "STARTS_AT_IN_PAST",
              "Não é possível agendar no passado.",
            ),
          ),
        ],
      });
      const marina = within(await pro("Carla")).getByRole("article", {
        name: /Marina/,
      });
      await r.user.click(
        within(marina).getByRole("button", { name: /^Remarcar Marina/ }),
      );
      return {
        ...r,
        form: await screen.findByRole("form", { name: "Remarcar Marina" }),
      };
    })();
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Não é possível agendar no passado.",
    );
    expect(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    ).toBeEnabled();
  });

  it("não oferece remarcar para uma data passada", async () => {
    const s = state({
      appointments: [
        makeAppointment("a1", "p1", "2031-03-01T13:00:00.000Z", {
          customer: { id: "c1", name: "Marina" },
        }),
      ],
    });
    const r = renderApp(s, { route: "/agenda" });
    await screen.findByText("Nenhum agendamento neste período."); // hoje (03/03) não tem nada
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: "2031-03-01" },
    });
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Marina/,
    });
    await r.user.click(
      within(card).getByRole("button", { name: /^Remarcar Marina/ }),
    );
    const form = await screen.findByRole("form", { name: "Remarcar Marina" });
    expect(within(form).getByLabelText("Nova data")).toHaveValue("2031-03-03"); // nunca um dia passado
  });
});

describe("remarcar com o serviço alterado depois da criação (R3)", () => {
  // Agendamento de 60 min + 10 min de intervalo (snapshot) às 10:00; o serviço hoje é 30 min sem intervalo, e há outro
  // agendamento do mesmo profissional às 11:30. Os slots (serviço atual) oferecem 11:00; o servidor, com o snapshot, recusa.
  const changed = () => {
    const s = state({
      appointments: [
        makeAppointment("a1", "p1", "2031-03-03T13:00:00.000Z", {
          customer: { id: "c1", name: "Marina" },
          service: {
            name: "Corte",
            durationMinutes: 60,
            bufferMinutes: 10,
            priceCents: 5050,
          },
        }),
        makeAppointment("b1", "p1", "2031-03-03T14:30:00.000Z", {
          customer: { id: "c2", name: "Outro" },
        }),
      ],
    });
    s.panel.services[0] = makeService("s1", "Corte", {
      durationMinutes: 30,
      bufferMinutes: 0,
      priceCents: 5050,
    });
    for (const a of s.agenda.appointments)
      s.agenda.taken.add(`${a.professionalId}|${a.startsAt}`);
    return s;
  };
  const open = async (s: ReturnType<typeof state>) => {
    const r = renderApp(s, { route: "/agenda" });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    await r.user.click(
      within(marina).getByRole("button", { name: /^Remarcar Marina/ }),
    );
    return {
      ...r,
      form: await screen.findByRole("form", { name: "Remarcar Marina" }),
    };
  };

  it("avisa que os horários usam o serviço atual, e o horário oferecido que o servidor recusa não quebra o formulário", async () => {
    const s = changed();
    const { user, form } = await open(s);
    expect(
      within(form).getByText(/mantém 60 min \+ 10 min de intervalo/),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(/serviço atual \(30 min\)/),
    ).toBeInTheDocument();
    await user.click(await within(form).findByRole("radio", { name: "11:00" }));
    await user.click(
      within(form).getByRole("button", { name: "Confirmar remarcação" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "não está mais disponível",
    );
    expect(s.agenda.appointments[0]?.startsAt).toBe("2031-03-03T13:00:00.000Z");
    expect(
      within(form).getByRole("radio", { name: "11:00" }),
    ).not.toBeChecked();
    expect(posts(s, /reschedule/)[0]?.body).toEqual({
      startsAt: "2031-03-03T14:00:00.000Z",
      version: 1,
    });
  });

  it("sem divergência (snapshot ≤ serviço atual) não há aviso; só a nota fixa sobre o próprio horário", async () => {
    const s = state();
    s.panel.services[0] = makeService("s1", "Corte", {
      durationMinutes: 45,
      bufferMinutes: 10,
    });
    const { form } = await open(s);
    expect(
      within(form).queryByText(/O servidor valida com os valores/),
    ).not.toBeInTheDocument();
    expect(within(form).getByText(/não são listados/)).toBeInTheDocument();
  });

  it("serviço desativado: explica por que não há horários", async () => {
    const s = state();
    s.panel.services[0] = makeService("s1", "Corte", { active: false });
    const { form } = await open(s);
    expect(within(form).getByText(/está desativado/)).toBeInTheDocument();
  });
});

describe("cancelar", () => {
  const openCancel = async (s: ReturnType<typeof state>) => {
    const r = renderApp(s, { route: "/agenda" });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    await r.user.click(
      within(marina).getByRole("button", { name: /^Cancelar Marina/ }),
    );
    return {
      ...r,
      group: await screen.findByRole("group", {
        name: "Confirmar cancelamento de Marina",
      }),
    };
  };

  it("pede confirmação antes de enviar e 'Voltar' desiste sem nenhuma requisição", async () => {
    const s = state();
    const { user, group } = await openCancel(s);
    expect(posts(s, /cancel/)).toHaveLength(0);
    await user.click(within(group).getByRole("button", { name: "Voltar" }));
    expect(
      screen.queryByRole("group", { name: /Confirmar cancelamento/ }),
    ).not.toBeInTheDocument();
    expect(posts(s, /cancel/)).toHaveLength(0);
    expect(s.agenda.appointments[0]?.status).toBe("SCHEDULED");
  });

  it("cancela com motivo opcional: status vira CANCELADO (sem exclusão), com a version vista", async () => {
    const s = state();
    const { user, group } = await openCancel(s);
    await user.type(
      within(group).getByLabelText("Motivo (opcional)"),
      "  Cliente desistiu  ",
    );
    await user.click(
      within(group).getByRole("button", { name: "Confirmar cancelamento" }),
    );
    expect(
      await screen.findByText("Agendamento cancelado."),
    ).toBeInTheDocument();
    const [post] = posts(s, "/api/appointments/a1/cancel");
    expect(post?.body).toEqual({ version: 3, reason: "Cliente desistiu" });
    expect(post?.headers.get("x-active-org")).toBe("salao");
    expect(
      s.calls.some(
        (c) => c.method === "DELETE" && c.path.includes("/api/appointments"),
      ),
    ).toBe(false);
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Marina/,
    });
    await waitFor(() => expect(card).toHaveTextContent("Cancelado"));
    expect(card).toHaveTextContent("Motivo: Cliente desistiu");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(s.agenda.appointments[0]).toMatchObject({
      status: "CANCELLED",
      version: 4,
      cancelReason: "Cliente desistiu",
    });
  });

  it("motivo em branco vai como null", async () => {
    const s = state();
    const { user, group } = await openCancel(s);
    await user.type(within(group).getByLabelText("Motivo (opcional)"), "   ");
    await user.click(
      within(group).getByRole("button", { name: "Confirmar cancelamento" }),
    );
    await screen.findByText("Agendamento cancelado.");
    expect(posts(s, /cancel/)[0]?.body).toEqual({ version: 3, reason: null });
  });

  it("motivo acima de 200 caracteres bloqueia o envio", async () => {
    const s = state();
    const { group } = await openCancel(s);
    fireEvent.change(within(group).getByLabelText("Motivo (opcional)"), {
      target: { value: "x".repeat(201) },
    });
    expect(within(group).getByText("Motivo muito longo.")).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: "Confirmar cancelamento" }),
    ).toBeDisabled();
  });

  it("409 STALE_VERSION ao cancelar: avisa, recarrega e NÃO cancela por cima da alteração", async () => {
    const s = state();
    const { user, group } = await openCancel(s);
    const current = s.agenda.appointments[0]!;
    current.version = 4;
    current.startsAt = "2031-03-03T16:00:00.000Z"; // remarcado em outra sessão para 13:00 locais
    current.endsAt = "2031-03-03T16:30:00.000Z";
    await user.click(
      within(group).getByRole("button", { name: "Confirmar cancelamento" }),
    );
    expect(
      await screen.findByText(/alterado em outra sessão/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Agendamento cancelado."),
    ).not.toBeInTheDocument();
    expect(s.agenda.appointments[0]?.status).toBe("SCHEDULED");
    const card = await within(await pro("Carla")).findByRole("article", {
      name: /Marina/,
    });
    expect(await within(card).findByText("13:00–13:30")).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: /Confirmar cancelamento/ }),
    ).not.toBeInTheDocument();
    // com os dados atuais, cancelar funciona e usa a nova versão
    await user.click(
      within(card).getByRole("button", { name: /^Cancelar Marina/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Confirmar cancelamento" }),
    );
    await screen.findByText("Agendamento cancelado.");
    expect(
      posts(s, /cancel/).map((c) => (c.body as { version: number }).version),
    ).toEqual([3, 4]);
  });

  it("clique duplo em confirmar cancela uma vez só", async () => {
    const s = state();
    const { user, group } = await openCancel(s);
    await user.dblClick(
      within(group).getByRole("button", { name: "Confirmar cancelamento" }),
    );
    await screen.findByText("Agendamento cancelado.");
    expect(posts(s, /cancel/)).toHaveLength(1);
  });

  it("erro de rede ao cancelar: mostra o erro e nada muda", async () => {
    const s = state();
    const r = renderApp(s, {
      route: "/agenda",
      overrides: [http.post("*/cancel", () => HttpResponse.error())],
    });
    const marina = within(await pro("Carla")).getByRole("article", {
      name: /Marina/,
    });
    await r.user.click(
      within(marina).getByRole("button", { name: /^Cancelar Marina/ }),
    );
    await r.user.click(
      await screen.findByRole("button", { name: "Confirmar cancelamento" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Não foi possível conectar/,
    );
    expect(
      screen.queryByText("Agendamento cancelado."),
    ).not.toBeInTheDocument();
    expect(s.agenda.appointments[0]?.status).toBe("SCHEDULED");
  });
});

describe("agenda (utilitários de data)", () => {
  it("semana de segunda a domingo e aritmética de calendário", () => {
    expect(weekStart("2031-03-09")).toBe("2031-03-03"); // domingo pertence à semana que começou na segunda
    expect(weekStart("2031-03-03")).toBe("2031-03-03");
    expect(visibleDays("week", "2031-03-05")).toEqual([
      "2031-03-03",
      "2031-03-04",
      "2031-03-05",
      "2031-03-06",
      "2031-03-07",
      "2031-03-08",
      "2031-03-09",
    ]);
    expect(addDays("2031-02-28", 1)).toBe("2031-03-01");
    expect(addDays("2032-02-28", 1)).toBe("2032-02-29");
    expect(addDays("2031-01-01", -1)).toBe("2030-12-31");
  });

  it("o intervalo consultado respeita o limite de 93 dias da API em qualquer fuso", () => {
    for (const tz of [
      "America/Sao_Paulo",
      "America/New_York",
      "Australia/Lord_Howe",
      "Pacific/Kiritimati",
    ]) {
      for (const view of ["day", "week"] as const) {
        const { from, to } = rangeUtc(view, "2031-03-09", tz);
        const days =
          (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(view === "day" ? 0.9 : 6.9);
        expect(days).toBeLessThanOrEqual(8);
      }
    }
  });

  it("meia-noite inexistente (horário de verão): o dia começa no primeiro horário que existe", () => {
    // Em 04/11/2018 o relógio de São Paulo pulou de 00:00 para 01:00 (-02:00): o dia começa às 03:00Z.
    expect(rangeUtc("day", "2018-11-04", "America/Sao_Paulo")).toEqual({
      from: "2018-11-04T03:00:00.000Z",
      to: "2018-11-05T02:00:00.000Z",
    });
  });
});
