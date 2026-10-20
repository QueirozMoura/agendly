// Horário de trabalho e folgas (Etapa 12), incluindo a recusa R4 com a lista de agendamentos afetados.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ConflictDetails } from "../api/types";
import {
  makeHours,
  makeProfessional,
  makeService,
  makeTimeOff,
} from "./fakePanel";
import { callsTo, panelState } from "./panelHelpers";
import { renderApp } from "./render";

const PRO = makeProfessional("p1", "Carla");
const state = (extra = {}, tz?: string) =>
  panelState(
    { services: [makeService("s1", "Corte")], professionals: [PRO], ...extra },
    tz,
  );
const hoursRegion = () =>
  screen.findByRole("region", { name: "Horário de trabalho" });
const offRegion = () => screen.findByRole("region", { name: "Folgas" });

const conflict = (
  n: number,
  total = n,
  truncated = false,
): ConflictDetails => ({
  conflicts: Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    startsAt: `2031-03-0${3 + i}T13:00:00.000Z`,
    endsAt: `2031-03-0${3 + i}T13:30:00.000Z`,
    status: i % 2 === 0 ? "SCHEDULED" : "CONFIRMED",
    customer: { id: `c${i}`, name: `Cliente ${i + 1}` },
    serviceName: "Corte",
  })),
  totalCount: total,
  truncated,
});

