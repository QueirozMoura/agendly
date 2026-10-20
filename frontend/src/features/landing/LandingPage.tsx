import { Hero } from "./Hero";
import { LandingHeader } from "./LandingHeader";
import "./landing.css";

/**
 * Página pública de "/" para visitantes anônimos. Etapa 3: header + hero. As demais seções entram nas próximas
 * etapas (e passam seus itens de âncora ao header).
 */
export function LandingPage() {
  return (
    <div className="landing">
      <LandingHeader />
      <main>
        <Hero />
      </main>
    </div>
  );
}
