# Etapa 12 — Painel: serviços, profissionais e disponibilidade

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado. Nenhuma validação `[VALIDAR]` mudou de estado.
> Sem commit e sem push. Conferido antes de começar: Etapa 11 integrada (`7a1bddc` = `origin/main`), árvore limpa.

## 1. Escopo (seção 11 do plano)

"Painel: serviços, profissionais e disponibilidade." Aceite: "criar/editar serviço (com buffer), profissional, vínculos, horários e folgas; conflito de
`TimeOff`/`WorkingHours` exibe a lista de agendamentos afetados e não altera nada; testes de componente."

Reutiliza **só** endpoints já existentes (Etapas 7–10); **nenhuma mudança no backend, migration, schema ou contrato**:
`GET/POST/PATCH /api/services`, `GET/POST/GET:id/PATCH /api/professionals`, `PUT /api/professionals/:id/services`, `/api/working-hours` (GET/POST/PATCH/DELETE),
`/api/time-off` (GET/POST/PATCH/DELETE) e o `409` de R4 com `details { conflicts, totalCount, truncated }`.

**Fora do escopo (não antecipado):** agenda e agendamentos (Etapa 13), página pública (14), exportar clientes.

## 2. O que foi implementado (`frontend/src`)

| Área | Arquivos | Resumo |
|---|---|---|
| Navegação | `components/AppLayout.tsx`, `routes/AppRoutes.tsx` | Menu **Início / Serviços / Profissionais** (`aria-current` na página atual) e rotas `/servicos`, `/profissionais`, `/profissionais/:id`, todas sob `RequireAuth` + `RequireOrganization` (empresa ativa). |
| Serviços | `features/services/{ServicesPage.tsx,schemas.ts}` | Lista (duração, **intervalo/buffer**, preço, situação), criar/editar (nome, duração, intervalo de preparação, preço em R$ opcional) e **ativar/desativar**. Validação local de conveniência + erros 400 do servidor por campo. Nota: "agendamentos já criados não mudam" (snapshots). |
| Profissionais | `features/professionals/{ProfessionalsPage,ProfessionalDetailPage}.tsx` | Lista e criação (leva à página do novo profissional); página com **dados** (renomear, ativar/desativar), **vínculos** (caixas de seleção; salva o conjunto COMPLETO por `PUT`, marca serviço inativo) e as duas seções abaixo. |
| Horário de trabalho | `features/availability/WorkingHoursSection.tsx` | Agrupado por dia da semana; adicionar/editar/remover intervalos em passos de 15 min (início 00:00–23:45, fim 00:15–**24:00**), em hora local da empresa; sobreposição recusada pelo servidor mostrada. |
| Folgas | `features/availability/TimeOffSection.tsx` | Lista, adicionar/editar/remover com `datetime-local` **na timezone da empresa** (convertido para UTC no envio) e motivo opcional. |
| **R4** | `components/ConflictList.tsx`, `hooks/useAction.ts` | O `409` de folga/expediente mostra "**A folga/alteração … não foi salva: ela afeta N agendamentos ativos. Nada foi alterado e nenhum agendamento foi cancelado**", com data/hora local, cliente, serviço e status de cada um; com `truncated`, mostra "os 100 primeiros de N" e orienta a repetir. Detalhes em formato inesperado caem na mensagem genérica (nunca quebram a tela). |
| Infra | `hooks/useResource.ts`, `hooks/useAction.ts`, `components/{LoadError,ConfirmRemove}.tsx`, `lib/time.ts`, `lib/money.ts`, `api/types.ts`, `styles.css` | Carregamento com estados explícitos (carregando / erro / pronto; `reload` **sem** trocar a tela por "carregando", mantendo avisos e rolagem); ações com `pending`/erro/campos/conflito; remoção em dois passos sem `window.confirm`; datas só com `Intl` (**nenhuma dependência nova**). |

## 3. Decisões técnicas e divergências (a aprovar)

