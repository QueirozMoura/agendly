import { LANDING_SECTIONS } from "./sections";

/**
 * Fluxo real de uso: cadastro (`/cadastro`) → confirmação de e-mail (exigida para criar empresa) → empresa
 * (`/empresas`) → serviços, profissionais e horários → agenda.
 */
const STEPS = [
  {
    title: "Crie sua conta",
    text: "Cadastre-se e confirme seu e-mail. A confirmação é necessária para criar uma empresa.",
  },
  {
    title: "Cadastre sua empresa",
    text: "Informe o nome, o endereço e o fuso horário. O fuso não muda depois de criado.",
  },
  {
    title: "Monte sua operação",
    text: "Cadastre serviços e profissionais, vincule quem faz o quê e defina os horários de trabalho.",
  },
  {
    title: "Use a agenda",
    text: "Crie, remarque e cancele agendamentos escolhendo entre os horários livres.",
  },
] as const;

export function HowItWorks() {
  const { id } = LANDING_SECTIONS.howItWorks;
  return (
    <section
      id={id}
      className="landing-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="landing-container">
        <h2 id={`${id}-title`} className="landing-section-title">
          Do cadastro à agenda em quatro passos
        </h2>
        <ol className="landing-steps">
          {STEPS.map((s) => (
            <li key={s.title} className="landing-step">
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
