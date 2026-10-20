/**
 * Representação ESTÁTICA da agenda do painel (visão do dia, agrupada por profissional), só com elementos que existem
 * na tela real (`features/agenda`): alternância Dia/Semana, horários, nome do cliente, serviço com duração, intervalo e
 * preço, e os status Agendado/Confirmado/Cancelado. Os dados são fictícios e a própria figura avisa. Não chama a API
 * e não tem controles: é ilustração, então fica fora da ordem de tabulação e do leitor de tela (a descrição está no
 * rótulo da figura).
 */
const EXEMPLOS = [
  {
    time: "09:00–09:30",
    status: "Agendado",
    tone: "scheduled",
    customer: "Cliente A",
    detail: "Serviço 1 · 30 min",
  },
  {
    time: "10:00–10:50",
    status: "Confirmado",
    tone: "confirmed",
    customer: "Cliente B",
    detail: "Serviço 2 · 40 min + 10 min de intervalo · R$\u00a080,00",
  },
  {
    time: "11:30–12:00",
    status: "Cancelado",
    tone: "cancelled",
    customer: "Cliente C",
    detail: "Serviço 1 · 30 min",
  },
] as const;

export function AgendaPreview() {
  return (
    <figure
      className="landing-preview"
      role="img"
      aria-label="Exemplo ilustrativo da agenda do Agendly: visão do dia com horários de um profissional, cada um com cliente, serviço e status."
    >
      <div aria-hidden="true">
        <div className="landing-preview-bar">
          <span className="landing-preview-title">Agenda</span>
          <span className="landing-preview-segmented">
            <span className="landing-preview-seg is-on">Dia</span>
            <span className="landing-preview-seg">Semana</span>
          </span>
        </div>
        <div className="landing-preview-pro">Profissional 1</div>
        <ul className="landing-preview-list">
          {EXEMPLOS.map((e) => (
            <li key={e.time} className={`landing-appt is-${e.tone}`}>
              <div className="landing-appt-head">
                <strong>{e.time}</strong>
                <span className="landing-badge">{e.status}</span>
              </div>
              <div>{e.customer}</div>
              <div className="landing-appt-detail">{e.detail}</div>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="landing-preview-note">
        Exemplo ilustrativo, com dados fictícios.
      </figcaption>
    </figure>
  );
}
