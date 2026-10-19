# Etapa 9 — Disponibilidade e locks

> Status: **decisões da auditoria aprovadas e documentadas.** O `docs/ARCHITECTURE.md` **foi atualizado** (diff no anexo,
> já aplicado). Nenhuma validação `[VALIDAR]` mudou de estado. Sem commit e sem push.

## 1. Escopo (seção 11 do plano)

"`WorkingHours`, `TimeOff` (CRUD **sem** verificação contra agendamentos), `lib/db/locks` com a hierarquia e o guard de ordem,
`lockProfessionals`, `computeSlots` puro." Aceite: testes unitários de `computeSlots` (grade de 15 min, duração fora da grade,
buffer, fuso, virada de dia, folgas, antecedência); `WorkingHours` do mesmo dia sem sobreposição; **L5** (guard), **L8**
(estático e de pool), **L9** (cobertura do lock, na parte de `TimeOff`/`WorkingHours`) e **L10** (`lock_timeout`) verdes.
Conferido antes de começar: Etapa 8 commitada (`323ac41`, presente em `origin/main`), árvore limpa, nenhuma alteração inesperada.

**Fora do escopo (continua pendente):** `Customer`, `Appointment`, idempotência, rejeição de `TimeOff`/`WorkingHours` contra
agendamentos (R4), N1/N3 em uso real, L1–L4, L6, L7, L9 completo, L11–L15 (todos da Etapa 10); endpoint de slots e página pública
(Etapas 13–14).

## 2. Hierarquia, guard e transação (`lib/db/locks/`)

| Arquivo | Conteúdo |
|---|---|
| `guard.ts` | Estado **por transação** (`WeakMap` chaveado pelo objeto `tx`): maior nível adquirido, chaves já travadas por nível, último profissional. `checkOrder` (antes da consulta) e `recordAcquired` (depois que o banco concedeu). `enterLeafWrite` = N4. `LockOrderViolation` e `LockCoverageViolation`. |
| `index.ts` | `lockProfessionals(tx, orgId, ids[])`, `lockProfessional` (atalho), `lockUser` (A1, agora passando pelo guard), `lockOrganization` (inalterada). Reexporta o guard e `runLocked`. |
| `transaction.ts` | `runLocked(db, fn, lockTimeoutMs?)`: transação interativa + `set_config('lock_timeout', …, true)` + `maxWait`/`timeout`. |

Regras que o guard impõe (todas testadas em `test/locks/guard.test.ts`, inclusive com a hierarquia completa N1→N4 e A1→A4):

- ordem de níveis: pedir nível **menor** depois de um maior ⇒ `LockOrderViolation`; N1, N3 e A1 têm **no máximo uma linha** por transação;
- N2 em ordem **crescente de `id`**: `lockProfessionals` remove duplicatas, normaliza a caixa, ordena e emite **um** `SELECT … FOR NO KEY UPDATE` por
  profissional; um id menor que o último já travado (em outra chamada) é violação;
- profissional já travado na transação não gera nova consulta;
- **domínios disjuntos:** misturar A1 (users) e N2 (professionals) na mesma transação é violação, nas duas ordens;
- a violação é lançada **antes** de a consulta de lock ser enviada: nada espera (teste com outra conexão segurando a linha: falha em < 1,5 s, sem
  esperar o `lock_timeout`, e só 1 `FOR NO KEY UPDATE` chega ao banco). Em produção o comportamento é o mesmo (o erro vira 500 genérico e é logado);
- profissional inexistente na empresa ⇒ `lockProfessionals` devolve `false`, para ali e **não** registra a trava (o 404 do chamador);
- uma violação não corrompe o estado: a ordem correta continua válida depois;
- **L9 em tempo de execução:** `enterLeafWrite(tx, professionalId)` exige a trava N2 **desse** profissional (senão `LockCoverageViolation`) e fecha a
  escalada (depois de N4 não se pede mais N2).

O guard valida a **conformidade com o modelo**. Não enxerga os locks internos do PostgreSQL (FK, índice único, exclusão) e **não prova** ausência de deadlock.

## 3. Disponibilidade (`modules/availability/`) e migration

### Modelo e migration `20261019220000_availability`
- `working_hours`: `weekday` (0 = domingo), `start_minute`, `end_minute` (minutos locais desde 00:00, 0–1440), FK composta
  `(organization_id, professional_id)` → `professionals(organization_id, id)` `RESTRICT/RESTRICT`, índice `(organization_id, professional_id, weekday, start_minute)`.
