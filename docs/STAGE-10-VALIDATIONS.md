# Etapa 10 — Agendamentos (núcleo)

> Status: **segunda rodada de revisão humana aplicada (seção 9).** O `docs/ARCHITECTURE.md` **não** foi alterado; a atualização
> sugerida está no anexo (diff pronto). Nenhuma validação `[VALIDAR]` mudou de estado. Sem commit e sem push.

## 1. Escopo (seção 11 do plano)

"`Customer`, `Appointment`, `IdempotencyRecord`; migration manual da constraint e da coerência de `blocked_until`; criar/remarcar/cancelar/confirmar
com a hierarquia N1→N4 e a tabela de operações de 6.5; rejeição de `TimeOff`/`WorkingHours` conflitantes com a lista (R4); proibição de passado (R7).
**O limite de 3 por telefone e os limites públicos não entram aqui** (etapa 14)." Aceite: testes de 6.1 (1–10), 6.4 (1–9) e de concorrência
**L1–L4, L6, L7, L9 (completo), L11–L15**; `blocked_until` coerente; editar serviço depois não muda agendamentos; passado ⇒ erro; transições inválidas
rejeitadas; A×B verde.

Conferido antes de começar: Etapa 9 commitada e enviada (`4e0feb7` = `origin/main`), árvore limpa.

**Fora do escopo (continua pendente):** página pública, limite de 3 por telefone, antecedência mínima/máxima de 6.7, honeypot e rate limit públicos
(Etapa 14, **P1–P7**); frontend (Etapas 11–13); exportar/anonimizar cliente (`customers.privacy`); listagem/criação avulsa de clientes.

## 2. Rotas e permissões (todas `access: "tenant"`; escrita exige Origin e JSON; respostas `no-store`)

| Rota | Ação (`can`) | Resultado |
|---|---|---|
| `POST /api/appointments` | `appointments.create` | `201`. **`Idempotency-Key` (UUID) obrigatório** (`400 IDEMPOTENCY_KEY_INVALID`). Corpo: `professionalId`, `serviceId`, `startsAt` (ISO com fuso, grade de 15 min), e **`customerId` ou `customer {name, phone, email?, notes?}`**. Replay: mesmo status e corpo + `Idempotent-Replay: true`. |
| `GET /api/appointments?from&to[&professionalId&customerId&status]` | `appointments.read` | Período obrigatório (≤ 93 dias), até 500 itens, por início. Sobreposição parcial com o período entra. |
| `GET /api/appointments/:id` | `appointments.read` | 404 idêntico para inexistente, malformado **e** de outra empresa. |
| `POST /api/appointments/:id/reschedule` | `appointments.reschedule` | `startsAt`, `version`, `professionalId?` (outro profissional). |
| `POST /api/appointments/:id/reactivate` | `appointments.set_status` | `CANCELLED → SCHEDULED` revalidando tudo. |
| `POST /api/appointments/:id/cancel` | `appointments.cancel` | `version`, `reason?`. |
| `POST /api/appointments/:id/confirm` | `appointments.confirm` | `SCHEDULED → CONFIRMED`. |
| `POST /api/appointments/:id/complete` · `/no-show` | `appointments.set_status` | `→ COMPLETED` / `NO_SHOW` (terminais), **só depois do fim do atendimento** (`422 APPOINTMENT_NOT_FINISHED`). |
| `GET /api/availability/slots?professionalId&serviceId&date` | `availability.read` | `computeSlots` com dados reais; leitura **sem lock** (L15). |
| `GET /api/customers/:id` · `PATCH /api/customers/:id` | `customers.read` / `customers.write` | `name`, `phone`, `email`, `notes`; telefone repetido ⇒ `409 CUSTOMER_PHONE_TAKEN`. |

`organizationId`, `userId` e fuso vêm **somente** do contexto validado da sessão (`TenantContext` ganhou `organizationTimezone`, lido da empresa ativa). `.strict()` rejeita
`organizationId`, `id`, `status`, `source`, `endsAt`, `blockedUntil` e `createdByUserId` (nenhum desses é aceito do cliente).

### Códigos de erro (novos)
`409 SLOT_UNAVAILABLE` (exclusão `23P01`) · `409 PROFESSIONAL_UNAVAILABLE` (fora do expediente, em folga, profissional inativo) · `409 STALE_VERSION` · `409 INVALID_STATUS_TRANSITION` ·
`409 IDEMPOTENCY_KEY_REUSED` · `409 TIMEOFF_CONFLICTS_WITH_APPOINTMENTS` / `409 WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS` (ambos com `details {conflicts, totalCount, truncated}`) · `422 STARTS_AT_IN_PAST` ·
`422 STARTS_AT_TOO_FAR` · `422 SERVICE_NOT_AVAILABLE` · `422 APPOINTMENT_NOT_FINISHED` · `400 IDEMPOTENCY_KEY_INVALID`. Recurso inexistente ou de outra empresa continua `404` indistinguível. `503 TEMPORARILY_BUSY` vem do tratador global.

## 3. Regras de negócio e invariantes

**Aplicação (sob a trava N2, `Clock` injetável):** `starts_at` futuro (R7) e ≤ 730 dias; início na grade de 15 min (relógio local) sem segundos/milissegundos; `[starts_at, ends_at)` cabe inteiro num
intervalo de `WorkingHours` do dia local e não intersecta `TimeOff` (o buffer **não** entra: R3); profissional ativo; criar exige serviço ativo **e** vínculo; remarcar/reativar exigem profissional de destino ativo e vinculado
(o serviço pode ter sido desativado depois). `computeAppointmentRange` é a única função que calcula `ends_at`/`blocked_until`. Remarcar mantém os snapshots originais. Cliente existente pelo telefone **não é sobrescrito**.

