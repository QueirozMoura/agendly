import { useState } from "react";
import { Link } from "react-router";

export interface LandingNavItem {
  /** Id da seção na página (sem "#"). */
  id: string;
  label: string;
}

/**
 * Cabeçalho da página pública. `items` são âncoras para seções da própria página; enquanto as seções não existem a
 * lista fica vazia (Etapa 2) e nem a navegação nem o botão de menu aparecem, para não haver link morto.
 */
export function LandingHeader({ items = [] }: { items?: LandingNavItem[] }) {
  const [open, setOpen] = useState(false);
  const hasNav = items.length > 0;
  return (
    <header className="landing-header">
      <div className="landing-header-bar">
        <Link to="/" className="landing-brand">
          Agendly
        </Link>
        {hasNav && (
          <nav
            id="landing-nav"
            aria-label="Seções"
            className="landing-nav"
            data-open={open}
          >
            {items.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
        <div className="landing-actions">
          <Link to="/entrar" className="landing-button">
            Entrar
          </Link>
          <Link to="/cadastro" className="landing-button landing-primary">
            Começar agora
          </Link>
        </div>
        {hasNav && (
          <button
            type="button"
            className="landing-menu"
            aria-expanded={open}
            aria-controls="landing-nav"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="visually-hidden">
              {open ? "Fechar menu" : "Abrir menu"}
            </span>
            <span aria-hidden="true">{open ? "✕" : "☰"}</span>
          </button>
        )}
      </div>
    </header>
  );
}
