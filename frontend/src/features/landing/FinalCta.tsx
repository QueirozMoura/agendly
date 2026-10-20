import { Link } from "react-router";
import { FINAL_CTA_ID } from "./sections";

/** Convite final. Destinos reais: `/cadastro` (criar conta) e `/entrar` (login). Sem promessa de preço ou teste. */
export function FinalCta() {
  return (
    <section
      id={FINAL_CTA_ID}
      className="landing-section"
      aria-labelledby={`${FINAL_CTA_ID}-title`}
    >
      <div className="landing-container">
        <div className="landing-cta">
          <h2 id={`${FINAL_CTA_ID}-title`}>Comece a organizar sua agenda</h2>
          <p>
            Crie sua conta, cadastre sua empresa e use a agenda para registrar,
            remarcar e cancelar agendamentos.
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
      </div>
    </section>
  );
}