**Banco (migration `20261019230000_appointments`):** `customers` (`UNIQUE (org, id)`, `UNIQUE (org, phone_e164)`, `CHECK` E.164), `appointments`, `idempotency_records` (`UNIQUE (org, scope, key)`, FK composta para o agendamento);
FKs compostas `(organization_id, …)` `RESTRICT/RESTRICT` para profissional, serviço e cliente; **SQL manual**: `btree_gist`, `appointments_range_valid`, `appointments_range_coherent` (V8 opção 1, `make_interval`),
`appointments_no_overlap` (`EXCLUDE … tstzrange(starts_at, blocked_until, '[)') WHERE status IN ('SCHEDULED','CONFIRMED')`) e o índice parcial `appointments_active_idx` (V4). A exclusão é a **última linha de defesa**: a aplicação não faz pré-checagem de sobreposição.

**Transições** (`nextStatus`, função única): `SCHEDULED→CONFIRMED`; `SCHEDULED|CONFIRMED→COMPLETED|NO_SHOW|CANCELLED`; `CANCELLED→SCHEDULED`. `COMPLETED` e `NO_SHOW` são terminais e **só podem ser aplicados depois do fim do atendimento** (`ends_at <= now`, relógio injetado; antes disso `422 APPOINTMENT_NOT_FINISHED`; seção 9). Cancelar grava `cancelled_at` (relógio) e motivo; nunca `DELETE`.

**R4 (rejeita com a lista; nada é cancelado):** criar/alterar `TimeOff` ⇒ agendamentos **ativos e não terminados** cuja faixa de atendimento `[starts_at, ends_at)` intersecta a folga. Alterar/remover/mover `WorkingHours` ⇒ os que **cabiam** no expediente
anterior e deixariam de caber no novo (criar um intervalo novo nunca conflita). Lido sem lock: consistente porque todo escritor de agendamento ativo trava N2.

## 4. Estratégia de locks e concorrência

Ordem global (6.5): **N1** cliente → **N2** profissional(is) ordenados → **N3** idempotência → **N4** escrita. Tudo em `lib/db/locks` (`booking.ts` novo; mesmo guard e mesmo `runLocked` da Etapa 9; nenhum segundo mecanismo).

| Operação | Locks, em ordem |
|---|---|
| Criar | N1 (`customerId`: `SELECT … FOR NO KEY UPDATE`; novo: `INSERT … ON CONFLICT DO NOTHING` + trava) → N2 → N3 (`INSERT … ON CONFLICT DO UPDATE … WHERE expirado`, V13) → N4 (`INSERT` + preenche o resultado da idempotência, tudo no mesmo commit) |
| Remarcar / reativar | leitura sem lock → N2 `{origem, destino}` (ordenados) → N4 (relê com trava; profissional ou `version` mudou ⇒ `409 STALE_VERSION`) |
| Cancelar / confirmar / concluir / não compareceu | só N4: `UPDATE … WHERE id AND version AND status` (não trava profissional: não ocupa horário) |
| Editar cliente | N1 |
| TimeOff / WorkingHours | N2 → N4 (inalterado, agora com a checagem R4 sob a trava) |
| Slots | nenhum |

- Todos usam `runLocked` (`lock_timeout` 2 s, transação 8 s); `55P03`/`40P01`/`P2028`-timeout ⇒ `503 TEMPORARILY_BUSY` com rollback total.
- O 23P01 da exclusão é capturado e vira `409 SLOT_UNAVAILABLE`; uma falha em qualquer passo desfaz também o cliente novo e o registro de idempotência (**só sucessos são registrados**).
- `lockProfessionals([origem, destino])` emite as travas em ordem crescente; o guard (`LockOrderViolation`) vale para N1/N3/N4 desde a Etapa 9 e agora é exercitado de verdade.
- `IdempotencyRecord` nunca fica "em andamento" depois do commit; a validade usa o `now()` do banco, o mesmo da limpeza (`runMaintenance`, `SKIP LOCKED`, margem 1 h).

## 5. Testes e resultados reais

| Verificação | Resultado |
|---|---|
| `npm test` (suíte completa, executada **uma vez** ao final) | **693 testes em 44 arquivos, todos passando** (eram 502 / 37: +191 testes, +7 arquivos; +48 na rodada de revisão da seção 9) |
| `npm run lint` | 0 erros |
| `npm run typecheck` | 0 erros |
| `npm run format:check` | "All matched files use Prettier code style!" |
| `git diff --check` | exit 0, sem saída |
| `npm run db:drift` (banco de desenvolvimento) | "No difference detected." |
| Migrations em banco limpo (`agendly_tmp_s10check`, criado e descartado) | 7 aplicadas; `db:drift` ⇒ "No difference detected"; `migrate status` ⇒ "up to date" |
| Checksums de `_prisma_migrations` | idênticos em `agendly`, `agendly_tmp_s10check` e `agendly_test` (7 migrations) |

Antes e depois da verificação existiam só `agendly`, `agendly_spike`, `agendly_test` e `postgres`. A migration foi **aplicada** (aditiva) a `agendly` e `agendly_test`; nada foi apagado e nenhuma migration anterior foi tocada.

