/** Dados fictícios, sem API ou controles: uma ilustração da agenda por profissional. */
const EXEMPLOS = [
  {
    start: "09:00",
    end: "09:30",
    status: "Agendado",
    tone: "scheduled",
    customer: "Marina Costa",
    service: "Corte de cabelo",
    detail: "30 min",
  },
  {
    start: "10:00",
    end: "10:50",
    status: "Confirmado",
    tone: "confirmed",
    customer: "Lucas Oliveira",
    service: "Corte e barba",
    detail: "40 min + 10 min de intervalo",
  },
  {
    start: "11:30",
    end: "12:00",
    status: "Cancelado",
    tone: "cancelled",
    customer: "Pedro Santos",
    service: "Corte de cabelo",
    detail: "30 min",
  },
] as const;

export function AgendaPreview() {
  return (
    <figure
      className="landing-preview"
      role="img"
      aria-label="Exemplo ilustrativo da agenda do Agendly, com dados fictícios: visão do dia de Rafael, com horários, clientes e serviços. Um atendimento agendado às 09:00, um confirmado às 10:00 e um cancelado às 11:30."
    >
      <div className="landing-preview-window" aria-hidden="true">
        <div className="landing-preview-bar">
          <span className="landing-preview-wordmark">
            Agendly<span> / Agenda</span>
          </span>
          <span className="landing-preview-window-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="landing-preview-body">
          <div className="landing-preview-heading">
            <div>
              <span className="landing-preview-kicker">
                Sua agenda, de perto
              </span>
              <div className="landing-preview-title">25 de outubro</div>
              <span className="landing-preview-year">2026 · Visão do dia</span>
            </div>
            <span className="landing-preview-date">
              <strong>25</strong>OUT
            </span>
          </div>
          <div className="landing-preview-pro">
            <span className="landing-preview-avatar">R</span>
            <span>
              <small>Profissional</small>
              <strong>Rafael</strong>
            </span>
          </div>
          <ul className="landing-preview-list">
            {EXEMPLOS.map((example) => (
              <li
                key={example.start}
                className={`landing-preview-row is-${example.tone}`}
              >
                <div className="landing-preview-time">
                  <strong>{example.start}</strong>
                  <span>{example.end}</span>
                </div>
                <div className={`landing-appt is-${example.tone}`}>
                  <div className="landing-appt-head">
                    <span className="landing-badge">{example.status}</span>
                    {example.tone === "confirmed" && (
                      <span className="landing-appt-check">✓</span>
                    )}
                  </div>
                  <strong className="landing-appt-customer">
                    {example.customer}
                  </strong>
                  <div className="landing-appt-service">{example.service}</div>
                  <div className="landing-appt-detail">{example.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption className="landing-preview-note">
        Exemplo ilustrativo, com dados fictícios.
      </figcaption>
    </figure>
  );
}
