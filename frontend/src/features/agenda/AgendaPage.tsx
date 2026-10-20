import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiContext";
import type {
  ApiAppointment,
  ApiProfessional,
  ApiService,
} from "../../api/types";
import { Alert, Field, Loading } from "../../components/ui";
import { useResource } from "../../hooks/useResource";
import {
  addDays,
  formatDayHeading,
  formatLocalDate,
  isLocalDate,
  localDateOf,
  rangeUtc,
  todayIn,
  visibleDays,
  type AgendaView,
} from "../../lib/agenda";
import { useOrganizations } from "../organizations/OrganizationContext";
import { AppointmentCard } from "./AppointmentCard";
import { NewAppointmentForm } from "./NewAppointmentForm";

/** Teto de itens de uma listagem no servidor (`listMax`): se vier cheia, a lista pode estar incompleta. */
const LIST_MAX = 500;

export function AgendaPage() {
  const { active } = useOrganizations();
  // A timezone é SEMPRE a da empresa ativa já validada pelo servidor (imutável, R9), nunca a do navegador.
  if (!active) return <Loading />;
  return <Agenda timeZone={active.timezone} />;
}

function Agenda({ timeZone }: { timeZone: string }) {
  const api = useApi();
  const [view, setView] = useState<AgendaView>("day");
  const [date, setDate] = useState(() => todayIn(timeZone));
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const refs = useResource(
    async (signal) => {
      const [p, s] = await Promise.all([
        api.request<{ professionals: ApiProfessional[] }>(
          "GET",
          "/api/professionals",
          { signal },
        ),
        api.request<{ services: ApiService[] }>("GET", "/api/services", {
          signal,
        }),
      ]);
      return { professionals: p.professionals, services: s.services };
    },
    [api],
  );

  const { from, to } = rangeUtc(view, date, timeZone);
  const appts = useResource(
    async (signal) => {
      const query = new URLSearchParams({ from, to });
      return (
        await api.request<{ appointments: ApiAppointment[] }>(
          "GET",
          `/api/appointments?${query.toString()}`,
          { signal },
        )
      ).appointments;
    },
    [api, from, to],
  );

  const step = view === "day" ? 1 : 7;
  const days = visibleDays(view, date);
  const heading =
    view === "day"
      ? formatLocalDate(date)
      : `${formatLocalDate(days[0] as string)} a ${formatLocalDate(days[6] as string)}`;

  function refresh() {
    appts.reload();
  }

  return (
    <section className="page agenda" aria-label="Agenda">
      <h1>Agenda</h1>
      <div className="agenda-toolbar">
        <div role="group" aria-label="Visualização" className="segmented">
          <button
            type="button"
            className="button"
            aria-pressed={view === "day"}
            onClick={() => setView("day")}
          >
            Dia
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={view === "week"}
            onClick={() => setView("week")}
          >
            Semana
          </button>
        </div>
        <div role="group" aria-label="Navegação de datas" className="segmented">
          <button
            type="button"
            className="button"
            onClick={() => setDate(addDays(date, -step))}
          >
            Anterior
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setDate(todayIn(timeZone))}
          >
            Hoje
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setDate(addDays(date, step))}
          >
            Próximo
          </button>
        </div>
        <Field
          id="agenda-date"
          label="Data"
          type="date"
          value={date}
          onChange={(e) => {
            if (isLocalDate(e.target.value)) setDate(e.target.value);
          }}
        />
        <button type="button" className="button" onClick={refresh}>
          Atualizar
        </button>
        <button
          type="button"
          className="button primary-inline"
          onClick={() => {
            setNotice(null);
            setCreating((v) => !v);
          }}
          aria-expanded={creating}
        >
          Novo agendamento
        </button>
      </div>
      <h2 className="agenda-heading" aria-live="polite">
        {heading}
      </h2>
      <p className="muted">Horários na hora local da empresa ({timeZone}).</p>

      {notice && <Alert kind="success">{notice}</Alert>}
      {warning && <Alert kind="info">{warning}</Alert>}

      {creating && refs.resource.status === "ready" && (
        <NewAppointmentForm
          professionals={refs.resource.data.professionals}
          services={refs.resource.data.services}
          timeZone={timeZone}
          defaultDate={date}
          onCancel={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setWarning(null);
            setNotice("Agendamento criado.");
            // Leva a agenda ao dia do novo agendamento quando ele cai fora do período exibido.
            const day = localDateOf(a.startsAt, timeZone);
            if (!visibleDays(view, date).includes(day)) setDate(day);
            else refresh();
          }}
        />
      )}

      {refs.resource.status === "loading" && <Loading />}
      {refs.resource.status === "error" && (
        <>
          <Alert kind="error">{refs.resource.message}</Alert>
          <button type="button" className="button" onClick={refs.reload}>
            Tentar novamente
          </button>
        </>
      )}
      {refs.resource.status === "ready" &&
        appts.resource.status === "loading" && (
          <Loading label="Carregando agendamentos…" />
        )}
      {refs.resource.status === "ready" &&
        appts.resource.status === "error" && (
          <>
            <Alert kind="error">{appts.resource.message}</Alert>
            <button type="button" className="button" onClick={appts.reload}>
              Tentar novamente
            </button>
          </>
        )}
      {refs.resource.status === "ready" &&
        appts.resource.status === "ready" && (
          <AgendaBody
            view={view}
            days={days}
            timeZone={timeZone}
            professionals={refs.resource.data.professionals}
            services={refs.resource.data.services}
            appointments={appts.resource.data}
            onChanged={(message) => {
              setWarning(null);
              setNotice(message);
              refresh();
            }}
            onStale={() => {
              setNotice(null);
              setWarning(
                "Este agendamento foi alterado em outra sessão. Os dados foram recarregados; confira e tente novamente.",
              );
              refresh();
            }}
          />
        )}
    </section>
  );
}