### Mapa dos testes (tipo de cada um)
| Arquivo | Testes | Tipo | Cobre |
|---|---|---|---|
| `test/appointments/unit.test.ts` | 79 | **unitário** (sem banco) | normalização de telefone (P2), `computeAppointmentRange`, matriz completa de transições (5 × 5), hash canônico (6.4 teste 7), `fitsWorkingHours` (incl. horário de verão), esquemas de entrada |
| `test/appointments/constraint.test.ts` | 14 | **integração**, SQL cru | 6.1 **1–10** (exclusão, encostar, buffer, reativar falha, UPDATE sem autoconflito, FK composta, 8 concorrentes **com** e **sem** lock, constraints no catálogo, incoerência/atualização parcial ⇒ `23514`); unicidade de telefone, E.164, `RESTRICT`, idempotência |
| `test/appointments/appointments.test.ts` | 41 | **integração** (API + Postgres) | criação e validações, snapshots (6.3), R3, R7, 404 indistinguível, conflitos e rollback do cliente, consulta, remarcar, transições, reativar, clientes, slots, **R4** (TimeOff e WorkingHours com lista), **6.4 1, 2, 3, 5, 6, 7, 9** |
| `test/appointments/concurrency.test.ts` | 18 | **integração determinística** (outra conexão SEGURA a trava) + amostragem onde indicado | **L1, L2, L3, L13, L14, L15**, 8 criações no mesmo slot, **L12** (amostragem), **6.4 4 e 8** |
| `test/appointments/stress.test.ts` | 7 | **integração por amostragem** (sementes fixas, `deadlock_timeout = 50 ms` no pool da API) | **L4** (2 sementes × 160 ops), **L6** (14 + 8 rodadas), **L7** (2 sementes × 220 ops de todas as operações de 6.5) |
| `test/appointments/review.test.ts` | 14 | **integração** | revisão da seção 9: conclusão só após o fim (limites de 1 ms, buffer, ordem das checagens, remarcação, corrida), R4 com `totalCount`/`truncated` |
| `test/appointments/locks.test.ts` | 10 | **integração** | **L9 completo** (ordem N1→N2→N3→N4 nas consultas emitidas; cancelar/confirmar não travam profissional), ordenação de dois profissionais nos dois sentidos, **L10** (503 e nada gravado), sem ruído de violação no log |
| `test/org/isolation.test.ts` (+8) | 30 | **integração** | A×B de agendamentos, clientes, slots e idempotência; sentinela de SQL; FKs compostas (agora 8 entre tabelas escopadas, todas compostas) |
| ajustes em `locks-static`, `static-rules`, `permissions`, `email/infra` | — | estático/integração | detector de escrita-folha agora cobre `appointment.create/update`; allowlist de SQL cru; ações de agendamento; resultado de `runMaintenance` |

Nenhum teste foi removido nem enfraquecido. Duas relaxações **revisadas** nos testes estáticos: `lib/db/locks/booking.ts` entrou na allowlist de SQL cru, e a regra "SQL em tabela escopada cita `organization_id`" tem a exceção explícita da limpeza por vencimento (`maintenance.ts`), que atravessa empresas por desenho e não lê dados.

### Detectores verificados por mutação (revertidas depois)
- Inverti N1/N2 em `createAppointment` (profissional antes do cliente): `LockOrderViolation`, teste de criação falhou.
- Removi a trava N2 de `moveAppointment`: `LockCoverageViolation` (`enterLeafWrite` sem a trava), teste de remarcação falhou.
- Autotestes dos detectores estáticos (violação e forma correta), inclusive para `appointment.create` sem lock e `updateMany` de status (que **não** exige N2).

## 6. Evidências específicas

**Concorrência (o que é demonstrado × o que é amostragem):**
- *Determinístico* (uma conexão `pg` segura de fato a trava): L1 e L2 nos dois sentidos (a requisição fica pendente > 700 ms e só termina depois do commit, falhando com o erro certo), L3 (outro profissional responde em < 1 s),
  L13 (`STALE_VERSION` quando o agendamento muda de profissional entre a leitura e a trava), L14 (criação por `customerId` espera N1), L15 (slots respondem com profissional e cliente travados), 6.4 teste 8 (linha reivindicada por transação aberta é pulada pela limpeza).
- *Amostragem*: 8 criações simultâneas do mesmo slot × 3 rodadas ⇒ sempre 1 × `201` e 7 × `409 SLOT_UNAVAILABLE` (sem 5xx, sem `40P01`); L12 (10 rodadas cancelar × remarcar: sempre `[200, 409 STALE_VERSION]`, estado final coerente com o vencedor; 8 rodadas cancelar × TimeOff:
  nunca sobra ativo dentro da folga); 6.4 teste 4 (5 requisições simultâneas × 4 rodadas ⇒ 1 agendamento, 4 replays); L6 (A→B × B→A, 14 rodadas, ordem de início aleatória ⇒ sempre `[200, 200]`); L4 e L7 (invariantes no banco ao final: nenhum par de ativos sobreposto, nenhum ativo
  não terminado dentro de folga ou fora do expediente, nenhum registro de idempotência "em andamento"; **zero** `40P01`, `LockOrderViolation`, `LockCoverageViolation`, `55P03` e `TEMPORARILY_BUSY` nos logs). Os resultados de L4, L6 e L7 são **evidência por amostragem, não prova de ausência de deadlock**.
- Sem o lock N2, a exclusão ainda mantém a invariante (6.1 teste 8b: 1 sucesso; perdedores `23P01` ou `40P01`); com o lock: 1 sucesso e 7 × `23P01` em < 900 ms.

**Multi-tenant:** A×B para todas as 12 rotas novas (404 indistinguível do inexistente, nada muda em B, `organizationId` ⇒ 400, `X-Active-Org` de B ⇒ 409, mesma chave de idempotência e mesmo telefone em empresas diferentes são independentes, sentinela de SQL em `appointments`, `customers` e `idempotency_records`);
as 8 FKs entre tabelas escopadas são compostas (varredura do catálogo) e `appointments` recusa profissional, serviço e cliente de outra empresa por SQL cru (`23503`, com o nome da FK esperada).

## 7. Decisões que exigem aprovação

