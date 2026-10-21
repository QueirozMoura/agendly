import { Link } from "react-router";
import { AgendaPreview } from "./AgendaPreview";
import { LANDING_SECTIONS } from "./sections";

/** Apresentação pública estática; os CTAs usam rotas e âncoras existentes. */
export function Hero() {
  return (
    <section className="landing-hero" aria-labelledby="landing-hero-title">
      <div className="landing-hero-inner">
        <div className="landing-hero-copy">
          <p className="landing-hero-eyebrow">
            <span aria-hidden="true" />
            Tempo bem organizado. Negócio bem cuidado.
          </p>
          <h1 id="landing-hero-title">
            Sua agenda em ordem. <span>Seu negócio em movimento.</span>
          </h1>
          <p className="landing-lead">
            Serviços, profissionais e agendamentos em um só lugar. Organize os
            horários da sua equipe e acompanhe cada atendimento, do dia à
            semana.
          </p>
          <div className="landing-hero-actions">
            <Link
              to="/cadastro"
              className="landing-button landing-primary landing-large"
            >
              Começar agora <span aria-hidden="true">↗</span>
            </Link>
            <a
              href={`#${LANDING_SECTIONS.features.id}`}
              className="landing-button landing-large landing-hero-secondary"
            >
              Conhecer funcionalidades
            </a>
          </div>
          <p className="landing-hero-assurance">
            <span aria-hidden="true">✓</span> Proteção contra horários em
            conflito.
          </p>
        </div>
        <div className="landing-hero-visual">
          <AgendaPreview />
        </div>
      </div>
    </section>
  );
}
