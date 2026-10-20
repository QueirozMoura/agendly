import { LANDING_SECTIONS } from "./sections";

/**
 * Só recursos que existem no painel (telas em `features/`): agenda (dia/semana, novo, remarcar, cancelar), serviços,
 * profissionais (com vínculo a serviços), horário de trabalho e folgas, e várias empresas com fuso próprio.
 * Fora desta lista de propósito: página pública de agendamento, WhatsApp, lembretes, pagamentos, equipe e relatórios.
 */
const FEATURES = [
  {
    title: "Agenda por dia ou semana",
    text: "Veja os agendamentos agrupados por profissional, com navegação entre períodos e atalho para hoje.",
  },
  {
    title: "Criar, remarcar e cancelar",
    text: "Registre o cliente com nome, telefone e e-mail opcional, escolha entre os horários livres e ajuste depois. No cancelamento, o motivo é opcional.",
  },
  {
    title: "Serviços",
    text: "Defina nome, duração, intervalo de preparação e preço opcional. Desative um serviço sem perder o histórico.",
  },
  {
    title: "Profissionais",
    text: "Cadastre quem atende e escolha quais serviços cada pessoa realiza. Também é possível desativar um profissional.",
  },
  {
    title: "Horário de trabalho e folgas",
    text: "Configure o expediente por dia da semana e registre folgas e ausências para que esses períodos não sejam oferecidos.",
  },
  {
    title: "Várias empresas, cada uma no seu fuso",
    text: "Uma conta pode ter mais de uma empresa. Os horários aparecem no fuso da empresa, não no do seu navegador.",
  },
] as const;

export function Features() {
  const { id } = LANDING_SECTIONS.features;
  return (
    <section
      id={id}
      className="landing-section landing-band"
      aria-labelledby={`${id}-title`}
    >
      <div className="landing-container">
        <h2 id={`${id}-title`} className="landing-section-title">
          O que você já encontra no painel
        </h2>
        <ul className="landing-cards">
          {FEATURES.map((f) => (
            <li key={f.title} className="landing-card">
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