1. **Contrato HTTP** (o plano não define rotas de agendamento): ações como `POST /:id/<ação>` com `version` no corpo; `GET /api/availability/slots` para L15; clientes apenas `GET`/`PATCH /:id` (a criação acontece pelo agendamento; listar/buscar clientes fica para a UI da Etapa 13).
2. **Códigos e a divisão 409 × 422** (seção 2): conflito de estado ⇒ 409; regra de negócio violada (passado, longe demais, serviço não oferecido) ⇒ 422.
3. **Normalização de telefone** sem biblioteca externa, endurecida na revisão (seção 9): Brasil validado como a libphonenumber o faz (fixo 2–5, celular com 9, prefixo `0`); fora do Brasil, só sintaxe. Alternativa: `libphonenumber-js` (nova dependência).
4. **Transições:** `COMPLETED` e `NO_SHOW` terminais; remarcar mantém o status (`CONFIRMED` continua); reativar só de `CANCELLED`; concluir/marcar não comparecimento só depois de `ends_at` (seção 9; decisão a aprovar).
5. **Remarcar/reativar** exigem profissional de destino ativo e vinculado, **não** exigem o serviço ativo (o agendamento usa snapshots). Criar exige as duas coisas.
6. **Limite de sanidade de 730 dias** para o painel (14.3).
7. **Cliente existente pelo telefone não é sobrescrito, também no painel** (o plano só afirma isso para a página pública).
8. **R4 em `WorkingHours`:** conflito = agendamento ativo, não terminado, que cabia antes e não cabe depois; `details` traz `conflicts` (até 100, por início), `totalCount` (total real) e `truncated` (seção 9; contrato a aprovar).
9. **Idempotência:** o corpo guardado é a resposta original (inclui o nome do cliente) e vive até 24 h + margem; escopo `appointments.create`; validade por `now()` do banco.
10. **`CHECK` E.164 em `customers`** e FK simples `created_by_user_id → users` (`RESTRICT`), além do que o plano pedia.
11. **Mudanças nas Etapas anteriores:** `AvailabilityScope` agora exige `timezone` e `now` (os testes da Etapa 9 foram ajustados); `TenantContext` ganhou `organizationTimezone`; `runMaintenance` devolve também `idempotency`.

## 8. Limitações, riscos e pendências

- Concorrência provada só por amostragem e pelos entrelaçamentos forçados listados; os testes passaram na 1ª execução e as sementes são fixas (reproduzíveis), mas não houve varredura de muitas sementes.
- Sem rate limit nas rotas do painel (o plano o prevê para a página pública, Etapa 14); sem verificação da redaction de telefone/e-mail em logs (Etapa 15).
- A listagem corta em 500 itens **sem indicador**; o período máximo de 93 dias limita o efeito.
- A lista de conflitos de R4 é limitada a 100 itens, **sempre acompanhada do total real e de `truncated`** (seção 9).
- Fusos com transição de 30 minutos e lacunas à meia-noite continuam não testados (herdado da Etapa 9); `fitsWorkingHours` usa o dia local de `starts_at`.
- Replay devolve a resposta **original** mesmo que o agendamento tenha mudado depois (é o contrato de 6.4).
- Pool de 10 conexões: esperas por lock seguram conexões até ~2–4 s (herdado; cenário nº 3 de 6.5).
- `btree_gist` em produção continua **não validada** (Etapa 16); a Etapa 10 depende dela como a 9.
- **Pendente na arquitetura:** limite de 3 por telefone e limites públicos (6.7, **P1–P7**), página pública (14), `customers.privacy`, frontend (11–13), endurecimento e CI (15), deploy (16). `[VALIDAR]` V9–V12 e V14 seguem **não verificados**; V4, V5 e V8 (já resolvidos na Etapa 3) agora têm também a evidência de produção em `constraint.test.ts`.

## 9. Segunda rodada de revisão humana (telefone, conclusão, conflitos R4)

### 9.1 Normalização de telefone — comportamento encontrado e decisão
**Encontrado:** `lib/phone.ts` (sem dependência) aceitava como **fixo** qualquer número de 10 dígitos (inclusive `11 98765-432`, um celular sem o último dígito digitado, e `11 1234-5678`) e rejeitava o prefixo nacional `0`
(`011 98765-4321`), comum no Brasil. Fora do Brasil só há validação sintática (8–15 dígitos). A saída sempre bateu com o `CHECK` E.164 do banco (`^\+[1-9][0-9]{7,14}$`).

**Corrigido (baixo risco):** fixo de 10 dígitos agora exige o número começando em **2–5** e celular de 11 dígitos exige **9** depois do DDD (as mesmas faixas que a libphonenumber usa para o Brasil); o prefixo `0` é aceito e removido. Não há clientes
existentes (nada em produção) e toda saída segue em E.164, então não há migração. Testes novos (34): aceitos/rejeitados brasileiros e internacionais, espaço não separável, dígitos de largura total/árabe-índicos, DDD 11–99 varrido (saída sempre compatível com o `CHECK` do banco e idempotente),
e um teste que **documenta o limite** (`+999 …` e `00 98765-4321` são aceitos porque a validação internacional é só sintática).

**Decisão recomendada (a aprovar): manter a implementação própria no MVP; não adicionar `libphonenumber-js` agora.** Motivos: o produto é só pt-BR e o Brasil está coberto; a biblioteca (MIT, sem dependências, `1.13.15`, ~10 MB desempacotados e centenas de KB de metadados no bundle
do navegador se for usada no frontend) acrescenta superfície de cadeia de suprimentos e atualizações constantes de metadados; o MVP não verifica telefone por OTP (fora do MVP). **Quando reavaliar:** (a) a Etapa 14, se o abuso por números falsos de outros países se mostrar real; (b) a integração com WhatsApp
(pós-MVP), onde número inválido custa mensagem. Se aprovada depois, a troca é local (`normalizePhone`) e os testes de contrato desta etapa continuam valendo, mas os que documentam o limite sintático deveriam passar a rejeitar.