- `time_off`: `starts_at`, `ends_at` (`timestamptz`), `reason?`, mesma FK composta, índice `(organization_id, professional_id, starts_at)`.
- **SQL manual** (nada disto é modelável no `schema.prisma`): `CREATE EXTENSION IF NOT EXISTS btree_gist`; `CHECK working_hours_range_valid` (dia 0–6,
  `0 <= início < fim <= 1440`, ambos múltiplos de 15); `EXCLUDE USING gist (professional_id =, weekday =, int4range(start_minute, end_minute, '[)') &&)`
  (`working_hours_no_overlap`); `CHECK time_off_range_valid (ends_at > starts_at)`.
- Nenhuma migration anterior foi tocada. `Professional` ganhou só as relações inversas (sem mudança de coluna). `WorkingHours` e `TimeOff` entraram em
  `TENANT_SCOPED_MODELS`.

### Rotas (todas `access: "tenant"`; escrita exige Origin e JSON)
| Rota | Ação | Resultado |
|---|---|---|
| `GET /api/working-hours?professionalId=` | `availability.read` | Lista por dia/início. `professionalId` obrigatório (400); inexistente/alheio ⇒ 404. |
| `POST /api/working-hours` | `availability.write` | `201`. Sobreposição no mesmo dia ⇒ `409 WORKING_HOURS_OVERLAP`. |
| `PATCH /api/working-hours/:id` | `availability.write` | `weekday`/`startTime`/`endTime`; valida o resultado **mesclado** e a sobreposição contra os OUTROS intervalos. O profissional não muda. |
| `DELETE /api/working-hours/:id` | `availability.write` | `204`; repetido/inexistente/malformado ⇒ 404 idêntico. |
| `GET`/`POST /api/time-off`, `PATCH`/`DELETE /api/time-off/:id` | idem | Instantes ISO 8601 **com fuso**, guardados em UTC; `reason` em branco vira `null`. |

Validações: `HH:mm` (ou `24:00` só no fim), múltiplos de 15; início < fim; instantes entre 2000 e 2100; folga ≤ 366 dias; motivo ≤ 200; no máximo 1000
folgas por profissional (`422 TIME_OFF_LIMIT_REACHED`); `.strict()` rejeita `organizationId`, `id` e `professionalId` em PATCH. Respostas `no-store`.

### Concorrência de cada escrita (6.5: "N2 profissional → N4")
Como a linha-filha chega por `id`, o dono é lido **sem lock**, o profissional é travado (`lockProfessionals`), a linha é **relida sob a trava** (removida ou
movida entre a leitura e a trava ⇒ 404), as regras (sobreposição, limite) são avaliadas **sob a trava**, `enterLeafWrite` declara N4 e só então se escreve.
O fluxo de `professionals` (PATCH e `PUT …/services`) passou a usar `runLocked` + `enterLeafWrite`.

### `computeSlots` (`slots.ts`, função pura)
`computeSlots(inputs, clock)`: itens 2–5 de 6.2 (futuro e antecedência mínima/máxima, `[t, t+d)` cabe num intervalo, não intersecta `TimeOff`,
`[t, t+d+b)` não intersecta `[starts_at, blocked_until)` dos agendamentos ativos). O item 1 (profissional/serviço ativos e vinculados) é de quem monta as
entradas. Os limites do expediente são convertidos para **instantes** e a grade de 15 min corre em UTC a partir da abertura, o que mantém o alinhamento ao relógio
local também em dias de horário de verão. `lib/time/zone.ts` ganhou `localMinuteToUtc` (tolera a lacuna do horário de verão avançando ao primeiro horário
existente), `isValidLocalDate` e `localWeekday`. Nenhum acesso a banco, nenhum `Date.now()`: o `Clock` é injetado.

## 4. Timeouts (decisão da seção 14.3, "a definir na etapa 9")

| Parâmetro | Valor | Por quê |
|---|---|---|
| `lock_timeout` | **2 s** (`SET LOCAL` por transação) | curto; vazamento para outras transações verificado (`SHOW lock_timeout` fora da transação = `0`). |
| `maxWait` / `timeout` da transação interativa | 2 s / **8 s** | precisa ficar acima do pior caso de espera (abaixo). |
| `query_timeout` do cliente (já existia) | 10 s | continua o maior. |

