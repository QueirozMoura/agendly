import { Benefits } from "./Benefits";
import { Faq } from "./Faq";
import { Features } from "./Features";
import { FinalCta } from "./FinalCta";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LandingHeader } from "./LandingHeader";
import { LANDING_NAV } from "./sections";
import "./landing.css";

/**
 * Página pública de "/" para visitantes anônimos. Etapa 5: header (com âncoras reais), hero, benefícios,
 * funcionalidades, como funciona, FAQ, CTA final e rodapé.
 */
export function LandingPage() {
  return (
    <div className="landing">
      <LandingHeader items={LANDING_NAV} />
      <main>
        <Hero />
        <Benefits />
        <Features />
        <HowItWorks />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
