import type { LandingNavItem } from "./LandingHeader";

/**
 * Ids estáveis das seções da página pública (âncoras `#id`). Fonte única: as seções usam o `id` e o header monta os
 * links a partir desta lista. Ordem = ordem na página. O CTA final (`comece-agora`) não é item de menu, então não está aqui.
 */
export const LANDING_SECTIONS = {
  benefits: { id: "beneficios", label: "Benefícios" },
  features: { id: "funcionalidades", label: "Funcionalidades" },
  howItWorks: { id: "como-funciona", label: "Como funciona" },
  faq: { id: "faq", label: "FAQ" },
} as const satisfies Record<string, LandingNavItem>;

/** Id do CTA final (âncora própria, fora do menu). */
export const FINAL_CTA_ID = "comece-agora";

export const LANDING_NAV: LandingNavItem[] = Object.values(LANDING_SECTIONS);