### 9.2 Concluir / não comparecer
**Encontrado:** não existia nenhuma regra de data. `complete` e `no-show` eram aceitos a qualquer momento (testes antigos concluíam atendimentos **futuros**). Como `COMPLETED`/`NO_SHOW` são terminais e **liberam a faixa** na exclusão, concluir um horário futuro ou em andamento
liberava, de forma irreversível, aquele horário para outro agendamento. O plano só afirma que "marcar COMPLETED/NO_SHOW … cujo horário já passou é permitido".

**Corrigido (menor mudança compatível com o plano):** `complete` e `no-show` exigem `ends_at <= now()` com o `Clock` injetado (`requiresFinished` em `transitions.ts`; checagem em `changeStatus`); caso contrário `422 APPOINTMENT_NOT_FINISHED` e nada muda. Fronteiras testadas: antes do início, no meio, **1 ms antes do fim (recusa)**,
exatamente em `ends_at` e dentro do buffer (aceitam). `cancel` e `confirm` **não** têm a restrição. Ordem das checagens: 404 → `STALE_VERSION` (409) → transição inválida (409) → `APPOINTMENT_NOT_FINISHED` (422). **Concorrência:** o `ends_at` vem da mesma leitura cuja `version` guarda o `UPDATE`; se uma remarcação concorrente
muda o horário a versão muda e o `UPDATE` não casa — teste determinístico segura a linha numa transação, move o atendimento para o futuro e confirma `STALE_VERSION`, sem concluir. Remarcar um atendimento já terminado para o futuro volta a bloquear a conclusão (vale o `ends_at` atual).
Quatro testes antigos que concluíam atendimentos futuros foram ajustados para avançar o relógio de teste (ou pôr o status direto no banco quando o objetivo era outro); nenhum foi removido ou enfraquecido.

**Fica para sua aprovação:** (1) a regra em si e o novo código `422 APPOINTMENT_NOT_FINISHED`; (2) alternativa mais branda para o **não comparecimento**: exigir só `starts_at <= now` (o cliente já faltou depois de certo tempo) — **não recomendo**, porque libera um horário em andamento; (3) corrigir erro de marcação (`COMPLETED`/`NO_SHOW` são terminais): hoje não há como desfazer.

### 9.3 Conflitos de R4
**Encontrado:** `TimeOff` consultava os conflitos no banco (filtro por profissional, status ativo e interseção, índice parcial) mas **sem limite**; `WorkingHours` carregava todos os ativos futuros do profissional (campos mínimos) e filtrava na aplicação por "cabia antes e não cabe depois" (depende de fuso e intervalos,
não vira SQL). A resposta devolvia todos, então no pior caso (apagar o expediente de quem tem a agenda cheia) crescia sem teto.

**Implementado (aditivo, compatível):** `details` continua com `conflicts` (agora no máximo **100**, por início) e ganhou **`totalCount`** (total real) e **`truncated`** (`totalCount > conflicts.length`). `TimeOff`: `COUNT` no banco + `LIMIT 100`; `WorkingHours`: filtragem em memória (só campos mínimos) e `slice(0, 100)`; a rejeição continua atômica (nada é gravado) e nenhum agendamento é cancelado.
Testes: 1, 99, 100 (`truncated=false`), 101 e 130 (`truncated=true`), ordem por início, resposta < 64 KB, folga e agendamentos intactos; `PATCH` de folga; `WorkingHours` com 130 agendamentos: 130 / 100 / truncated, cancela os listados e repete (restam 30, lista **completa**), cancela o resto e a remoção passa.

**Contrato proposto (a aprovar) e efeito no frontend (Etapa 12):** o aviso deve ser "N agendamentos afetados" usando `totalCount`; quando `truncated`, mostrar os 100 primeiros com "e mais N" e orientar a resolver (cancelar/remarcar) e **repetir** a alteração; não há paginação porque resolver os listados revela os próximos e a agenda é consultável com `GET /api/appointments` por período.
**Alternativas não adotadas:** paginação por cursor (exigiria uma rota de pré-visualização e estado no cliente) e um endpoint de "prévia" separado (mais superfície; só vale se o fluxo de resolução em lote for necessário).
**Limite residual:** `WorkingHours` ainda lê todos os ativos futuros do profissional (campos mínimos, sem `take`); com dezenas de milhares de linhas isso custaria memória/tempo. Para o MVP (uma agenda por profissional) é aceitável; se virar problema, a saída é limitar a varredura por janela de datas.

### 9.4 Verificações desta rodada
Mutações (revertidas): desligar a checagem de fim e forçar `truncated=false` derrubam, respectivamente, 3 e 4 testes novos. Suíte completa: **693 testes em 44 arquivos passando** (uma execução). Lint, typecheck, `format:check`, `git diff --check` e `db:drift` abaixo. Nenhuma migration nem o schema mudaram nesta rodada.

## Anexo — atualização sugerida ao `docs/ARCHITECTURE.md` (NÃO aplicada)

Registra as entidades como implementadas, as rotas e ações, os códigos de erro, as transições, o contrato de idempotência e a decisão do limite de 730 dias. Nenhuma validação `[VALIDAR]` muda de estado; os itens que dependem de aprovação (seção 7) estão marcados como "a aprovar".