**Observação empírica (não é garantia):** em testes de contenção na mesma linha, uma das requisições esperou cerca do **dobro** do `lock_timeout` (6,0 s com
`lock_timeout` de 3 s e `timeout` de 5 s; a margem original era insuficiente). A explicação mais provável é que o `lock_timeout` reinicia a cada espera e a 2ª
requisição da fila espera primeiro o *tuple lock* e depois a transação dona (pior caso ~2×). Isso é uma **hipótese compatível com as medições**: não inspecionei
`pg_locks` e não existe prova formal. A sondagem de seis requisições que originou a medição **não está mais no repositório e não pode ser reproduzida a partir
dele**; o que o repositório reproduz é só o teste L10, que exige que a rajada de 8 escritas termine em 503 entre 1,8 s e 5,5 s. Por prudência o timeout da transação ficou
em 8 s (> 2× `lock_timeout` + trabalho): 2 s / 8 s.
Estouro (`55P03`) e deadlock (`40P01`) viram `503 TEMPORARILY_BUSY` + `Retry-After: 1` **no tratador de erros** (vale para qualquer rota), com log `warn`
(timeout) ou `error` (deadlock = erro de implementação); a resposta não contém SQLSTATE, tabela nem id.

## 5. Testes e resultados reais

| Verificação | Resultado |
|---|---|
| `npm test` (suíte completa, executada uma vez ao final) | **502 testes em 37 arquivos, todos passando** (eram 386 / 31). Após a correção pós-auditoria de timeouts: +18 testes (`test/locks/timeouts.test.ts`), suíte completa reexecutada |
| `npm run lint` | 0 erros |
| `npm run typecheck` | 0 erros |
| `npm run format:check` | "All matched files use Prettier code style!" |
| `git diff --check` | sem saída (exit 0) |
| `npm run db:drift` (banco de desenvolvimento) | "No difference detected." |
| Migrations em banco limpo (`agendly_tmp_s9check`, criado e descartado) | 6 aplicadas; `db:drift` ⇒ "No difference detected"; `migrate status` ⇒ "up to date" |
| Checksums de `_prisma_migrations` | idênticos em `agendly`, `agendly_tmp_s9check` e `agendly_test` (6 migrations) |

Antes e depois da verificação existiam só `agendly`, `agendly_spike`, `agendly_test` e `postgres`. A migration foi **aplicada** (`db:deploy`, aditiva) ao banco de
desenvolvimento `agendly` e ao `agendly_test` (pelo `globalSetup`); nada foi apagado nem alterado em dados existentes.

### Mapa dos testes novos
| Arquivo | Testes | Cobre |
|---|---|---|
| `test/availability/slots.test.ts` | 26 | `computeSlots`: grade, duração fora da grade, vários intervalos, buffer (R3) e agendamentos, folgas, fusos (inclusive +05:30), 24:00, meia-noite, horário de verão (avanço, recuo, lacuna no início do expediente), antecedência, pureza, validação; helpers de `lib/time` |
| `test/availability/availability.test.ts` | 20 | CRUD de `WorkingHours`/`TimeOff`, validações, sobreposição, 401/403/409, `no-store`, e **SQL cru**: CHECKs (`23514`), `EXCLUDE` (`23P01`), FK composta (`23503`) e `RESTRICT` |
| `test/locks/guard.test.ts` | 26 | **L5**: ordem emitida, violações antes da consulta, domínios, hierarquia N1–N4/A1–A4, e contra o Postgres (ordem no SQL, falha imediata sem esperar, `lock_timeout` por transação sem vazamento) |
| `test/locks/locks-http.test.ts` | 13 | **L9** (lock antes da primeira escrita em todas as rotas de escrita), **L10** (8 escritas concorrentes ⇒ 503 + `Retry-After`, nada gravado, leituras não esperam, sem transação pendurada), mapeamento 55P03/40P01, concorrência |
| `test/locks/locks-static.test.ts` | 10 | **L8** estático (sem `prisma` global dentro de transação; sem `delete` em modelos-pai derivados do schema; `FOR NO KEY UPDATE` só em `locks/`) e **de pool** (`max: 1`), **L9** estático |
| `test/locks/timeouts.test.ts` | 18 | Pós-auditoria: `P2028` real (expirada, sem conexão em `maxWait`, já encerrada), tratador (integração e sintético), logout-all e `PATCH /api/organization` sob trava presa (503, rollback, depois funciona), `runLocked` nos fluxos, estático |
| `test/org/isolation.test.ts` (+3) | 22 | A×B de `WorkingHours`/`TimeOff`: respostas idênticas às de id inexistente, `organizationId` ⇒ 400, `X-Active-Org` ⇒ 409, sentinela de SQL |

### Detectores verificados por mutação (os testes realmente detectam)
- Removi `enterLeafWrite` de `createTimeOff` **e** coloquei `prisma.professional.findMany()` dentro da transação de `deleteTimeOff`: falharam o teste estático de
  cliente global, o teste estático de cobertura (L9) e o teste de pool de uma conexão; revertido (suíte do arquivo voltou a 10/10).