describe("horário de trabalho", () => {
  it("agrupa por dia da semana, em ordem; dias sem expediente e estado vazio", async () => {
    const s = state({
      workingHours: [
        makeHours("w2", "p1", 1, "13:00", "18:00"),
        makeHours("w1", "p1", 1, "08:00", "12:00"),
        makeHours("w3", "p1", 6, "08:00", "12:30"),
      ],
    });
    renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    const week = await within(region).findByRole("list", {
      name: "Expediente por dia da semana",
    });
    const monday = within(week)
      .getByText("Segunda-feira")
      .closest("li") as HTMLElement;
    expect(monday.textContent?.indexOf("08:00 às 12:00")).toBeLessThan(
      monday.textContent?.indexOf("13:00 às 18:00") ?? 0,
    );
    expect(within(week).getByText("Sábado").closest("li")).toHaveTextContent(
      "08:00 às 12:30",
    );
    expect(within(week).getByText("Domingo").closest("li")).toHaveTextContent(
      "sem expediente",
    );
    expect(
      within(region).getByText(
        /Horários na hora local da empresa \(America\/Sao_Paulo\)/,
      ),
    ).toBeInTheDocument();
  });

  it("sem nenhum horário: avisa que o profissional não terá horários disponíveis", async () => {
    renderApp(state(), { route: "/profissionais/p1" });
    expect(
      await within(await hoursRegion()).findByText(/Nenhum horário cadastrado/),
    ).toBeInTheDocument();
  });

  it("adicionar: envia dia, início e fim (padrão seg 09:00–18:00) e mostra o intervalo devolvido pelo servidor", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.selectOptions(
      await within(region).findByLabelText("Adicionar horário: dia da semana"),
      "3",
    );
    await user.selectOptions(
      within(region).getByLabelText("Adicionar horário: início"),
      "08:15",
    );
    await user.selectOptions(
      within(region).getByLabelText("Adicionar horário: fim"),
      "24:00",
    );
    await user.click(
      within(region).getByRole("button", { name: "Adicionar horário" }),
    );
    expect(
      await within(region).findByText("Horário adicionado."),
    ).toBeInTheDocument();
    expect(callsTo(s, "POST", "/api/working-hours")[0]?.body).toEqual({
      professionalId: "p1",
      weekday: 3,
      startTime: "08:15",
      endTime: "24:00",
    });
    const week = within(region).getByRole("list", {
      name: "Expediente por dia da semana",
    });
    await waitFor(() =>
      expect(
        within(week).getByText("Quarta-feira").closest("li"),
      ).toHaveTextContent("08:15 às 24:00"),
    );
  });

  it("início igual ou depois do fim: erro local, sem requisição", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.selectOptions(
      await within(region).findByLabelText("Adicionar horário: início"),
      "18:00",
    );
    await user.selectOptions(
      within(region).getByLabelText("Adicionar horário: fim"),
      "18:00",
    );
    await user.click(
      within(region).getByRole("button", { name: "Adicionar horário" }),
    );
    expect(within(region).getByRole("alert")).toHaveTextContent(
      "O início deve ser anterior ao fim.",
    );
    expect(callsTo(s, "POST", "/api/working-hours")).toHaveLength(0);
  });

  it("sobreposição no mesmo dia: mostra a mensagem do servidor e não altera a lista", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "12:00")],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.selectOptions(
      await within(region).findByLabelText("Adicionar horário: início"),
      "11:00",
    );
    await user.selectOptions(
      within(region).getByLabelText("Adicionar horário: fim"),
      "13:00",
    );
    await user.click(
      within(region).getByRole("button", { name: "Adicionar horário" }),
    );
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "O intervalo se sobrepõe a outro do mesmo dia.",
    );
    expect(s.panel.workingHours).toHaveLength(1);
  });

  it("editar um intervalo envia o PATCH; cancelar a edição não envia nada", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "12:00")],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Editar Segunda-feira 09:00 às 12:00",
      }),
    );
    await user.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(callsTo(s, "PATCH", /working-hours/)).toHaveLength(0);
    await user.click(
      within(region).getByRole("button", {
        name: "Editar Segunda-feira 09:00 às 12:00",
      }),
    );
    await user.selectOptions(
      within(region).getByLabelText("Editar horário: fim"),
      "12:30",
    );
    await user.click(
      within(region).getByRole("button", { name: "Salvar horário" }),
    );
    expect(
      await within(region).findByText("Horário atualizado."),
    ).toBeInTheDocument();
    expect(callsTo(s, "PATCH", "/api/working-hours/w1")[0]?.body).toEqual({
      weekday: 1,
      startTime: "09:00",
      endTime: "12:30",
    });
    await waitFor(() =>
      expect(within(region).getByText("09:00 às 12:30")).toBeInTheDocument(),
    );
  });

  it("remover exige confirmação (Cancelar desiste); confirmar envia DELETE e some da lista", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 2, "09:00", "12:00")],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Remover Terça-feira 09:00 às 12:00",
      }),
    );
    await user.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(callsTo(s, "DELETE", /working-hours/)).toHaveLength(0);
    await user.click(
      within(region).getByRole("button", {
        name: "Remover Terça-feira 09:00 às 12:00",
      }),
    );
    await user.click(
      within(region).getByRole("button", { name: "Confirmar remoção" }),
    );
    expect(
      await within(region).findByText("Intervalo removido."),
    ).toBeInTheDocument();
    expect(callsTo(s, "DELETE", "/api/working-hours/w1")).toHaveLength(1);
    await waitFor(() =>
      expect(
        within(region).queryByText("09:00 às 12:00"),
      ).not.toBeInTheDocument(),
    );
  });

  it("R4 ao ALTERAR: recusa com a lista de agendamentos afetados, nada muda e o usuário pode tentar de novo", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "18:00")],
      conflicts: conflict(2),
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Editar Segunda-feira 09:00 às 18:00",
      }),
    );
    await user.selectOptions(
      within(region).getByLabelText("Editar horário: fim"),
      "12:00",
    );
    await user.click(
      within(region).getByRole("button", { name: "Salvar horário" }),
    );
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(
      "A alteração do horário não foi salva: ela afeta 2 agendamentos ativos.",
    );
    expect(alert).toHaveTextContent(
      "Nada foi alterado e nenhum agendamento foi cancelado.",
    );
    const list = within(alert).getByRole("list", {
      name: "Agendamentos afetados",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Cliente 1");
    expect(list).toHaveTextContent("Corte");
    expect(list).toHaveTextContent("10:00"); // 13:00Z em São Paulo
    expect(list).toHaveTextContent("Agendado");
    expect(list).toHaveTextContent("Confirmado");
    expect(s.panel.workingHours[0]?.endTime).toBe("18:00"); // nada foi alterado
    expect(screen.queryByText("Horário atualizado.")).not.toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: "Salvar horário" }),
    ).toBeEnabled();
  });

  it("R4 ao REMOVER: mostra o conflito (singular) e o intervalo continua na lista", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "18:00")],
      conflicts: conflict(1),
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Remover Segunda-feira 09:00 às 18:00",
      }),
    );
    await user.click(
      within(region).getByRole("button", { name: "Confirmar remoção" }),
    );
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(
      "A remoção não foi salva: ela afeta 1 agendamento ativo.",
    );
    expect(alert).toHaveTextContent("esse agendamento");
    expect(within(region).getByText("09:00 às 18:00")).toBeInTheDocument();
    expect(s.panel.workingHours).toHaveLength(1);
  });

  it("R4 com lista PARCIAL: mostra o total real e que só os primeiros foram listados (nunca como se fosse completa)", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "18:00")],
      conflicts: conflict(3, 130, true),
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Remover Segunda-feira 09:00 às 18:00",
      }),
    );
    await user.click(
      within(region).getByRole("button", { name: "Confirmar remoção" }),
    );
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent("ela afeta 130 agendamentos ativos");
    expect(alert).toHaveTextContent("Mostrando os 3 primeiros de 130.");
    expect(alert).toHaveTextContent("repita a alteração para ver os demais");
  });

  it("conflito com formato de detalhes inesperado cai na mensagem genérica do servidor (não quebra a tela)", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "18:00")],
    });
    const { user } = renderApp(s, {
      route: "/profissionais/p1",
      overrides: [
        http.delete("*/api/working-hours/w1", () =>
          HttpResponse.json(
            {
              error: {
                code: "WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS",
                message: "Conflito com agendamentos ativos.",
                details: "lixo",
                requestId: "r",
              },
            },
            { status: 409 },
          ),
        ),
      ],
    });
    const region = await hoursRegion();
    await user.click(
      await within(region).findByRole("button", {
        name: "Remover Segunda-feira 09:00 às 18:00",
      }),
    );
    await user.click(
      within(region).getByRole("button", { name: "Confirmar remoção" }),
    );
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "Conflito com agendamentos ativos.",
    );
    expect(
      within(region).queryByRole("list", { name: "Agendamentos afetados" }),
    ).not.toBeInTheDocument();
  });

  it("erro ao carregar o expediente: erro + tentar novamente dentro da seção (o resto da página continua)", async () => {
    const s = state();
    let failures = 1;
    const { user } = renderApp(s, {
      route: "/profissionais/p1",
      overrides: [
        http.get("*/api/working-hours", () =>
          failures-- > 0
            ? HttpResponse.json(
                {
                  error: {
                    code: "TEMPORARILY_BUSY",
                    message:
                      "O sistema está ocupado. Tente novamente em instantes.",
                    requestId: "r",
                  },
                },
                { status: 503 },
              )
            : HttpResponse.json({ workingHours: [] }),
        ),
      ],
    });
    const region = await hoursRegion();
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "O sistema está ocupado.",
    );
    expect(
      within(region).queryByText(/Nenhum horário cadastrado/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Carla" })).toBeInTheDocument();
    await user.click(
      within(region).getByRole("button", { name: "Tentar novamente" }),
    );
    expect(
      await within(region).findByText(/Nenhum horário cadastrado/),
    ).toBeInTheDocument();
  });
});

