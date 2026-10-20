import { Link } from "react-router";
import { AgendaPreview } from "./AgendaPreview";

/**
 * Primeira dobra. Só promete o que o sistema já faz: serviços e profissionais cadastrados, horários de atendimento,
 * agenda por dia ou semana e bloqueio de horários em conflito (restrição no banco + `409 SLOT_UNAVAILABLE`).
 */
export function Hero() {
  return (
    <section className="landing-hero" aria-labelledby="landing-hero-title">
      <div className="landing-hero-inner">
        <div className="landing-hero-copy">
          <h1 id="landing-hero-title">
            Sua agenda organizada, <span>sem horários em conflito.</span>
          </h1>
          <p className="landing-lead">
            Cadastre serviços e profissionais, defina os horários de atendimento
            e acompanhe os agendamentos do dia ou da semana em um só lugar.
          </p>
          <div className="landing-hero-actions">
            <Link
              to="/cadastro"
              className="landing-button landing-primary landing-large"
            >
              Começar agora
            </Link>
            <Link to="/entrar" className="landing-button landing-large">
              Entrar
            </Link>
          </div>
        </div>
        <div className="landing-hero-visual">
          <AgendaPreview />
        </div>
      </div>
    </section>
  );
}
