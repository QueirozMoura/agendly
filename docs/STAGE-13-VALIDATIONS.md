# Etapa 13 — Painel: agenda e gerenciamento de agendamentos

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado. Sem commit e sem push.
> Conferido antes de começar: branch `main` em `5d2b649` = `origin/main`, árvore limpa.
> **Validação manual com o backend real:** executada em 20/10/2026 (seção 5.1: 15 dos 16 cenários, 3 deles com ressalvas; o cenário 1 ficou sem execução manual).
> Seção 4: testes automatizados e verificações estáticas. O roteiro da seção 5 continua sendo a referência para repetir.

## 1. Escopo (seção 11 do plano)

"Painel: agenda." Aceite: "visão diária/semanal; criar/remarcar/cancelar com `Idempotency-Key`; `409 SLOT_UNAVAILABLE` recarrega slots;
tentativa de agendar no passado bloqueada na UI e na API; fluxo manual guiado documentado."

**Nenhuma mudança no backend, migration, schema ou contrato HTTP.** Endpoints usados (todos já existentes, lidos no código):

| Uso | Endpoint | Contrato conferido no backend |
|---|---|---|
| Listar | `GET /api/appointments?from&to` | ISO 8601 com fuso, `to > from`, no máximo 93 dias (`listMaxSpanDays`), teto de 500 itens (`listMax`), sem `totalCount`. Devolve `{ appointments }` com `service` = snapshots (R3) e `version`. |
| Horários livres | `GET /api/availability/slots?professionalId&serviceId&date` | `date` = dia LOCAL `AAAA-MM-DD`; devolve `{ slots: ISO[] }`; é sugestão, nunca trava (L15). |
| Criar | `POST /api/appointments` + `Idempotency-Key` (UUID, obrigatória) | Corpo estrito `{ professionalId, serviceId, startsAt, customer: { name, phone, email?, notes? } }`; `201 { appointment }`; replay devolve o mesmo status/corpo com `Idempotent-Replay: true`; mesma chave com outro corpo ⇒ `409 IDEMPOTENCY_KEY_REUSED`. |
| Remarcar | `POST /api/appointments/:id/reschedule` | `{ startsAt, professionalId?, version }`; `409 STALE_VERSION`, `409 SLOT_UNAVAILABLE`, `422 STARTS_AT_IN_PAST`. |
| Cancelar | `POST /api/appointments/:id/cancel` | `{ version, reason? }` (≤ 200 caracteres); muda o status para `CANCELLED` (nunca `DELETE`); `409 STALE_VERSION`. |
| Apoio | `GET /api/professionals`, `GET /api/services` | Já usados na Etapa 12. |

Fora do escopo (não antecipado): confirmar/concluir/não compareceu/reativar (as rotas existem no backend, mas a etapa pede criar, remarcar e cancelar),
busca/seleção de clientes existentes (`customerId`), página pública (Etapa 14).

## 2. O que foi implementado (`frontend/src`)

| Área | Arquivos | Resumo |
|---|---|---|
| Rota e menu | `routes/AppRoutes.tsx`, `components/AppLayout.tsx` | `/agenda` sob `RequireAuth` + `RequireOrganization`; item **Agenda** no menu principal (`aria-current`). |
| Página | `features/agenda/AgendaPage.tsx` | Visão **Dia** / **Semana** (segunda a domingo), Anterior / Hoje / Próximo, campo de data, **Atualizar**, **Novo agendamento**. Agrupa por profissional; na semana, uma coluna por dia. Estados: carregando, vazio, erro com "Tentar novamente", aviso de lista com 500 itens (possivelmente incompleta). |
| Cartão | `features/agenda/AppointmentCard.tsx` | Horário local, cliente, status, serviço/duração/intervalo/preço **dos snapshots**; **Remarcar** e **Cancelar** (só para `SCHEDULED`/`CONFIRMED`). |
| Criar | `features/agenda/NewAppointmentForm.tsx` | Contato + profissional + serviço (só ativos e vinculados) + data + horário; `Idempotency-Key`; tratamento de 409/422/400. |
| Horários | `features/agenda/useSlots.tsx`, `SlotsField.tsx` | Consulta `/api/availability/slots` quando profissional, serviço ou data mudam; filtra instantes passados (R7); nada é pedido para data passada. |
| Datas | `lib/agenda.ts` | Aritmética de calendário sobre `AAAA-MM-DD` e limites do dia/semana em UTC, **usando `zonedLocalToUtcIso` / `utcIsoToZonedLocal` de `lib/time.ts`** (nenhuma conversão de fuso duplicada). |
| Tipos | `api/types.ts` | `ApiAppointment`, `AppointmentStatus`. |
| Estilo | `styles.css` | Barra de ferramentas, cartões, grade semanal (1 coluna no celular), horários. |