1. **Nenhuma dependência nova e total compatibilidade com o backend.** Conversão hora local da empresa ⇄ UTC feita com `Intl` (`lib/time.ts`), alinhada ao comportamento real de referência de `date-fns-tz` do backend em ambiente UTC: horário **inexistente** (lacuna do horário de verão) é recusado com mensagem/`null`; **ambíguo** segue a resolução efetiva da referência (1ª ocorrência em fusos ocidentais de offset negativo como Nova York e São Paulo; 2ª ocorrência em fusos orientais de offset positivo como Sydney e Lord Howe). Testado exaustivamente em 18 fusos horários e contra oráculo de janela diária de 72h.
2. **Timezone sempre da empresa ativa** (`GET /api/organizations`, validada pelo servidor; imutável, R9), nunca do navegador nem de entrada do usuário: a mesma folga digitada "10:00" vira `15:00Z` numa empresa de Nova York e `13:00Z` numa de São Paulo (teste).
3. **Sem tela de agenda/agendamentos.** O painel só *mostra* agendamentos dentro do conflito de R4; cancelar/remarcar é da Etapa 13 (o texto orienta "cancele ou remarque … e tente novamente").
4. **Desativar é reversível e não pede confirmação** (serviço/profissional); **remover** horário e folga (`DELETE` físico, permitido para folhas) exige confirmação em dois passos.
5. **Preço em reais** ("1.234,5" ⇒ 123450 centavos); limites iguais aos do backend (duração 1–1440, intervalo 0–1440, preço ≤ R$ 1.000.000); o servidor valida de novo.
6. **Profissional na URL:** o `id` do caminho é **codificado** (`encodeURIComponent`) ao chamar a API, então `/profissionais/..%2Fme` não vira `/api/me` (teste).
7. **Lista parcial nunca parece completa** (herdado da revisão da Etapa 10): `totalCount` real + "mostrando os N primeiros de M".
8. Formulário de folga **limpa** depois de criar; o de expediente mantém a seleção (comum adicionar intervalos seguidos).

## 4. Testes e verificações (resultados reais)

| Verificação | Resultado |
|---|---|
| `npm test -w frontend` | frontend **233 testes em 10 arquivos**; todos passando |
| `npm run lint` | sem erros |
| `npm run typecheck` | 0 erros |
| `npm run format:check` | passou |
| `npm run build -w frontend` | sucesso (JS 389 kB, 118 kB gzip; CSS 5,6 kB) |
| `git diff --check` | exit 0 |

### Testes de componente (Testing Library + MSW) e testes unitários (124 novos)
O backend falso (`fakePanel.ts`) reproduz os contratos das Etapas 7–10 (validação 400 com `details`, 404, 409 de sobreposição e de R4 **sem alterar estado**, 204, `PUT` do conjunto completo) e a regra de CSRF.

| Arquivo | Testes | Cobre |
|---|---|---|
| `lib.test.ts` | 64 | hora local ⇄ UTC (SP, Nova York com avanço/recuo, Lord Howe com passo de 30 min, Sydney, lacuna inexistente, datas inválidas, ida e volta), `formatDateTime`, grade de 15 min, dinheiro (aceitos/rejeitados, ida e volta), e 18 fusos sob oráculo de força bruta em janela de 72h (-36h a +36h) nos dias de transição |
| `services.test.tsx` | 19 | lista (inativo, sem preço), **vazia × erro** (+ nova tentativa), criar com buffer/preço, buffer vazio ⇒ 0 e preço vazio ⇒ null, 8 validações locais, 400/429 do servidor sem perder o digitado, cancelar, clique duplo, editar, ativar/desativar, falha ao desativar |
| `professionals.test.tsx` | 13 | lista, vazia × erro, criar (leva à página), validação, 404 (outra empresa/inexistente), renomear, ativar/desativar, **vínculos** (conjunto completo, vazio, erro 404 mantém a seleção, sem serviços), URL com `../`, acessibilidade (seções nomeadas) |
| `availability.test.tsx` | 28 | expediente (ordem por dia, vazio, adicionar, início≥fim, **sobreposição**, editar/cancelar, remover com confirmação), folgas (lista em hora local, adicionar com conversão, **timezone da empresa ≠ navegador**, lacuna do horário de verão, 5 validações locais, editar, remover, formulário limpo), **R4** (alterar, remover, lista parcial, detalhes inesperados, folga nova e editada: recusada, nada criado/alterado, mesma tentativa funciona depois de resolver), erro de carga por seção, `X-Active-Org` em todas as chamadas e **nenhum `organizationId`** no corpo, 401 no meio do painel, menu |
| existentes (`api`, `auth`, `organizations`, `central`, `redirect`, `no-storage`) | 109 | continuam passando; `no-storage` agora também cobre o código novo (nenhum `localStorage`/`sessionStorage`) |