- Controle positivo do pool: usar o cliente global dentro de uma transação com `max: 1` **falha**; só com `tx`, funciona.
- Autotestes dos detectores estáticos com trechos sintéticos (violação e forma correta).

### Concorrência (amostragem, não prova — 6.5)
- 8 criações simultâneas de intervalos sobrepostos × 3 rodadas ⇒ sempre exatamente 1 × `201` e 7 × `409 WORKING_HOURS_OVERLAP`, nenhum 5xx.
- Dois `PATCH` que levariam intervalos a colidir ⇒ sempre `[200, 409]`; `PATCH`/`DELETE` da mesma linha ⇒ sem 5xx e sem "ressurreição".
- Sem a trava (SQL cru, 6 conexões no mesmo intervalo): 1 sucesso e o restante `23P01` ou `40P01`, invariante preservada — a trava é obrigatória no fluxo normal.
- Carga mista aleatória (90 operações sobre 3 profissionais): só `200/201/204/400/404/409`; **zero** `LockOrderViolation`, `LockCoverageViolation`, `40P01` e `TEMPORARILY_BUSY`
  nos logs; nenhuma sobreposição de expediente e nenhuma folga invertida no banco.
- Esta etapa **não** executa L4/L6/L7 nem estresse com `deadlock_timeout` baixo: dependem de agendamentos (Etapa 10).

## 6. Divergências em relação à arquitetura (auditadas; decisões aprovadas)

Classificação da auditoria: *aprovada* = exigia aprovação e foi aprovada; *compatível* = já cabia no plano. Todas estão agora em `docs/ARCHITECTURE.md`.

1. **`WorkingHours.start_minute`/`end_minute` em vez de `start_time`/`end_time`** (minutos desde 00:00 local). O `time` do PostgreSQL chega ao Prisma como `Date` de 1970 e não representa
   `24:00`. A API continua em `"HH:mm"`. *Aprovada.*
2. **Rotas planas** (`/api/working-hours`, `/api/time-off`) em vez de aninhadas em `/api/professionals/:id/…`; o plano não definia as rotas. *Aprovada.*
3. **Ações `availability.read` / `availability.write`**, cobertas por `availability.*`. *Compatível.*
4. **`EXCLUDE` e `CHECK`s em `working_hours`** além do mínimo do plano: intencionais, rede de segurança da validação sob a trava N2. Exigem `btree_gist` (ver §7). *Compatível; intencional.*
5. **`DELETE` físico de `WorkingHours`/`TimeOff`**: são folhas; a restrição de exclusão dos pais (R-c) permanece e o teste L8 a deriva do schema. *Compatível.*
6. **Timeouts: `lock_timeout` 2 s, `maxWait` 2 s, transação interativa 8 s**, decisões adotadas nesta etapa (resolvem a linha de 14.3). *Aprovada.*
7. **`lockUser` (A1) passa pelo guard**; os 5 pontos de uso em `auth/account.ts` não mudaram. *Compatível.*
8. **Assinatura real `lockProfessionals(tx, organizationId, ids)`** (6.5 dizia `(tx, ctx, ids[])`) e estado do guard associado à transação por `WeakMap` chaveado pelo `tx` (6.5 falava em "contexto da transação"). Descoberto na auditoria, fora da lista original. *Aprovada; 6.5 atualizado, código inalterado.*
9. **`runLocked`** é infraestrutura nova desta etapa (não existia no plano). *Compatível.*
10. **`55P03` e `40P01` convertidos globalmente em `503 TEMPORARILY_BUSY`** (com `Retry-After: 1`) no tratador de erros, valendo para qualquer rota. *Compatível com 6.5.*
11. **Início de expediente em horário local inexistente** avança para o primeiro horário válido (ex.: 02:30 inexistente ⇒ 03:00 em 10/03/2030, Nova York). O plano não define; convenção aprovada e documentada em 6.2. Fusos com transição de 30 minutos e lacunas à meia-noite **não** foram testados especificamente.

## 7. Limitações, riscos e itens pendentes

- **Correção pós-auditoria (timeouts) — aplicada:** os 5 fluxos de `auth/account.ts` que chamam `lockUser` (reenvio de verificação, verificação de e-mail, recuperação, redefinição de senha,
  encerramento de sessões) e `updateOrganization` (`lockOrganization`) agora usam `runLocked`. Ordem de aquisição, domínio e semântica não mudaram; passaram a valer `lock_timeout` 2 s e transação 8 s.
  Seguem em `prisma.$transaction` direto, **sem** `runLocked`, só as três transações que **não adquirem locks explícitos**: `registerUser`, o aviso `ACCOUNT_EXISTS` e `createOrganization`
  (lista revisada e imposta por teste estático: se ganharem trava, o teste falha).
