import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ThemeToggle } from "../../components/ThemeToggle";

export interface LandingNavItem {
  id: string;
  label: string;
}

// Deve acompanhar o breakpoint do header em landing.css.
const DESKTOP_QUERY = "(min-width: 1024px)";

/** Navegação de divulgação: não é um diálogo e não prende o foco. */
export function LandingHeader({ items = [] }: { items?: LandingNavItem[] }) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(
    () => window.matchMedia?.(DESKTOP_QUERY).matches ?? true,
  );
  const [active, setActive] = useState(() => window.location.hash.slice(1));
  const headerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const hasNav = items.length > 0;

  useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_QUERY);
    const resize = () => {
      if (!media) return;
      if (!media.matches && navRef.current?.contains(document.activeElement)) {
        menuRef.current?.focus();
      } else if (media.matches && document.activeElement === menuRef.current) {
        requestAnimationFrame(() => {
          navRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
        });
      }
      setDesktop(media.matches);
      setOpen(false);
    };
    media?.addEventListener("change", resize);
    return () => media?.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    const header = headerRef.current;
    const landing = header?.closest<HTMLElement>(".landing");
    if (!header || !landing || typeof ResizeObserver === "undefined") return;
    const previous = landing.style.getPropertyValue("--l-header-offset");
    const observer = new ResizeObserver(() => {
      landing.style.setProperty(
        "--l-header-offset",
        `${Math.ceil(header.getBoundingClientRect().height) + 16}px`,
      );
    });
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (previous) landing.style.setProperty("--l-header-offset", previous);
      else landing.style.removeProperty("--l-header-offset");
    };
  }, []);

  useEffect(() => {
    const syncHash = () => setActive(window.location.hash.slice(1));
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      menuRef.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        navRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      )
        return;
      if (navRef.current?.contains(document.activeElement))
        menuRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  function navigate(id: string) {
    setActive(id);
    setOpen(false);
    const target = document.getElementById(id);
    if (target) {
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        target.addEventListener(
          "blur",
          () => target.removeAttribute("tabindex"),
          { once: true },
        );
      }
      target.focus({ preventScroll: true });
    } else if (!desktop) menuRef.current?.focus();
  }

  return (
    <header className="landing-header" ref={headerRef}>
      <div className="landing-header-bar">
        <Link to="/" className="landing-brand landing-header-brand">
          <span className="landing-brand-symbol" aria-hidden="true">
            <span />
          </span>
          Agendly
        </Link>
        {hasNav && (
          <button
            ref={menuRef}
            type="button"
            className="landing-menu"
            aria-expanded={open}
            aria-controls="landing-nav"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="visually-hidden">
              {open ? "Fechar menu" : "Abrir menu"}
            </span>
            <span className="landing-menu-lines" aria-hidden="true" />
          </button>
        )}
        {hasNav && (
          <nav
            ref={navRef}
            id="landing-nav"
            aria-label="Seções"
            className="landing-nav"
            data-open={open}
            inert={!desktop && !open}
            aria-hidden={!desktop && !open ? true : undefined}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== menuRef.current
              )
                setOpen(false);
            }}
          >
            {items.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={active === item.id ? "location" : undefined}
                onClick={() => navigate(item.id)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
        <div className="landing-actions">
          <ThemeToggle variant="icon" />
          <Link to="/entrar" className="landing-button landing-signin">
            Entrar
          </Link>
          <Link to="/cadastro" className="landing-button landing-primary">
            Começar agora
          </Link>
        </div>
      </div>
    </header>
  );
}