### Alterações em código compartilhado (justificativa)

1. `api/client.ts` — `RequestOptions.headers` opcional. **Necessário:** o cliente único não tinha como enviar `Idempotency-Key`. Os cabeçalhos extras entram primeiro; `accept`, `x-active-org` e `content-type` continuam definidos pelo cliente.
2. `components/forms.ts` — `fieldErrorsFromApi` passa a expor também o caminho completo de campos aninhados (`customer.phone`), além da chave do primeiro nível que já existia. **Necessário:** o `400` de criação aponta `customer.phone`/`customer.name`; sem isso o erro não chegaria ao campo. Compatível com o uso anterior.
3. Testes compartilhados: `test/fakePanel.ts` — o helper de rota virou `tenantRoute(state)` exportado (mesmo comportamento: CSRF 415, 401, 403, `X-Active-Org`) e passou a registrar também `search`; `test/fakeBackend.ts` — `agenda` no estado, `search?` no registro de chamadas e `agendaBackend` entre os handlers. Nenhum teste anterior foi alterado.

## 3. Decisões técnicas e comportamentos a confirmar

1. **Timezone sempre da empresa ativa** (`useOrganizations().active.timezone`), nunca do navegador. "Hoje", o dia exibido, os limites da consulta e os horários dos cartões/slots vêm de `lib/time.ts`.
2. **Dia local ⇒ UTC:** `from` = início do dia local, `to` = início do dia seguinte (24 h, 23 h ou 25 h nas viradas de horário de verão). Se a meia-noite não existe (ex.: São Paulo em 04/11/2018), o dia começa no primeiro horário existente. Dia = 1 dia, semana = 7 dias (≤ 8 dias de intervalo; bem abaixo de 93).
3. **Semana começa na segunda-feira** (decisão de UI; o `weekday` do expediente continua 0 = domingo).
4. **Idempotência:** cada submissão lógica gera `crypto.randomUUID()`. Repetir o **mesmo conteúdo** (por exemplo, nova tentativa depois de erro de rede) reaproveita chave e corpo; qualquer mudança de conteúdo gera chave nova (o backend só registra sucessos, mas a mesma chave com outro corpo seria `IDEMPOTENCY_KEY_REUSED`). Após `201` a chave é descartada. Cliques repetidos são bloqueados por trava local + botão desabilitado. Remarcar e cancelar não usam `Idempotency-Key` (o backend não a define para elas; a proteção é a `version`).
5. **`409 SLOT_UNAVAILABLE`:** mostra "O horário escolhido não está mais disponível. Seus dados foram mantidos…", mantém nome/telefone/e-mail/profissional/serviço/data, descarta apenas o horário escolhido, relê os slots e **não** escolhe outro horário sozinho. O mesmo vale para `PROFESSIONAL_UNAVAILABLE` e, ao remarcar, para ambos.
6. **`409 STALE_VERSION`** (remarcar e cancelar): fecha o editor, avisa "alterado em outra sessão", recarrega a agenda e **não** reenvia nada. A pessoa reabre a ação com a versão atual.
7. **R7:** a UI não oferece slots anteriores a `now` (filtro local mesmo que a API os devolva), não consulta nem aceita data passada (`min` no campo e validação) e **revalida o instante imediatamente antes de enviar**. O `422` do servidor aparece como mensagem no formulário, que continua utilizável.
8. **R3:** duração, intervalo, preço e nome do serviço mostrados vêm de `appointment.service`. Cartões nunca consultam o serviço atual.
9. **Cancelados** continuam visíveis (riscados, com o motivo) e sem ações.