- **Pool de conexões:** requisições presas esperando um lock seguram uma conexão até 2–4 s (cenário conhecido nº 3 de 6.5); com muitas esperas simultâneas no mesmo profissional, o pool
  (10) pode saturar. Medido: 6 requisições na mesma linha ⇒ 5 em ~1× e 1 em ~2× o `lock_timeout`. Sem mitigação além dos timeouts.
- **`P2028` — tratado só nas formas que são timeout:** `503` para transação **expirada** (`meta.timeout` e `meta.timeTaken` numéricos) e para **espera por conexão** em `maxWait`
  (mensagem "Unable to start a transaction in the given time", `meta` vazio); ambas reproduzidas com o Prisma 7.10.1 real. "Transaction already closed", "not found" e "Internal Consistency Error"
  continuam `500 INTERNAL_ERROR`. O reconhecimento da espera por conexão depende do **texto** da mensagem; uma atualização do Prisma pode alterá-lo (os testes de integração, que usam o erro real,
  acusariam). Em recuperação de senha e afins, um `503` por contenção só ocorre se o usuário existe e está travado, o mesmo sinal que antes aparecia como `500` após 5 s.
- **Requisito de ambiente — `btree_gist`:** a migration executa `CREATE EXTENSION IF NOT EXISTS btree_gist`. A disponibilidade da extensão e o privilégio para criá-la no banco de produção **não foram validados**
  (conferir na Etapa 16; a Etapa 10 também depende dela).
- **Não testados especificamente:** fusos com transição de horário de verão de 30 minutos e lacunas à meia-noite. Nenhuma garantia de concorrência aqui é prova: são amostragens.
- N1 e N3 só existem no guard e nos testes unitários (`checkOrder`/`recordAcquired`); nenhum código os usa até a Etapa 10.
- O guard e `enterLeafWrite` dependem de os serviços chamarem `lockProfessionals` e `enterLeafWrite` — impostos por teste estático (L9), não por tipo.
- `computeSlots` não é exposto por rota; o item 1 de 6.2 fica a cargo de quem o chamar. Horário ambíguo: primeira ocorrência (política existente em `zonedLocalToUtc`); horário inexistente: primeiro horário válido depois da lacuna (divergência 11).
- Listas sem paginação (folgas limitadas a 1000 por profissional); folgas no passado e sobrepostas são aceitas (o plano não proíbe).
- Os tetos de sanidade (366 dias, 2000–2100, 200 caracteres, 1000 folgas) e `weekday` 0 = domingo são **decisões minhas**, não do plano.
- Sem estresse com `deadlock_timeout` baixo e sem L4/L6/L7 (Etapa 10).

## Anexo — atualização do `docs/ARCHITECTURE.md` (APLICADA)

Diff real (`git diff docs/ARCHITECTURE.md`) aplicado após a auditoria, com as correções: assinatura de `lockProfessionals` e guard por `WeakMap`, hipótese (não garantia) do pior caso de 2×,
convenção de horário inexistente em 6.2, cenário conhecido nº 8 de 6.5 e requisito de `btree_gist`. A linha de 14.3 sobre `lock_timeout` aparece como decidida na Etapa 9; nenhuma validação `[VALIDAR]` mudou de estado.

