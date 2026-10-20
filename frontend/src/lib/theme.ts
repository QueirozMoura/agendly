import { useSyncExternalStore } from "react";

// ÚNICO uso de armazenamento do navegador no app: a preferência VISUAL de tema, sob esta chave. Nenhum token, sessão ou
// dado pessoal passa por aqui (a regra está em test/no-storage.test.ts e test/setup.ts).
export const THEME_KEY = "agendly-theme";

export type ThemePreference = "system" | "light" | "dark";
export const THEME_ORDER: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];

export const isThemePreference = (v: unknown): v is ThemePreference =>
  v === "system" || v === "light" || v === "dark";

export function nextPreference(p: ThemePreference): ThemePreference {
  return THEME_ORDER[(THEME_ORDER.indexOf(p) + 1) % THEME_ORDER.length]!;
}

/** Preferência salva; qualquer valor ausente, inválido ou erro de acesso vira "system". */
export function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** "system" remove o atributo e o CSS volta a seguir `prefers-color-scheme`. */
export function applyPreference(p: ThemePreference): void {
  const root = document.documentElement;
  if (p === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p);
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Escolhe, aplica e guarda. Se o armazenamento falhar, o tema vale só nesta sessão da página. */
export function setPreference(p: ThemePreference): void {
  applyPreference(p);
  try {
    if (p === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {
    // sem persistência (modo privado, armazenamento bloqueado)
  }
  notify();
}

let storageListening = false;

/** Chamar uma vez na inicialização: aplica o tema salvo e acompanha mudanças feitas em outras abas. */
export function initTheme(): void {
  applyPreference(readPreference());
  if (storageListening) return;
  storageListening = true;
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== THEME_KEY) return;
    applyPreference(readPreference());
    notify();
  });
}

// A fonte da verdade da sessão é o atributo de <html> (o mesmo que o CSS usa).
const snapshot = (): ThemePreference => {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" ? v : "system";
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, snapshot, () => "system");
}
