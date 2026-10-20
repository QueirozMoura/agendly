import { useState } from "react";
import {
  nextPreference,
  setPreference,
  useThemePreference,
  type ThemePreference,
} from "../lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const LABEL: Record<ThemePreference, string> = {
  system: "Sistema",
  light: "Claro",
  dark: "Escuro",
};
const ICON: Record<ThemePreference, () => React.JSX.Element> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

/**
 * Alterna Sistema → Claro → Escuro. `nav`: item da sidebar (o texto some quando ela é recolhida, como os demais);
 * `icon`: botão quadrado para os cabeçalhos públicos. O ícone mostra a escolha ATUAL; o nome acessível diz também o próximo passo.
 */
export function ThemeToggle({ variant }: { variant: "nav" | "icon" }) {
  const pref = useThemePreference();
  const [announce, setAnnounce] = useState("");
  const next = nextPreference(pref);
  const Icon = ICON[pref];
  const label = `Tema: ${LABEL[pref]}. Alterar para ${LABEL[next].toLowerCase()}.`;
  return (
    <>
      <button
        type="button"
        className={variant === "nav" ? "nav-item nav-button" : "theme-button"}
        aria-label={label}
        title={label}
        onClick={() => {
          setPreference(next);
          setAnnounce(`Tema: ${LABEL[next]}`);
        }}
      >
        <Icon />
        {variant === "nav" && (
          <span className="nav-label" aria-hidden="true">
            Tema: {LABEL[pref]}
          </span>
        )}
      </button>
      <span aria-live="polite" className="visually-hidden">
        {announce}
      </span>
    </>
  );
}