```diff
diff --git a/docs/ARCHITECTURE.md b/docs/ARCHITECTURE.md
index d947d3d..3151259 100644
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -358,8 +358,8 @@ EmailOutbox  (global; não pertence a uma empresa)
 | **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. **Banco (Etapa 7):** `CHECK`s de piso (`duration_minutes >= 1`, `buffer_minutes >= 0`, `price_cents` nulo ou `>= 0`) e `UNIQUE (organization_id, id)` (alvo das FKs compostas das etapas 8 e 10); não há `DELETE` (R-c): desativa-se com `active`. Tetos de sanidade só na API: duração e buffer ≤ 1440 min, preço ≤ R$ 1.000.000,00, nome ≤ 100 caracteres. |
 | **Professional** | id, organization_id, name, active | Sem `user_id` (D2). **Banco (Etapa 8):** `UNIQUE (organization_id, id)` (alvo das FKs compostas); não há `DELETE` (R-c): desativa-se com `active`. Teto de sanidade só na API: nome ≤ 100 caracteres. |
 | **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. **Banco (Etapa 8):** PK `(professional_id, service_id)`; as duas FKs `(organization_id, …)` são `ON DELETE RESTRICT ON UPDATE RESTRICT` (nunca `SET NULL`); índice `(organization_id, service_id)`. Sem `id` próprio. |
-| **WorkingHours** | id, organization_id, professional_id, weekday (0–6), start_time, end_time | Hora **local** da empresa; vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. |
-| **TimeOff** | id, organization_id, professional_id, starts_at, ends_at, reason | `CHECK (ends_at > starts_at)`. |
+| **WorkingHours** | id, organization_id, professional_id, weekday (0–6), **start_minute, end_minute** | Hora **local** da empresa, guardada como **minutos desde 00:00** (0–1440; `1440` = meia-noite seguinte), e **não** como `start_time`/`end_time` (decisão da Etapa 9: o `time` do PostgreSQL chega ao Prisma como `Date` de 1970 e não representa `24:00`). A API usa `"HH:mm"`. `weekday` 0 = domingo. Vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. **Banco (Etapa 9, intencional):** FK composta `(organization_id, professional_id)` `RESTRICT/RESTRICT`; `CHECK` de faixa e de grade; `EXCLUDE USING gist` (profissional, dia, `int4range(start, end, '[)')`) como rede de segurança da validação feita sob a trava N2 (exige a extensão `btree_gist`). Linhas podem ser apagadas fisicamente (são folhas). |
+| **TimeOff** | id, organization_id, professional_id, starts_at, ends_at, reason | `CHECK (ends_at > starts_at)`. **Banco (Etapa 9):** FK composta para o profissional (`RESTRICT/RESTRICT`). Linhas podem ser apagadas fisicamente (são folhas). Folgas podem se sobrepor entre si. Tetos de sanidade só na API: duração ≤ 366 dias, datas entre 2000 e 2100, motivo ≤ 200 caracteres, 1000 folgas por profissional. |
 | **Customer** | id, organization_id, name, phone_e164, email?, notes? | `UNIQUE(organization_id, phone_e164)`. Dado pessoal (LGPD). Criação pela página pública **não sobrescreve** dados de cliente existente. Sem campos de nicho (D13). |
 | **Appointment** | id, organization_id, professional_id, service_id, customer_id, **starts_at, ends_at, blocked_until**, status, `service_name_snapshot`, `duration_minutes_snapshot`, `buffer_minutes_snapshot`, `price_cents_snapshot`, source (`PANEL`/`PUBLIC`), created_by_user_id?, cancelled_at?, cancel_reason?, version | `ends_at = starts_at + duração`; `blocked_until = ends_at + buffer` (6.1 e 6.3). Remarcar mantém os snapshots originais. |
 | **IdempotencyRecord** | id, organization_id, key, scope, request_hash, appointment_id?, response_status, response_body, created_at, expires_at (= created_at + 24 h) | Seção 6.4. `UNIQUE (organization_id, scope, key)`. |
@@ -495,7 +495,7 @@ Domínio de **agendamento**:
 | Nível | Recurso | Regra |
 |---|---|---|
 | N1 | `customers` — a linha do cliente | No máximo uma por transação. |
-| N2 | `professionals` — todos os envolvidos | Em ordem **crescente de `id`**, um `SELECT … FOR NO KEY UPDATE` por vez (não um único `ORDER BY … FOR NO KEY UPDATE`, cuja ordem de aquisição não é garantida), via `lockProfessionals(tx, ctx, ids[])`, que remove duplicatas e ordena. |
+| N2 | `professionals` — todos os envolvidos | Em ordem **crescente de `id`**, um `SELECT … FOR NO KEY UPDATE` por vez (não um único `ORDER BY … FOR NO KEY UPDATE`, cuja ordem de aquisição não é garantida), via `lockProfessionals(tx, organizationId, ids)`, que remove duplicatas, ordena e só encontra profissionais **da empresa informada**. |
 | N3 | `idempotency_records` — a linha/chave | No máximo uma por transação. |
 | N4 | Escrita nas linhas-folha: `appointments`, `time_off`, `working_hours`, `professional_services` | Ao final; uma linha de `appointments` pode ser relida com lock (`version`). |
 
@@ -539,7 +539,7 @@ Esperas em índices únicos (e-mail, slug, telefone do cliente na mesma empresa,
 
 #### Guard de ordem em tempo de execução
 
-`lib/db/locks` mantém no contexto da transação o maior nível adquirido e o último `id` de profissional. Tentar adquirir um nível menor, ou um profissional com `id` menor que o último, lança `LockOrderViolation`: o teste falha em dev/CI e, em produção, a operação é abortada **antes** de esperar o lock e registrada como erro. O guard valida a **conformidade com o modelo**; ele não enxerga locks internos do PostgreSQL.
+`lib/db/locks` mantém, **por transação**, o maior nível adquirido, as chaves já travadas por nível e o último `id` de profissional. Na implementação (Etapa 9) esse estado fica num `WeakMap` chaveado pelo objeto `tx` da transação interativa (não há um objeto `ctx` explícito); `lockProfessionals(tx, organizationId, ids)` é a assinatura real. O guard também cobre `lockUser` (A1) e os domínios de agendamento e autenticação não se misturam na mesma transação. `enterLeafWrite(tx, professionalId)` declara a escrita N4 e exige a trava N2 desse profissional (`LockCoverageViolation`). Tentar adquirir um nível menor, ou um profissional com `id` menor que o último, lança `LockOrderViolation`: o teste falha em dev/CI e, em produção, a operação é abortada **antes** de esperar o lock e registrada como erro. O guard valida a **conformidade com o modelo**; ele não enxerga locks internos do PostgreSQL.
 
 #### O que se pode e o que não se pode afirmar
 
@@ -554,10 +554,11 @@ Esperas em índices únicos (e-mail, slug, telefone do cliente na mesma empresa,
 2. *Criar/mover agendamento:* `starts_at` no futuro (R7) e, se público, dentro dos limites de 6.7; profissional/serviço ativos e vinculados; `[start, end)` cabe em `WorkingHours`; não intersecta `TimeOff`; só então insere (a exclusão continua como rede de segurança).
 3. *Criar/alterar `TimeOff`* (R4): se existir agendamento **ativo e não terminado** (`ends_at > now()`) cujo `[starts_at, ends_at)` intersecte o novo intervalo ⇒ **rejeita** com `409 TIMEOFF_CONFLICTS_WITH_APPOINTMENTS` e a **lista dos conflitos**. Nada é cancelado automaticamente.
 4. *Alterar/remover `WorkingHours`* (R4): se algum agendamento ativo e não terminado deixaria de caber ⇒ `409 WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS` com a lista. Também valida que os intervalos do mesmo dia não se sobrepõem. O buffer não entra nessas verificações (6.3).
-5. **Timeouts:** `lock_timeout` curto (valor inicial a definir). Estourar ⇒ `503 TEMPORARILY_BUSY` com `Retry-After`; nada é gravado.
+5. **Timeouts (decisões adotadas na Etapa 9):** `lock_timeout` = **2 s** (`set_config(…, true)`, vale só na transação), `maxWait` = **2 s** e timeout da transação interativa = **8 s**, nessa ordem de grandeza (`lock_timeout` < timeout da transação < `query_timeout` de 10 s do cliente). `runLocked` (`lib/db/locks/transaction.ts`, infraestrutura introduzida na Etapa 9) aplica esses valores. Observação empírica: com várias requisições na mesma linha, uma delas esperou cerca do **dobro** do `lock_timeout` (6,0 s com 3 s); a explicação mais provável (espera do *tuple lock* e depois da transação dona) é **hipótese compatível com as medições, não garantia demonstrada**, e é por isso que o timeout da transação fica bem acima de 2× o `lock_timeout`. `55P03`, `40P01` e os `P2028` que são **timeout de transação** são convertidos **globalmente**, no tratador de erros, em `503 TEMPORARILY_BUSY` com `Retry-After: 1`, com rollback total e nada gravado. Os `P2028` reconhecidos como timeout são só dois, verificados no Prisma 7.10.1: transação **expirada** (`meta.timeout` e `meta.timeTaken` numéricos) e **espera por conexão** em `maxWait` ("Unable to start a transaction in the given time"); os demais (transação já encerrada, não encontrada, inconsistência interna) continuam `500 INTERNAL_ERROR`. Os fluxos que travam `users` (A1) e a linha da empresa usam `runLocked`; as transações sem trava explícita (cadastro, aviso `ACCOUNT_EXISTS`, criação de empresa) ainda usam `prisma.$transaction` direto, com os padrões do Prisma (2 s / 5 s), por não adquirirem locks.
 6. **Custo:** operações do mesmo profissional (ou do mesmo cliente) se enfileiram; as demais não se bloqueiam.
 7. **Alternativa descartada no MVP:** tabela única de "ocupações" (agendamentos + folgas) sob a mesma exclusão — resolve `TimeOff`, não `WorkingHours`, e complica o modelo.
 8. Trocar o `timezone` é proibido no MVP (R9), para não reinterpretar `WorkingHours` e agendamentos futuros.
+9. **Horário local inexistente (Etapa 9):** o limite de um expediente que cai na lacuna do horário de verão avança para o **primeiro horário válido** depois dela (`localMinuteToUtc`); horário ambíguo usa a primeira ocorrência. Cobertura de teste: Nova York (avanço e recuo), São Paulo, Kolkata (+05:30) e Tóquio. **Ainda não testados especificamente:** fusos com transição de 30 minutos (ex.: Lord Howe) e lacunas à meia-noite.
 
 #### Testes de concorrência (especificação, nada executado)
 
@@ -589,6 +590,7 @@ Postgres real, transações interativas e barreiras para entrelaçamento determi
 5. Mais de uma instância da API: os locks são do banco, então o desenho se mantém, mas isso **não** será testado no MVP (instância única).
 6. Falha/failover do banco no meio da transação: fora do escopo.
 7. Operações futuras (lote, convites, alterar senha autenticado, `ADMIN`) precisarão ser enquadradas na hierarquia e entrar na tabela e na carga de L7 quando existirem.
+8. (Etapa 9) O servidor não retenta sozinho nenhuma operação que resultou em `503`: o cliente decide (a transação sofreu rollback total, então repetir é seguro para a mesma entrada, mas fluxos sem chave de idempotência — ex.: cadastro — podem produzir efeito diferente se o 1º pedido tiver sido concluído antes de a resposta se perder).
 
 ### 6.6 Remarcação, cancelamento e passado (R7)
 
@@ -758,7 +760,7 @@ Cada etapa é pequena, termina em um commit e só começa após a anterior estar
 - Aceite: vincular serviço de outra empresa falha (aplicação ⇒ 404; SQL cru ⇒ erro de FK composta); A×B verde.
 
 **Etapa 9 — Disponibilidade e locks**
-- Entrega: `WorkingHours`, `TimeOff` (CRUD **sem** verificação contra agendamentos, pois ainda não existem — essa verificação entra na etapa 10; entre as etapas 9 e 10 não há agendamentos no banco), `lib/db/locks` com a hierarquia e o guard de ordem, `lockProfessionals`, `computeSlots` puro.
+- Entrega: `WorkingHours`, `TimeOff` (CRUD **sem** verificação contra agendamentos, pois ainda não existem — essa verificação entra na etapa 10; entre as etapas 9 e 10 não há agendamentos no banco), `lib/db/locks` com a hierarquia e o guard de ordem, `lockProfessionals`, `computeSlots` puro. **Rotas planas** (decisão da Etapa 9; todas `tenant`): `GET`/`POST /api/working-hours` e `PATCH`/`DELETE /api/working-hours/:id`; `GET`/`POST /api/time-off` e `PATCH`/`DELETE /api/time-off/:id`. O profissional vai em `?professionalId=` (listas) ou no corpo (criação), é conferido na empresa da sessão, e o `:id` identifica a própria linha; ações `availability.read` e `availability.write`. Cada escrita é "N2 do profissional dono da linha → N4": o dono é lido sem lock, o profissional é travado e a linha é relida sob a trava. `DELETE` físico de `WorkingHours`/`TimeOff` é permitido (folhas); a proibição de `DELETE` de entidades-pai (R-c) permanece e é verificada a partir do schema. **Requisito de ambiente:** a migration usa `CREATE EXTENSION IF NOT EXISTS btree_gist`; a disponibilidade dessa extensão (e do privilégio para criá-la) no banco de produção **não foi validada** e deve ser conferida na Etapa 16.
 - Aceite: testes unitários de `computeSlots` (grade de 15 min, duração fora da grade, buffer, fuso, virada de dia, folgas, antecedência); `WorkingHours` do mesmo dia sem sobreposição; **L5** (guard), **L8** (estático e de pool), **L9** (cobertura do lock, na parte de `TimeOff`/`WorkingHours`) e **L10** (`lock_timeout`) verdes.
 
 **Etapa 10 — Agendamentos (núcleo)**
@@ -848,7 +850,7 @@ Não são decisões de produto: são **resultados de validação técnica que pr
 | Parâmetros de senha (argon2id, lista de senhas comuns) | 4 | 3.1 (V9) |
 | Tempo de expiração dos tokens (30–60 min), máximo de tentativas, tamanho do lease e timeout do provedor na outbox | 5 | 3.4, 3.6 |
 | Provedor de e-mail | 5 (escolha), 16 (verificação) | 3.5 |
-| `lock_timeout` inicial e demais timeouts | 9 | 6.5 |
+| ~~`lock_timeout` inicial e demais timeouts~~ **Decidido na Etapa 9**: `lock_timeout` 2 s, `maxWait` 2 s, transação interativa 8 s (ver 6.5 e `STAGE-9-VALIDATIONS.md`) | 9 | 6.5 |
 | Limite de sanidade técnica para datas muito distantes no painel | 10 | 6.6 |
 | Página pública começa **despublicada** por padrão | 14 | 4.2, 5 |
 | Ferramenta de monitoramento externo e de atualização de dependências | 15 | 7 |
```
