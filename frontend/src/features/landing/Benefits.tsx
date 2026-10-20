import { LANDING_SECTIONS } from "./sections";

/**
 * Cada benefício descreve um comportamento que existe no sistema (conferido no código):
 * - horários oferecidos: `computeSlots` (expediente, folgas, agendamentos ativos com duração + intervalo, antecedência);
 * - aviso de afetados: `ConflictList` ao mudar expediente/folga (a alteração em conflito não é feita);
 * - histórico: snapshots de duração/intervalo/preço no agendamento; cancelar não exclui e guarda o motivo;
 * - alterações simultâneas: `409 STALE_VERSION` ao remarcar/cancelar (cenário 10 validado + testes automatizados).
 * NÃO prometer proteção contra envio repetido/duplicado: a `Idempotency-Key` existe, mas o efeito real (cenário 7)
 * ainda não foi validado ponta a ponta.
 */
const BENEFITS = [
  {
    title: "Só horários que cabem de verdade",
    text: "Os horários oferecidos já descontam o expediente do profissional, as folgas, os agendamentos existentes e o tempo do serviço, incluindo o intervalo de preparação.",
  },
  {
    title: "Mudanças com aviso, sem surpresa",
    text: "Ao alterar um horário de trabalho ou registrar uma folga que atinge agendamentos, o Agendly lista quais seriam afetados. Nada é alterado até você resolver.",
  },
  {
    title: "Histórico que não muda",
    text: "Cada agendamento guarda a duração, o intervalo e o preço de quando foi feito. Cancelar mantém o registro, com o motivo, em vez de apagá-lo.",
  },
  {
    title: "Alterações simultâneas sem sobrescrever",
    text: "Se duas pessoas mexem no mesmo agendamento ao mesmo tempo, a segunda é avisada e a tela é atualizada, em vez de sobrescrever a alteração da primeira.",
  },
] as const;

export function Benefits() {
  const { id } = LANDING_SECTIONS.benefits;
  return (
    <section
      id={id}
      className="landing-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="landing-container">
        <h2 id={`${id}-title`} className="landing-section-title">
          Menos remendo na agenda, mais tempo para atender
        </h2>
        <ul className="landing-cards landing-cards-4">
          {BENEFITS.map((b) => (
            <li key={b.title} className="landing-card">
              <h3>{b.title}</h3>
              <p>{b.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
