import { Link } from "react-router";
import { LANDING_NAV } from "./sections";

/** Só links que existem: as âncoras da própria página e as rotas de entrada. Sem contato, redes ou textos legais. */
export function Footer() {
  return (
    <footer className="landing-footer">
      <div className="landing-container landing-footer-inner">
        <div>
          <Link to="/" className="landing-brand">
            Agendly
          </Link>
          <p>Agendamentos, serviços e profissionais em um só lugar.</p>
        </div>
        <nav aria-label="Rodapé: seções" className="landing-footer-nav">
          {LANDING_NAV.map((item) => (
            <a key={item.id} href={`#${item.id}`}>
              {item.label}
            </a>
          ))}
        </nav>
        <nav aria-label="Rodapé: conta" className="landing-footer-nav">
          <Link to="/entrar">Entrar</Link>
          <Link to="/cadastro">Criar conta</Link>
        </nav>
      </div>
    </footer>
  );
}