```diff
--- a10/docs/ARCHITECTURE.md
+++ b10/docs/ARCHITECTURE.md
@@ -360,9 +360,9 @@
 | **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. **Banco (Etapa 8):** PK `(professional_id, service_id)`; as duas FKs `(organization_id, …)` são `ON DELETE RESTRICT ON UPDATE RESTRICT` (nunca `SET NULL`); índice `(organization_id, service_id)`. Sem `id` próprio. |
 | **WorkingHours** | id, organization_id, professional_id, weekday (0–6), **start_minute, end_minute** | Hora **local** da empresa, guardada como **minutos desde 00:00** (0–1440; `1440` = meia-noite seguinte), e **não** como `start_time`/`end_time` (decisão da Etapa 9: o `time` do PostgreSQL chega ao Prisma como `Date` de 1970 e não representa `24:00`). A API usa `"HH:mm"`. `weekday` 0 = domingo. Vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. **Banco (Etapa 9, intencional):** FK composta `(organization_id, professional_id)` `RESTRICT/RESTRICT`; `CHECK` de faixa e de grade; `EXCLUDE USING gist` (profissional, dia, `int4range(start, end, '[)')`) como rede de segurança da validação feita sob a trava N2 (exige a extensão `btree_gist`). Linhas podem ser apagadas fisicamente (são folhas). |
 | **TimeOff** | id, organization_id, professional_id, starts_at, ends_at, reason | `CHECK (ends_at > starts_at)`. **Banco (Etapa 9):** FK composta para o profissional (`RESTRICT/RESTRICT`). Linhas podem ser apagadas fisicamente (são folhas). Folgas podem se sobrepor entre si. Tetos de sanidade só na API: duração ≤ 366 dias, datas entre 2000 e 2100, motivo ≤ 200 caracteres, 1000 folgas por profissional. |
-| **Customer** | id, organization_id, name, phone_e164, email?, notes? | `UNIQUE(organization_id, phone_e164)`. Dado pessoal (LGPD). Criação pela página pública **não sobrescreve** dados de cliente existente. Sem campos de nicho (D13). |
-| **Appointment** | id, organization_id, professional_id, service_id, customer_id, **starts_at, ends_at, blocked_until**, status, `service_name_snapshot`, `duration_minutes_snapshot`, `buffer_minutes_snapshot`, `price_cents_snapshot`, source (`PANEL`/`PUBLIC`), created_by_user_id?, cancelled_at?, cancel_reason?, version | `ends_at = starts_at + duração`; `blocked_until = ends_at + buffer` (6.1 e 6.3). Remarcar mantém os snapshots originais. |
-| **IdempotencyRecord** | id, organization_id, key, scope, request_hash, appointment_id?, response_status, response_body, created_at, expires_at (= created_at + 24 h) | Seção 6.4. `UNIQUE (organization_id, scope, key)`. |
+| **Customer** | id, organization_id, name, phone_e164, email?, notes? | `UNIQUE(organization_id, phone_e164)`. Dado pessoal (LGPD). Criação pela página pública **não sobrescreve** dados de cliente existente. Sem campos de nicho (D13). **Banco (Etapa 10):** `CHECK` de formato E.164 (`^\+[1-9][0-9]{7,14}$`), `UNIQUE (organization_id, id)` (alvo da FK composta de `appointments`) e `UNIQUE (organization_id, phone_e164)`; sem `DELETE` (R-c). **Normalização (decisão da Etapa 10, a aprovar):** `lib/phone.ts` aceita número internacional com `+`/`00` (8–15 dígitos; **apenas validação sintática**, o país e a faixa não são conferidos) ou nacional do Brasil (DDD 11–99 sem zero; **fixo** de 10 dígitos começando em 2–5; **celular** de 11 dígitos com 9 após o DDD; com ou sem `55`; prefixo nacional `0` aceito) e rejeita o resto; separadores `() - .` e espaços são ignorados. Cliente existente pelo telefone **não é sobrescrito**, também no painel. Tetos de sanidade só na API: nome ≤ 100, e-mail ≤ 254, observações ≤ 1000. Editar cliente: `GET`/`PATCH /api/customers/:id` (N1). |
+| **Appointment** | id, organization_id, professional_id, service_id, customer_id, **starts_at, ends_at, blocked_until**, status, `service_name_snapshot`, `duration_minutes_snapshot`, `buffer_minutes_snapshot`, `price_cents_snapshot`, source (`PANEL`/`PUBLIC`), created_by_user_id?, cancelled_at?, cancel_reason?, version | `ends_at = starts_at + duração`; `blocked_until = ends_at + buffer` (6.1 e 6.3). Remarcar mantém os snapshots originais. **Banco (Etapa 10):** FKs compostas `(organization_id, professional_id|service_id|customer_id)` `RESTRICT/RESTRICT`; `CHECK appointments_range_valid` e `appointments_range_coherent` (`make_interval`, V8 opção 1); `EXCLUDE appointments_no_overlap` sobre `tstzrange(starts_at, blocked_until, '[)')` apenas para `SCHEDULED`/`CONFIRMED`; índice parcial `appointments_active_idx` (V4); `version` começa em 1; `UNIQUE (organization_id, id)` (alvo da FK de `idempotency_records`). FK simples `created_by_user_id → users` (`RESTRICT`). `source` `PUBLIC` existe no enum mas só é usado a partir da Etapa 14. |
+| **IdempotencyRecord** | id, organization_id, key, scope, request_hash, appointment_id?, response_status, response_body, created_at, expires_at (= created_at + 24 h) | Seção 6.4. `UNIQUE (organization_id, scope, key)`. **Banco (Etapa 10):** `key` é `uuid`; `appointment_id`, `response_status` e `response_body` (JSON) são **anulados** apenas durante a transação que reivindicou a chave (nunca ficam assim depois do commit); FK composta `(organization_id, appointment_id)` `RESTRICT/RESTRICT`; índice em `expires_at` para a limpeza. O corpo guardado é a resposta original e contém o nome do cliente (retenção de 24 h + margem de 1 h antes da limpeza). |
 
 `status`: `SCHEDULED`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`. **Ativos (bloqueiam horário): `SCHEDULED` e `CONFIRMED`.** Transições numa função única e testada; cancelar nunca faz `DELETE`.
 
@@ -455,7 +455,7 @@
 
 ### 6.4 Idempotência (R5)
 