## 4. Testes e verificações EXECUTADOS (resultados reais)

| Verificação | Resultado |
|---|---|
| `npm test -w frontend` | **290 testes em 11 arquivos, todos passando** = 233 anteriores (intactos) + **57 novos** em `appointments.test.tsx` |
| `npm run lint` | sem erros |
| `npm run typecheck` | 0 erros (frontend e backend) |
| `npm run format:check` | passou |
| `npm run build -w frontend` | sucesso (JS 407,67 kB, 122,92 kB gzip; CSS 7,00 kB) |
| `git diff --check` | exit 0 |

Verificação de sensibilidade: ao desligar o reaproveitamento da `Idempotency-Key` no formulário, o teste de retry falhou (e a mutação foi revertida).

### Cobertura de `appointments.test.tsx` (Testing Library + MSW; backend falso em `test/fakeAgenda.ts`)

| Tema | Testes |
|---|---|
| Visão diária: agrupamento por profissional, horários locais, consulta só do dia local, 23:30 local (já é o dia seguinte em UTC), snapshots (R3) | 4 |
| Navegação (Anterior/Hoje/Próximo/data), semana (7 dias, segunda–domingo, limites de dia local sábado/domingo 23:30), Próximo semanal, Nova York (fuso ≠ São Paulo, semana com virada de horário de verão: `to` = 04:00Z), "hoje" em São Paulo × Sydney | 5 |
| Estados: carregando, vazio, sem profissionais, erro da API (não vira lista vazia) + retry, Atualizar, teto de 500, cancelados, menu, login e retorno a `/agenda`, sessão expirada (listar e cancelar) | 11 |
| Criar: slots reais e dinâmicos, 201 + atualização, refaz slots ao mudar profissional/serviço/data, dia sem horários, erro de slots + retry, validações locais, 400 do servidor por campo, **`X-Active-Org` e ausência de `organizationId`** em todas as chamadas, **`Idempotency-Key` UUID**, retry preserva chave/corpo, conteúdo novo ⇒ chave nova, nova operação ⇒ chave nova, replay no contrato do servidor falso, clique duplo, **409 SLOT_UNAVAILABLE**, **R7 local** (passou entre escolher e enviar; slots passados filtrados; data passada), **422**, 403, criação em outro dia | 17 |
| Remarcar: payload com `version`, troca de profissional, validação, **STALE_VERSION** com nova tentativa na versão atual, SLOT_UNAVAILABLE, 422, nunca para dia passado | 7 |
| Cancelar: confirmação sem requisição prévia, motivo opcional + status `CANCELLED` sem `DELETE`, motivo em branco ⇒ `null`, motivo > 200, **STALE_VERSION**, clique duplo, erro de rede | 7 |
| Remarcar com o serviço alterado depois da criação (aviso, recusa do servidor, serviço desativado) | 3 |
| Utilitários de data (semana, calendário, limite de 93 dias em 4 fusos, meia-noite inexistente) | 3 |

O backend falso reproduz os contratos lidos no código do backend (chave UUID obrigatória, corpo estrito, replay, `STALE_VERSION` por `version`, 422 de passado, 409 de horário ocupado). **Ele não substitui o teste contra o backend real** (seção 5).

## 5. Roteiro de validação MANUAL (backend real) — **NÃO EXECUTADO**

Pré-requisitos: Postgres e migrations aplicadas; backend e `npm run dev -w frontend` rodando; uma conta com e-mail verificado; **duas** empresas (A e B), cada uma com um serviço (30 min, intervalo 10 min, R$ 50,50), um profissional vinculado e expediente cobrindo os dias de teste (a empresa A num fuso diferente do navegador, por exemplo `America/New_York`, para exercitar o fuso). Uma segunda janela/aba do navegador para os cenários de concorrência.

