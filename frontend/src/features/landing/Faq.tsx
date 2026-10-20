import { LANDING_SECTIONS } from "./sections";

/**
 * Respostas baseadas só no comportamento implementado hoje (conferido no código):
 * - e-mail: criar empresa exige e-mail confirmado (`403 EMAIL_NOT_VERIFIED`); o painel tem "Reenviar e-mail de confirmação";
 * - empresas: várias por conta, dados separados por empresa, fuso definido na criação e imutável;
 * - conflito de horário: `computeSlots` + restrição no banco; a tela avisa "O horário escolhido não está mais disponível";
 * - snapshots de duração/intervalo/preço; cancelar guarda o registro e o motivo (sem exclusão física);
 * - sem página pública, sem mensagens a clientes (os e-mails do sistema são só de conta) e sem convite de equipe.
 * Não falar de planos, preços, integrações nem de garantia contra envio duplicado (ainda não validada ponta a ponta).
 */
const QUESTIONS = [
  {
    q: "Preciso confirmar meu e-mail?",
    a: "Para criar uma empresa, sim: a confirmação do e-mail da conta é exigida. Enquanto ela estiver pendente, o painel mostra um aviso com a opção de reenviar o e-mail de confirmação.",
  },
  {
    q: "Posso ter mais de uma empresa na mesma conta?",
    a: "Sim. Cada empresa tem seus próprios serviços, profissionais, horários e agenda, e você alterna entre elas no painel. O fuso horário é escolhido ao criar a empresa e não pode ser alterado depois.",
  },
  {
    q: "Como o Agendly evita dois agendamentos no mesmo horário?",
    a: "Ao agendar, só são oferecidos horários livres do profissional. Se alguém ocupar o horário enquanto você preenche os dados, o Agendly avisa que ele não está mais disponível, mantém o que você digitou e atualiza a lista de horários.",
  },
  {
    q: "O que acontece com agendamentos já feitos se eu mudar um serviço?",
    a: "Nada muda neles. Cada agendamento guarda a duração, o intervalo e o preço de quando foi criado, então editar o serviço depois só vale para os próximos.",
  },
  {
    q: "Cancelar apaga o agendamento?",
    a: "Não. O agendamento passa a aparecer como cancelado, com o motivo, caso você tenha informado um, e o horário volta a ficar disponível.",
  },
  {
    q: "Meus clientes podem agendar sozinhos ou receber mensagens?",
    a: "Hoje não. Os agendamentos são registrados por quem usa o painel, com nome, telefone e e-mail opcional do cliente, e o Agendly não envia mensagens nem lembretes aos clientes.",
  },
  {
    q: "Posso dar acesso à minha equipe?",
    a: "Hoje cada empresa é acessada pela conta que a criou: não há convite para outros usuários.",
  },
] as const;

export function Faq() {
  const { id } = LANDING_SECTIONS.faq;
  return (
    <section
      id={id}
      className="landing-section landing-band"
      aria-labelledby={`${id}-title`}
    >
      <div className="landing-container">
        <h2 id={`${id}-title`} className="landing-section-title">
          Perguntas frequentes
        </h2>
        <div className="landing-faq">
          {QUESTIONS.map((item) => (
            <details key={item.q} className="landing-faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