-- **Cabeçalho** `Idempotency-Key` (UUID gerado pelo frontend ao abrir o formulário) obrigatório em `POST` que cria agendamento (painel e público). Validado como UUID.
+- **Cabeçalho** `Idempotency-Key` (UUID gerado pelo frontend ao abrir o formulário) obrigatório em `POST` que cria agendamento (painel e público). Validado como UUID. Ausente ou inválido ⇒ `400 IDEMPOTENCY_KEY_INVALID`. Escopo da chave do painel: `appointments.create`. Replay devolve o status e o corpo originais com `Idempotent-Replay: true`.
 - **Escopo:** `(organization_id, scope, key)`; `organization_id` vem do tenant/slug resolvido no servidor. Empresas diferentes podem usar a mesma chave sem interação.
 - **`request_hash`:** SHA-256 do JSON **canônico** (chaves ordenadas) do corpo *já validado e normalizado* (telefone E.164, datas UTC) + método + rota (+ slug).
 - **Algoritmo**, na transação do agendamento, depois dos locks de 6.5:
@@ -595,8 +595,8 @@
 ### 6.6 Remarcação, cancelamento e passado (R7)
 
 - **Nenhum agendamento é criado ou remarcado para o passado**, nem pelo painel: exige `starts_at > now()` (validado sob lock, com `Clock` injetável). Não há como registrar atendimento já ocorrido no MVP. Existe apenas um limite de sanidade técnica contra erro de digitação (valor inicial a definir), que **não** é regra de produto.
-- Remarcar = `UPDATE` de `starts_at/ends_at/blocked_until` na **mesma transação**, com os locks de 6.5 (profissionais de origem e destino em ordem) e revalidação. Mantém os snapshots originais. Trocar de serviço = cancelar e criar outro.
-- Cancelar = mudança de status; sem `DELETE`. Marcar `COMPLETED`/`NO_SHOW` ou cancelar um agendamento cujo horário já passou é permitido (não cria nada no passado).
+- Remarcar = `UPDATE` de `starts_at/ends_at/blocked_until` na **mesma transação**, com os locks de 6.5 (profissionais de origem e destino em ordem) e revalidação. Mantém os snapshots originais. Trocar de serviço = cancelar e criar outro. Implementação (Etapa 10): `POST /api/appointments/:id/reschedule` (corpo `startsAt`, `version`, `professionalId?`); só agendamentos **ativos** podem ser remarcados e o status é mantido (`CONFIRMED` continua `CONFIRMED`); o profissional de destino precisa estar ativo e oferecer o serviço (o serviço em si pode ter sido desativado depois). Limite de sanidade técnica do painel (14.3): **730 dias** à frente (`422 STARTS_AT_TOO_FAR`).
+- Cancelar = mudança de status; sem `DELETE`. Marcar `COMPLETED`/`NO_SHOW` ou cancelar um agendamento cujo horário já passou é permitido (não cria nada no passado). **Transições (Etapa 10, função única `nextStatus`):** `SCHEDULED→CONFIRMED`; `SCHEDULED|CONFIRMED→COMPLETED|NO_SHOW|CANCELLED`; `CANCELLED→SCHEDULED` (reativar, com as validações de remarcar). `COMPLETED` e `NO_SHOW` são **terminais** (decisão a aprovar); `COMPLETED` e `NO_SHOW` só são aceitos depois do fim do atendimento (`ends_at <= now`, relógio injetado; `422 APPOINTMENT_NOT_FINISHED`), porque são terminais e liberam a faixa na exclusão (decisão a aprovar).
 - Edição concorrente no painel: coluna `version`; `UPDATE … WHERE version = $n`; 0 linhas ⇒ `409 STALE_VERSION`.
 
 ### 6.7 Limites iniciais da página pública (R6)
@@ -662,7 +662,7 @@
 ### Erros e validação
 
 - `errorHandler` único; `AppError(code, httpStatus, message, details?)`; formato `{ "error": { "code", "message", "details?", "requestId" } }`.
-- Mapeamento: Zod ⇒ 400; não autenticado ⇒ 401; sem permissão (membro) ⇒ 403; recurso de outra empresa/inexistente ⇒ **404**; conflito (`23P01`, `P2002`, versão, idempotência reutilizada, `ACTIVE_ORG_CHANGED`, conflitos de `TimeOff`/`WorkingHours`) ⇒ **409**; limite de agendamentos do telefone ⇒ 422 `BOOKING_LIMIT_REACHED`; rate limit ⇒ 429; `lock_timeout`/deadlock ⇒ 503 `TEMPORARILY_BUSY`; demais ⇒ 500 genérico. A classificação dos erros de banco lê o SQLSTATE em `error.meta.driverAdapterError.cause.originalCode` (Prisma 7 com driver adapter; ver 4.3), e uma FK com `RESTRICT` pode retornar `23001` além de `23503`.
+- Mapeamento: Zod ⇒ 400; não autenticado ⇒ 401; sem permissão (membro) ⇒ 403; recurso de outra empresa/inexistente ⇒ **404**; conflito (`23P01`, `P2002`, versão, idempotência reutilizada, `ACTIVE_ORG_CHANGED`, conflitos de `TimeOff`/`WorkingHours`) ⇒ **409**; limite de agendamentos do telefone ⇒ 422 `BOOKING_LIMIT_REACHED`; rate limit ⇒ 429; `lock_timeout`/deadlock ⇒ 503 `TEMPORARILY_BUSY`; demais ⇒ 500 genérico. A classificação dos erros de banco lê o SQLSTATE em `error.meta.driverAdapterError.cause.originalCode` (Prisma 7 com driver adapter; ver 4.3), e uma FK com `RESTRICT` pode retornar `23001` além de `23503`. **Códigos de agendamento (Etapa 10):** `409 SLOT_UNAVAILABLE` (exclusão `23P01`), `409 PROFESSIONAL_UNAVAILABLE` (fora do expediente, em folga ou profissional inativo), `409 STALE_VERSION`, `409 INVALID_STATUS_TRANSITION`, `409 IDEMPOTENCY_KEY_REUSED`, `409 TIMEOFF_CONFLICTS_WITH_APPOINTMENTS` e `409 WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS` (ambos com `details {conflicts, totalCount, truncated}`), `409 CUSTOMER_PHONE_TAKEN`; `422 STARTS_AT_IN_PAST`, `422 STARTS_AT_TOO_FAR`, `422 SERVICE_NOT_AVAILABLE` (serviço inativo ou não oferecido pelo profissional), `422 APPOINTMENT_NOT_FINISHED` (concluir/não comparecimento antes do fim); `400 IDEMPOTENCY_KEY_INVALID`. A distinção 409 × 422 entre "conflito de estado" e "regra de negócio violada" é decisão da Etapa 10, a aprovar.
 - Frontend centraliza: 401 ⇒ login; 409 `SLOT_UNAVAILABLE` ⇒ recarregar slots; 409 `ACTIVE_ORG_CHANGED` ⇒ recarregar app.
 
 ---