| # | Cenário | Passos | Resultado esperado |
|---|---|---|---|
| 1 | Acesso | Abrir `/agenda` sem sessão. | Redireciona para `/entrar`; após entrar, volta a `/agenda`. |
| 2 | Empresa ativa | Entrar e escolher a empresa A; abrir **Agenda**. | Item "Agenda" destacado; cabeçalho "Horários na hora local da empresa (fuso da A)". Sem empresa ativa ⇒ vai para `/empresas`. |
| 3 | Visão diária | Estar no dia atual; usar Anterior/Próximo/Hoje e o campo de data. | Título do dia correto no fuso da empresa; no DevTools, `GET /api/appointments` com `from`/`to` = 00:00 local de hoje e do dia seguinte, em UTC; cabeçalho `X-Active-Org` presente; sem `organizationId`. |
| 4 | Visão semanal | Clicar em **Semana**. | Segunda a domingo, um bloco por profissional; `from`/`to` cobrem 7 dias locais; Próximo/Anterior andam 7 dias. |
| 5 | Criar | **Novo agendamento**: nome, telefone `(11) 98765-4321`, profissional, serviço, data; escolher um horário. | Os horários vêm de `GET /api/availability/slots` e mudam ao trocar profissional/serviço/data; ao enviar: `POST` com `Idempotency-Key` UUID, resposta `201`, aviso "Agendamento criado." e o cartão no horário escolhido (hora local da empresa), com duração/intervalo/preço do serviço. |
| 6 | Validações | Enviar vazio; telefone `12`. | Mensagens por campo; telefone inválido vem do servidor (400) e os demais dados permanecem. |
| 7 | Idempotência | Com o DevTools em "Offline", enviar; voltar online e enviar de novo sem alterar nada. | A 2ª tentativa usa a **mesma** `Idempotency-Key`; no máximo um agendamento é criado. Mudando o horário antes de reenviar, a chave muda. |
| 8 | Concorrência de horário | Janela 1: abrir o formulário e escolher o horário H sem enviar. Janela 2: criar um agendamento em H para o mesmo profissional. Janela 1: enviar. | Aviso "O horário escolhido não está mais disponível…"; nome/telefone/e-mail mantidos; H some da lista; nenhum horário fica marcado; escolher outro e enviar funciona. |
| 9 | Remarcar | **Remarcar** um agendamento; escolher novo horário. | `POST …/reschedule` com `version` e `startsAt`; aviso "Agendamento remarcado."; cartão no novo horário; duração/preço continuam os do snapshot. Trocando o profissional, o cartão muda de grupo. |
| 10 | Versão desatualizada | Janela 1: abrir **Remarcar** (ou **Cancelar**) sem confirmar. Janela 2: remarcar o mesmo agendamento. Janela 1: confirmar. | Aviso de alteração em outra sessão; a agenda é recarregada com o horário da janela 2; nada é sobrescrito; repetir a ação usa a nova versão. |
| 11 | Cancelar | **Cancelar**, informar (ou não) um motivo, confirmar. | Nada é enviado antes de confirmar; depois, `POST …/cancel`, aviso "Agendamento cancelado.", cartão "Cancelado" com o motivo e sem botões; o horário volta a aparecer nos slots; nenhuma exclusão física. |
| 12 | Sessão expirada | Em outra aba, **Sair**; na primeira, clicar em **Atualizar** (ou confirmar um cancelamento). | Volta ao login com "Sua sessão terminou."; sem mensagem crua de erro; ao entrar, retorna a `/agenda`; nenhuma ação é exibida como concluída. |
| 13 | Passado | No formulário, digitar uma data de ontem; deixar a tela aberta até o horário escolhido passar e enviar. | Data passada não busca horários nem envia; horário vencido é bloqueado antes do envio ("Esse horário já passou…"). Via API (curl) um `startsAt` passado devolve `422 STARTS_AT_IN_PAST`. |
| 14 | Fuso | Comparar um agendamento criado para 10:00 da empresa com o fuso do sistema operacional diferente. | O cartão mostra 10:00 do fuso da **empresa**, não do navegador. Testar também uma data de transição de horário de verão (empresa em Nova York, 09/03/2031). |
| 15 | Isolamento | Trocar para a empresa B pelo seletor. Em outra aba, ainda na A, fazer uma requisição depois da troca. | A agenda de B não mostra dados de A; uma aba desatualizada recebe `409 ACTIVE_ORG_CHANGED` e recarrega; um `id` de agendamento de A usado pela empresa B responde 404. |
| 16 | Celular | Largura de ~375 px. | Sem rolagem horizontal da página; semana em uma coluna; formulários utilizáveis. |