function AgendaBody({
  view,
  days,
  timeZone,
  professionals,
  services,
  appointments,
  onChanged,
  onStale,
}: {
  view: AgendaView;
  days: string[];
  timeZone: string;
  professionals: ApiProfessional[];
  services: ApiService[];
  appointments: ApiAppointment[];
  onChanged: (message: string) => void;
  onStale: () => void;
}) {
  if (professionals.length === 0)
    return (
      <p>
        Cadastre um profissional em{" "}
        <Link to="/profissionais">Profissionais</Link> para usar a agenda.
      </p>
    );
  const truncated = appointments.length >= LIST_MAX;
  if (appointments.length === 0)
    return <p className="empty">Nenhum agendamento neste período.</p>;

  // Dia local de cada agendamento; um que começou antes do período (e ainda o atravessa) aparece no primeiro dia exibido.
  const dayOf = (a: ApiAppointment) => {
    const d = localDateOf(a.startsAt, timeZone);
    return days.includes(d) ? d : (days[0] as string);
  };
  const known = new Set(professionals.map((p) => p.id));
  const groups = [
    ...professionals.filter(
      (p) => p.active || appointments.some((a) => a.professionalId === p.id),
    ),
  ];
  const orphans = appointments.filter((a) => !known.has(a.professionalId));

  const renderDay = (day: string, list: ApiAppointment[]) => (
    <ul className="appt-list" aria-label={formatDayHeading(day)}>
      {list.map((a) => (
        <AppointmentCard
          key={a.id}
          appointment={a}
          professionals={professionals}
          services={services}
          timeZone={timeZone}
          shownDate={day}
          onChanged={onChanged}
          onStale={onStale}
        />
      ))}
    </ul>
  );

  return (
    <>
      {truncated && (
        <Alert kind="info">
          Mostrando os {LIST_MAX} primeiros agendamentos do período; os mais
          tardios podem estar ocultos (a API não pagina nem informa o total).
          Reduza o período (visão diária) para ver todos.
        </Alert>
      )}
      {groups.map((p) => {
        const mine = appointments.filter((a) => a.professionalId === p.id);
        return (
          <section
            key={p.id}
            className="agenda-pro"
            aria-label={`Agenda de ${p.name}`}
          >
            <h3>
              {p.name}
              {!p.active && <span className="muted"> (inativo)</span>}
            </h3>
            {view === "day" ? (
              mine.length === 0 ? (
                <p className="muted">Sem agendamentos neste dia.</p>
              ) : (
                renderDay(days[0] as string, mine)
              )
            ) : (
              <div className="week-grid">
                {days.map((day) => {
                  const list = mine.filter((a) => dayOf(a) === day);
                  return (
                    <section
                      key={day}
                      className="week-day"
                      aria-label={`${formatDayHeading(day)} — ${p.name}`}
                    >
                      <h4>{formatDayHeading(day)}</h4>
                      {list.length === 0 ? (
                        <p className="muted">—</p>
                      ) : (
                        renderDay(day, list)
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      {orphans.length > 0 && (
        <section className="agenda-pro" aria-label="Outros profissionais">
          <h3>Outros profissionais</h3>
          {renderDay(days[0] as string, orphans)}
        </section>
      )}
    </>
  );
}