@@ -764,7 +764,7 @@
 - Aceite: testes unitários de `computeSlots` (grade de 15 min, duração fora da grade, buffer, fuso, virada de dia, folgas, antecedência); `WorkingHours` do mesmo dia sem sobreposição; **L5** (guard), **L8** (estático e de pool), **L9** (cobertura do lock, na parte de `TimeOff`/`WorkingHours`) e **L10** (`lock_timeout`) verdes.
 
 **Etapa 10 — Agendamentos (núcleo)**
-- Entrega: `Customer`, `Appointment`, `IdempotencyRecord`; migration manual da constraint e da coerência de `blocked_until` (opção decidida na etapa 3); criar/remarcar/cancelar/confirmar com a hierarquia N1→N4 e a tabela de operações de 6.5; rejeição de `TimeOff`/`WorkingHours` conflitantes com a lista (R4); proibição de passado (R7). **O limite de 3 por telefone e os limites públicos não entram aqui** (etapa 14).
+- Entrega: `Customer`, `Appointment`, `IdempotencyRecord`; migration manual da constraint e da coerência de `blocked_until` (opção decidida na etapa 3); criar/remarcar/cancelar/confirmar com a hierarquia N1→N4 e a tabela de operações de 6.5; rejeição de `TimeOff`/`WorkingHours` conflitantes com a lista (R4); proibição de passado (R7). **O limite de 3 por telefone e os limites públicos não entram aqui** (etapa 14). **Rotas (Etapa 10, todas `tenant`):** `POST /api/appointments` (exige `Idempotency-Key`), `GET /api/appointments?from&to[&professionalId&customerId&status]` (período ≤ 93 dias, até 500 itens), `GET /api/appointments/:id`, `POST /api/appointments/:id/{reschedule,reactivate,cancel,confirm,complete,no-show}`, `GET /api/availability/slots?professionalId&serviceId&date` (leitura sem lock, L15), `GET`/`PATCH /api/customers/:id`. Ações: `appointments.read|create|reschedule|cancel|confirm|set_status` (reativar, concluir e não compareceu usam `set_status`) e `customers.read|write`. Criação: cliente por `customerId` **ou** `customer {name, phone, email?, notes?}`; N1→N2→N3→N4 por `lib/db/locks` (`lockCustomerById`, `ensureAndLockCustomerByPhone`, `claimIdempotencyKey`, `lockAppointment`); cancelar/confirmar/concluir/não compareceu travam só a linha do agendamento (`UPDATE … WHERE version`). A rejeição de `TimeOff`/`WorkingHours` conflitantes (R4) lista os agendamentos afetados: para `WorkingHours`, os que **cabiam** no expediente anterior e deixariam de caber no novo (usa `[starts_at, ends_at)`, nunca `blocked_until`). A resposta 409 traz `details {conflicts, totalCount, truncated}`: `conflicts` com no máximo 100 agendamentos por início, `totalCount` real e `truncated` quando a lista é parcial (sem paginação: resolver os listados e repetir revela os demais). A limpeza de idempotência vencida entrou em `runMaintenance` (`SKIP LOCKED`, margem de 1 h).
 - Aceite: testes de 6.1 (1–10), 6.4 (1–9) e de concorrência **L1–L4, L6, L7, L9 (completo), L11–L15** verdes; `blocked_until` coerente; editar serviço depois não muda agendamentos; remarcar/criar no passado ⇒ erro; transições inválidas rejeitadas; A×B verde. Os resultados de L4, L6 e L7 são evidência por amostragem, não prova de ausência de deadlock.
 
 **Etapa 11 — Frontend base**
@@ -851,7 +851,7 @@
 | Tempo de expiração dos tokens (30–60 min), máximo de tentativas, tamanho do lease e timeout do provedor na outbox | 5 | 3.4, 3.6 |
 | Provedor de e-mail | 5 (escolha), 16 (verificação) | 3.5 |
 | ~~`lock_timeout` inicial e demais timeouts~~ **Decidido na Etapa 9**: `lock_timeout` 2 s, `maxWait` 2 s, transação interativa 8 s (ver 6.5 e `STAGE-9-VALIDATIONS.md`) | 9 | 6.5 |
-| Limite de sanidade técnica para datas muito distantes no painel | 10 | 6.6 |
+| ~~Limite de sanidade técnica para datas muito distantes no painel~~ **Decidido na Etapa 10** (a aprovar): 730 dias — ver 6.6 | 10 | 6.6 |
 | Página pública começa **despublicada** por padrão | 14 | 4.2, 5 |
 | Ferramenta de monitoramento externo e de atualização de dependências | 15 | 7 |
 | Hospedagem, orçamento e janela de migrations em produção | 16 | 10 |
```