### 5.1 Execução manual de 20/10/2026 (backend real + Vite + Chrome) — resultados observados

Ambiente: backend (`NODE_ENV=development`) e frontend Vite locais, banco **descartável** criado só para isto (já removido; o banco de desenvolvimento não foi tocado), conta de teste e duas empresas (A: `America/New_York`; B: `America/Sao_Paulo`; navegador em `America/Sao_Paulo`). Os dados iniciais (conta, empresas, serviços, profissionais, expediente) foram criados pela API do próprio app; os cenários abaixo foram exercitados pela interface, e as ações de uma "segunda janela/sessão" foram simuladas por chamadas à API na mesma sessão do navegador.

| # | Cenário | Resultado |
|---|---|---|
| 1 | Acesso sem sessão | **Não verificado nesta execução** (coberto só pelo teste automatizado) |
| 2 | Empresa ativa | **Aprovado**: a agenda mostra "Horários na hora local da empresa (America/New_York)". O banner de e-mail apareceu; na época o texto não refletia a regra efetiva da API (prometia "publicar sua página"). Texto e regra foram corrigidos depois, no item 3 (ver `docs/EMAIL-VERIFICATION.md`) |
| 3 | Visão diária | **Aprovado**: dia local correto; `from`/`to` do dia em UTC (25 h em 01/11/2026, fim do horário de verão) |
| 4 | Visão semanal | **Aprovado**: segunda a domingo (19–25/10), um bloco por profissional e dia, 7 dias consultados; Próximo/Anterior/Hoje andam 7 dias |
| 5 | Criar | **Aprovado**: horários reais da API (08:00 em Nova York, não no fuso do navegador), 10:00 ⇒ `2026-10-20T14:00Z`, `201`, aviso, cartão 10:00–10:30 com 30 min + 10 min e R$ 50,50 |
| 6 | Validações | **Aprovado**: 5 mensagens locais com o formulário vazio; telefone `12` ⇒ `400` do servidor exibido no campo, dados mantidos |
| 7 | Idempotência | **Aprovado com ressalva**: a perda de resposta foi simulada no navegador (o servidor gravou e o app viu erro de rede; não foi o DevTools offline). O reenvio usou a **mesma `Idempotency-Key` e o mesmo corpo**, o servidor respondeu `201` com `Idempotent-Replay: true` e existe **um** agendamento |
| 8 | Concorrência de horário | **Aprovado**: outra "janela" ocupou o horário; o envio recebeu `409`, aviso exibido, nome/telefone/e-mail/profissional/serviço mantidos, 12:00 sumiu da lista, nenhum horário marcado |
| 9 | Remarcar | **Aprovado**: `POST …/reschedule` com `startsAt` e `version`, `200`, cartão no novo horário. Observado: o próprio horário atual não é oferecido (limitação conhecida) |
| 10 | Versão desatualizada | **Aprovado** para remarcar e cancelar: `409`; a alteração da outra sessão foi preservada no servidor; a tela avisou, recarregou e fechou o editor |
| 11 | Cancelar | **Aprovado**: nada enviado antes de confirmar; `{version, reason}`, `200`, cartão "Cancelado" com motivo e sem botões, nenhum `DELETE` |
| 12 | Sessão expirada | **Aprovado com ressalva**: após encerrar a sessão e clicar em Atualizar, volta ao login com "Sua sessão terminou." e sem erro cru. Ao entrar de novo o usuário caiu em `/empresas`, **não** em `/agenda`: a nova sessão não tem empresa ativa. O roteiro esperava voltar a `/agenda`; não confirmei se o destino chegou a ser aplicado antes do redirecionamento por falta de empresa |
| 13 | Passado | **Aprovado**: campo com `min` = hoje; data passada não consulta horários nem envia; o servidor real respondeu `422 STARTS_AT_IN_PAST` a um `startsAt` passado. O bloqueio de "horário vencido durante a tela aberta" não foi exercitado (só no teste automatizado) |
| 14 | Fuso | **Aprovado**: empresa em Nova York com navegador em São Paulo mostra os horários de Nova York; semana de 26/10–01/11 e dia 01/11 com os limites UTC corretos |
| 15 | Isolamento | **Aprovado**: com a empresa B ativa, a lista da A vem vazia; `GET`/`cancel`/`reschedule` de um id da A ⇒ `404`; criar e consultar slots com profissional da A ⇒ `404`; `X-Active-Org: salao-a` com B ativa ⇒ `409 ACTIVE_ORG_CHANGED`; `organizationId` no corpo ⇒ `400`; a A permaneceu intacta |
| 16 | Celular | **Aprovado com ressalva**: a janela do Chrome não pôde ser redimensionada; foi medido um iframe de 375 px (mesma origem): sem rolagem horizontal, semana em 1 coluna, formulário sem elementos além da largura. Não é um aparelho real |