### Navegador headless real (backend real + Vite) — **integração**
Fluxo completo numa empresa nova, tudo **OK**: criar serviço (30 min + 10 min de intervalo, R$ 50,50), editar, desativar/ativar, validação; criar profissional e vincular o serviço; expediente de segunda 08:00–18:00; **sobreposição recusada**; criei um **agendamento real** (pela API, a agenda é da Etapa 13) na segunda 10:00; então
**R4 pelo expediente** (reduzir para 09:30) e **R4 pela folga** (09:00–12:00) foram recusados mostrando "seg. 02/11/2026 10:00 · Cliente Real · Corte · Agendado", nada alterado; uma folga à tarde foi aceita e exibida em hora local; **depois de cancelar o agendamento (API) a mesma folga foi aceita**; celular sem rolagem horizontal. Capturas desktop e celular lidas (conflito de R4, profissional, serviços).
Efeito colateral: a verificação criou empresas/dados `Painel …` no banco de desenvolvimento (somados aos `e2e-*`), **não apagados**.

## 5. Problemas de segurança, isolamento, acessibilidade e concorrência
- **Isolamento:** o frontend nunca envia `organizationId` (teste em todas as chamadas do painel); `X-Active-Org` em todas; recursos de outra empresa respondem 404 e a tela mostra erro sem dados falsos. Autorização continua no servidor.
- **Segurança:** nada em armazenamento do navegador; `id` da URL codificado; mensagens de erro vêm do servidor ou são genéricas.
- **Acessibilidade (verificada por testes e leitura das capturas, sem auditoria formal):** campos com rótulo e `aria-describedby`/`aria-invalid`, erros em `role=alert`, avisos em `role=status`, seções com nome acessível, `fieldset`/`legend`, `aria-current`, botões com nome específico ("Editar Corte"), sem diálogos nativos. **Observação:** o seletor de data/hora nativo segue o idioma do navegador (no headless apareceu `mm/dd/yyyy`).
- **Concorrência:** as escritas são serializadas e validadas no servidor (travas e R4, Etapas 9–10); a tela trata `409`/`STALE`-like como erro recuperável e **sempre relê do servidor** depois de salvar (nunca assume o resultado). Conflitos de R4 são decididos pelo servidor no momento do envio.

## 6. Limitações e pendências
- Resolução de ambiguidade de DST: O backend delega desempate a `date-fns-tz`, cujo algoritmo converge para a 1ª ocorrência em fusos com offset negativo e a 2ª ocorrência em fusos com offset positivo. O frontend espelha com fidelidade essa resolução nativamente com `Intl`, mantendo compatibilidade ponta a ponta sem dependências adicionais.
- Sem tela de agenda: o usuário não consegue cancelar/remarcar a partir do conflito (Etapa 13); só vê a lista.
- Expediente: a seção mostra todos os intervalos, mas não há "copiar para outros dias" nem edição em lote.
- Folgas passadas continuam listadas (o backend não filtra); sem paginação (limite de 1000 por profissional no backend).
- Listas de serviços e profissionais sem paginação nem busca (o backend também não pagina).
- Verificação visual só em Chromium headless; modo escuro conferido na Etapa 11, não nas telas novas; sem auditoria formal de contraste.
- Bug conhecido do ambiente de teste: nenhum novo. O teste ponta a ponta continua manual (automação na Etapa 15).
- `[VALIDAR]` V9–V12 e V14 seguem **não verificados**; nada desta etapa os afeta.

## 7. Atualização documental sugerida ao `ARCHITECTURE.md` (NÃO aplicada)
Registrar em 11 (Etapa 12) as rotas do SPA (`/servicos`, `/profissionais`, `/profissionais/:id`), que a conversão de fuso do frontend é feita com `Intl` (sem dependência) com a política de horário inexistente/ambíguo, e a forma de exibição do R4 (total real, lista parcial sinalizada).