const setLocal = (label: string, value: string, scope: HTMLElement) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

describe("folgas", () => {
  it("lista na timezone da empresa, com motivo; estado vazio", async () => {
    const s = state({
      timeOff: [
        makeTimeOff(
          "o1",
          "p1",
          "2031-03-03T13:00:00.000Z",
          "2031-03-03T15:30:00.000Z",
          "Consulta médica",
        ),
      ],
    });
    const { unmount } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    const list = await within(region).findByRole("list", {
      name: "Folgas cadastradas",
    });
    expect(list).toHaveTextContent("03/03/2031 10:00");
    expect(list).toHaveTextContent("03/03/2031 12:30");
    expect(list).toHaveTextContent("Consulta médica");
    unmount();
    renderApp(state(), { route: "/profissionais/p1" });
    expect(
      await within(await offRegion()).findByText("Nenhuma folga cadastrada."),
    ).toBeInTheDocument();
  });

  it("adicionar: converte a hora LOCAL da empresa para UTC (São Paulo é UTC-3) e normaliza o motivo", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    const form = await within(region).findByRole("form", {
      name: "Adicionar folga",
    });
    setLocal("Início", "2031-03-03T10:00", form);
    setLocal("Fim", "2031-03-03T12:00", form);
    await user.type(
      within(form).getByLabelText("Motivo (opcional)"),
      "  Dentista ",
    );
    await user.click(
      within(form).getByRole("button", { name: "Adicionar folga" }),
    );
    expect(
      await within(region).findByText("Folga adicionada."),
    ).toBeInTheDocument();
    expect(callsTo(s, "POST", "/api/time-off")[0]?.body).toEqual({
      professionalId: "p1",
      startsAt: "2031-03-03T13:00:00.000Z",
      endsAt: "2031-03-03T15:00:00.000Z",
      reason: "Dentista",
    });
    // depois de criar, o formulário volta ao estado vazio (pronto para a próxima folga)
    expect(within(form).getByLabelText("Início")).toHaveValue("");
    expect(within(form).getByLabelText("Fim")).toHaveValue("");
    expect(within(form).getByLabelText("Motivo (opcional)")).toHaveValue("");
  });

  it("usa a timezone da EMPRESA, não a do navegador: em Nova York (inverno, UTC-5) 10:00 vira 15:00Z; horário inexistente é recusado", async () => {
    const s = state({}, "America/New_York");
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    const form = await within(region).findByRole("form", {
      name: "Adicionar folga",
    });
    setLocal("Início", "2030-01-15T10:00", form);
    setLocal("Fim", "2030-01-15T11:00", form);
    await user.click(
      within(form).getByRole("button", { name: "Adicionar folga" }),
    );
    await within(region).findByText("Folga adicionada.");
    expect(callsTo(s, "POST", "/api/time-off")[0]?.body).toMatchObject({
      startsAt: "2030-01-15T15:00:00.000Z",
      endsAt: "2030-01-15T16:00:00.000Z",
      reason: null,
    });
    // lacuna do horário de verão (10/03/2030 02:30 não existe em Nova York)
    const form2 = within(region).getByRole("form", { name: "Adicionar folga" });
    setLocal("Início", "2030-03-10T02:30", form2);
    setLocal("Fim", "2030-03-10T04:00", form2);
    await user.click(
      within(form2).getByRole("button", { name: "Adicionar folga" }),
    );
    expect(within(form2).getByLabelText("Início")).toHaveAccessibleDescription(
      expect.stringContaining("Esse horário não existe nesse dia"),
    );
    expect(callsTo(s, "POST", "/api/time-off")).toHaveLength(1);
  });

  it.each([
    ["sem início", "", "2031-03-03T12:00", "", "Início", "Informe o início."],
    ["sem fim", "2031-03-03T10:00", "", "", "Fim", "Informe o fim."],
    [
      "fim igual ao início",
      "2031-03-03T10:00",
      "2031-03-03T10:00",
      "",
      "Fim",
      "O fim deve ser posterior ao início.",
    ],
    [
      "fim antes do início",
      "2031-03-03T10:00",
      "2031-03-03T09:00",
      "",
      "Fim",
      "O fim deve ser posterior ao início.",
    ],
    [
      "motivo longo",
      "2031-03-03T10:00",
      "2031-03-03T12:00",
      "x".repeat(201),
      "Motivo (opcional)",
      "Motivo muito longo.",
    ],
  ])(
    "validação local (%s): erro no campo e nenhuma requisição",
    async (_n, start, end, reason, label, message) => {
      const s = state();
      const { user } = renderApp(s, { route: "/profissionais/p1" });
      const form = await within(await offRegion()).findByRole("form", {
        name: "Adicionar folga",
      });
      if (start) setLocal("Início", start, form);
      if (end) setLocal("Fim", end, form);
      if (reason)
        fireEvent.change(within(form).getByLabelText("Motivo (opcional)"), {
          target: { value: reason },
        });
      await user.click(
        within(form).getByRole("button", { name: "Adicionar folga" }),
      );
      expect(within(form).getByLabelText(label)).toHaveAccessibleDescription(
        expect.stringContaining(message),
      );
      expect(callsTo(s, "POST", "/api/time-off")).toHaveLength(0);
    },
  );

  it("editar preenche com a hora local, envia o PATCH em UTC e mostra o resultado", async () => {
    const s = state({
      timeOff: [
        makeTimeOff(
          "o1",
          "p1",
          "2031-03-03T13:00:00.000Z",
          "2031-03-03T15:00:00.000Z",
          "Dentista",
        ),
      ],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    await user.click(
      await within(region).findByRole("button", { name: /Editar folga de/ }),
    );
    const form = within(region).getByRole("form", { name: "Editar folga" });
    expect(within(form).getByLabelText("Início")).toHaveValue(
      "2031-03-03T10:00",
    );
    expect(within(form).getByLabelText("Fim")).toHaveValue("2031-03-03T12:00");
    expect(within(form).getByLabelText("Motivo (opcional)")).toHaveValue(
      "Dentista",
    );
    setLocal("Fim", "2031-03-03T13:00", form);
    await user.click(
      within(form).getByRole("button", { name: "Salvar folga" }),
    );
    expect(
      await within(region).findByText("Folga atualizada."),
    ).toBeInTheDocument();
    expect(callsTo(s, "PATCH", "/api/time-off/o1")[0]?.body).toEqual({
      startsAt: "2031-03-03T13:00:00.000Z",
      endsAt: "2031-03-03T16:00:00.000Z",
      reason: "Dentista",
    });
  });

  it("remover com confirmação", async () => {
    const s = state({
      timeOff: [
        makeTimeOff(
          "o1",
          "p1",
          "2031-03-03T13:00:00.000Z",
          "2031-03-03T15:00:00.000Z",
        ),
      ],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    await user.click(
      await within(region).findByRole("button", { name: /Remover folga de/ }),
    );
    await user.click(
      within(region).getByRole("button", { name: "Confirmar remoção" }),
    );
    expect(
      await within(region).findByText("Folga removida."),
    ).toBeInTheDocument();
    expect(callsTo(s, "DELETE", "/api/time-off/o1")).toHaveLength(1);
    await waitFor(() =>
      expect(
        within(region).getByText("Nenhuma folga cadastrada."),
      ).toBeInTheDocument(),
    );
  });

  it("R4: folga que cobre agendamentos ativos é RECUSADA com a lista; nada é criado nem cancelado", async () => {
    const s = state({ conflicts: conflict(2) });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    const form = await within(region).findByRole("form", {
      name: "Adicionar folga",
    });
    setLocal("Início", "2031-03-03T09:00", form);
    setLocal("Fim", "2031-03-03T18:00", form);
    await user.click(
      within(form).getByRole("button", { name: "Adicionar folga" }),
    );
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent(
      "A folga não foi salva: ela afeta 2 agendamentos ativos.",
    );
    expect(alert).toHaveTextContent(
      "Nada foi alterado e nenhum agendamento foi cancelado.",
    );
    expect(
      within(alert).getByRole("list", { name: "Agendamentos afetados" }),
    ).toHaveTextContent("Cliente 2");
    expect(s.panel.timeOff).toHaveLength(0);
    expect(
      within(region).queryByText("Folga adicionada."),
    ).not.toBeInTheDocument();
    expect(within(form).getByLabelText("Início")).toHaveValue(
      "2031-03-03T09:00",
    ); // o que o usuário digitou permanece
    // depois de resolver os conflitos, a MESMA tentativa funciona
    s.panel.conflicts = null;
    await user.click(
      within(form).getByRole("button", { name: "Adicionar folga" }),
    );
    expect(
      await within(region).findByText("Folga adicionada."),
    ).toBeInTheDocument();
    expect(s.panel.timeOff).toHaveLength(1);
  });

  it("R4 ao editar uma folga existente: recusada e a folga continua como estava", async () => {
    const s = state({
      timeOff: [
        makeTimeOff(
          "o1",
          "p1",
          "2031-03-03T13:00:00.000Z",
          "2031-03-03T15:00:00.000Z",
        ),
      ],
      conflicts: conflict(1),
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    const region = await offRegion();
    await user.click(
      await within(region).findByRole("button", { name: /Editar folga de/ }),
    );
    const form = within(region).getByRole("form", { name: "Editar folga" });
    setLocal("Início", "2031-03-03T08:00", form);
    await user.click(
      within(form).getByRole("button", { name: "Salvar folga" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "ela afeta 1 agendamento ativo",
    );
    expect(s.panel.timeOff[0]?.startsAt).toBe("2031-03-03T13:00:00.000Z");
  });

  it("erro ao carregar as folgas: erro + tentar novamente na seção, nunca 'nenhuma folga'", async () => {
    const s = state();
    renderApp(s, {
      route: "/profissionais/p1",
      overrides: [http.get("*/api/time-off", () => HttpResponse.error())],
    });
    const region = await offRegion();
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "Não foi possível conectar ao servidor.",
    );
    expect(
      within(region).queryByText("Nenhuma folga cadastrada."),
    ).not.toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: "Tentar novamente" }),
    ).toBeInTheDocument();
  });
});

describe("isolamento e sessão", () => {
  it("todas as chamadas do painel levam X-Active-Org e nunca enviam organizationId", async () => {
    const s = state({
      workingHours: [makeHours("w1", "p1", 1, "09:00", "12:00")],
    });
    const { user } = renderApp(s, { route: "/profissionais/p1" });
    await within(await hoursRegion()).findByText("09:00 às 12:00");
    await user.click(screen.getByRole("checkbox", { name: "Corte" }));
    await user.click(screen.getByRole("button", { name: /Salvar serviços/ }));
    await screen.findByText("Serviços atualizados.");
    const panelCalls = s.calls.filter((c) =>
      /^\/api\/(services|professionals|working-hours|time-off)/.test(c.path),
    );
    expect(panelCalls.length).toBeGreaterThan(3);
    for (const c of panelCalls) {
      expect(c.headers.get("x-active-org"), `${c.method} ${c.path}`).toBe(
        "salao",
      );
      expect(JSON.stringify(c.body ?? {})).not.toMatch(/organization/i);
    }
  });

  it("401 no meio do painel: volta ao login com o aviso e sem mostrar o erro cru", async () => {
    const s = state({ services: [makeService("s1", "Corte")] });
    const { user } = renderApp(s, { route: "/servicos" });
    await screen.findByText("Corte");
    s.user = null; // a sessão acabou
    await user.click(screen.getByRole("button", { name: "Desativar Corte" }));
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

  it("navegação: menu principal com Serviços e Profissionais, com a página atual indicada", async () => {
    const s = state();
    const { user } = renderApp(s, { route: "/servicos" });
    const nav = await screen.findByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Serviços" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(nav).getByRole("link", { name: "Profissionais" }));
    expect(
      await screen.findByRole("heading", { name: "Profissionais" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Profissionais" }),
    ).toHaveAttribute("aria-current", "page");
  });
});