Não executados: cenário 1 e o bloqueio de horário vencido (13); captura de tela do celular. O resultado completo dos testes automatizados continua na seção 4.

## 6. Limitações, riscos e cenários não cobertos

- **Validação manual com backend real e verificação visual não foram feitas.** Só testes automatizados contra backend falso.
- **Sem grade de horas posicionada por pixel:** os agendamentos são listas ordenadas por horário, agrupadas por profissional (e por dia na semana), cada um com seu horário local. Sobreposições (por exemplo, um cancelado e um ativo no mesmo horário) aparecem como itens consecutivos.
- **Um agendamento que atravessa a meia-noite** aparece no dia em que começa (ou no primeiro dia exibido, se começou antes do período) com a data completa.
- **Remarcar × slots (auditoria final, confirmado no código):** `listAvailableSlots` (`availability/service.ts`) calcula com a duração e o intervalo ATUAIS do serviço (`computeSlots`) e só devolve horários se o serviço estiver ativo; já `moveAppointment` (`appointments/service.ts`) recalcula a faixa com os SNAPSHOTS (`computeAppointmentRange(..., durationMinutesSnapshot, bufferMinutesSnapshot)`) e não exige serviço ativo. Consequências: (a) se o snapshot exige mais que o serviço atual (duração maior, ou duração + intervalo maiores), a tela pode oferecer um horário que o servidor recusa (`409 SLOT_UNAVAILABLE` pela exclusão do banco, ou `409 PROFESSIONAL_UNAVAILABLE` fora do expediente); (b) os slots tratam o próprio agendamento como ocupado, então horários que se sobrepõem à faixa atual dele não são listados, embora o servidor os aceitasse; (c) com o serviço desativado não há slots, embora o servidor permitisse remarcar. Sem alterar o backend não há como calcular o horário exato no frontend (exigiria expediente, folgas e agenda), então a tela **avisa** nos casos (a) e (c), mostra uma nota fixa sobre (b) e trata a recusa sem perder o formulário. Alternativas que dependem de autorização (não implementadas): um parâmetro opcional `appointmentId` em `/api/availability/slots` que use os snapshots e ignore o próprio agendamento.
- **Lista de 500:** o servidor ordena por início e corta em 500 (`listMax`), sem paginação nem total; a tela só avisa quando recebe 500 itens, e os mais tardios do período podem estar ocultos.
- **Cliente novo a cada criação:** a criação envia `customer` (o servidor reaproveita o cliente pelo telefone sem sobrescrever dados guardados). Não há busca/seleção de cliente existente nem campo de observações.
- Não há ações de confirmar, concluir, não compareceu e reativar (rotas existem no backend).
- Perda de resposta com sucesso no servidor (rede caiu depois do commit): o retry com a mesma chave devolve o mesmo `201` por replay; isso é garantido pelo backend e só exercitado aqui no servidor falso.
- A semana começando na segunda-feira e a ordenação por horário são decisões de UI a confirmar.
- Acessibilidade: rótulos, `aria-pressed`, `role=alert/status`, regiões com nome e `fieldset/legend` nos horários; sem auditoria formal de contraste nem teste de leitor de tela.

## 7. Atualização documental sugerida ao `ARCHITECTURE.md` (NÃO aplicada)

Registrar em 11 (Etapa 13) a rota `/agenda`, o uso de `Idempotency-Key` pelo cliente (`RequestOptions.headers`), a regra de reaproveitar a chave só para o mesmo conteúdo, a janela de consulta (dia/semana locais em UTC) e as limitações da seção 6.
