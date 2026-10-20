import type { ReactNode } from "react";

/**
 * Ícones do painel: SVG inline de traço (herdam `currentColor`), sem biblioteca. Decorativos: sempre `aria-hidden`;
 * o nome acessível vem do texto ou do `aria-label` do botão/link que os contém.
 */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Svg>
    <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />
  </Svg>
);
export const CalendarIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="17" rx="3" />
    <path d="M8 2v4M16 2v4M3 10h18" />
  </Svg>
);
export const ServicesIcon = () => (
  <Svg>
    <path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
  </Svg>
);
export const PeopleIcon = () => (
  <Svg>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 5a3.5 3.5 0 010 7M18 14c2.2.6 3.5 2.6 3.5 6" />
  </Svg>
);
export const BuildingIcon = () => (
  <Svg>
    <rect x="4" y="3" width="10" height="18" rx="1.5" />
    <path d="M14 9h4a2 2 0 012 2v10M8 7h2M8 11h2M8 15h2M2 21h20" />
  </Svg>
);
export const MenuIcon = () => (
  <Svg>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const CollapseIcon = () => (
  <Svg>
    <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
  </Svg>
);
export const ExpandIcon = () => (
  <Svg>
    <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
  </Svg>
);
export const LogoutIcon = () => (
  <Svg>
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
  </Svg>
);

export const SunIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const MoonIcon = () => (
  <Svg>
    <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />
  </Svg>
);

export const MonitorIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Svg>
);

/** Marca do Agendly: calendário com marca de confirmação, no verde-petróleo do produto. */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="28" height="28" rx="8" fill="currentColor" />
      <path
        d="M8 11.5h12M10 8v2.5M18 8v2.5M10.5 17l2.5 2.5 4.5-5"
        fill="none"
        stroke="var(--primary-text)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
