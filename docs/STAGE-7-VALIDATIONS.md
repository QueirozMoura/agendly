# Etapa 7 — Serviços

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado; a atualização sugerida está no
> anexo (diff pronto). Nenhuma validação `[VALIDAR]` mudou de estado nesta etapa.

## 1. Escopo (seção 11 do plano)

"CRUD de `Service` com `duration_minutes` e `buffer_minutes` (padrão 0)." Aceite: validação de limites; A×B verde;
somente o `OWNER` da empresa ativa opera; usuário de outra empresa ⇒ 404. Conferido antes de começar: a Etapa 6 estava
commitada (`895ecf8`) e a árvore de trabalho, limpa.

## 2. Rotas, permissões e validação

Todas são `access: "tenant"` (via `tenantRoute(action)`): 401 sem sessão → 403 `NO_ACTIVE_ORGANIZATION` /
403 `ORGANIZATION_ACCESS_REVOKED` / 409 `ACTIVE_ORG_CHANGED` → 403 `FORBIDDEN` (permissão) → handler. CSRF (Origin + JSON) nas escritas.

| Rota | Ação (`can`) | Resultado |
|---|---|---|
| `GET /api/services[?active=true\|false]` | `services.read` | Lista da empresa ativa, por nome. Outro parâmetro de consulta ⇒ 400. |
| `POST /api/services` | `services.create` | `201`. Limite de 120 criações/h por usuário (`429`, em memória). |
| `GET /api/services/:id` | `services.read` | `404` para inexistente, malformado **e** de outra empresa (respostas idênticas). |
| `PATCH /api/services/:id` | `services.update` | Edita campos e ativa/desativa (`active`). Só os campos enviados entram no UPDATE. |

Não há `DELETE`: serviços são desativados (R-c; snapshots em agendamentos futuros). `DELETE` responde 404.

Campos (`.strict()`; `organizationId`, `id`, datas e campos desconhecidos ⇒ 400; `active` não é aceito na criação):

| Campo | Regra | Origem |
|---|---|---|
| `name` | 1–100 caracteres (após `trim`) | teto de 100 é sanidade |
| `durationMinutes` | inteiro 1–1440 | piso: plano (5); teto: sanidade |
| `bufferMinutes` | inteiro 0–1440, padrão 0 | piso: plano (D6); teto: sanidade |
| `priceCents` | inteiro 0–100.000.000 ou `null` (remove) | teto: sanidade (R$ 1.000.000) |
| `active` | booleano (só no `PATCH`) | |

Os **pisos** são invariantes do banco; os **tetos** são de sanidade técnica (como na Etapa 6), só na API, e podem mudar sem migration.
A duração não precisa estar na grade de 15 min (D5). O id do serviço é exposto (o cliente endereça serviços por ele);
o id da empresa nunca.

## 3. Migration `20261019200000_services`

- Tabela `services` com `UNIQUE (organization_id, id)` (alvo das FKs compostas de `professional_services` e `appointments`,
  etapas 8 e 10) e índice `(organization_id, active, name)`.
- FK simples para `organizations` com `ON DELETE RESTRICT ON UPDATE RESTRICT` (nunca `SET NULL`).
- SQL manual: `services_duration_positive`, `services_buffer_non_negative`, `services_price_non_negative` (CHECKs de piso).
- Verificado em banco novo (`agendly_clean`, criado e descartado; os demais bancos não foram tocados): 4 migrations aplicadas,
  objetos presentes, `db:drift` ⇒ "No difference detected"; no banco de desenvolvimento, `migrate status` ⇒ "up to date".
- A migration foi gerada com carimbo anterior ao da Etapa 6 (relógio do ambiente) e **renomeada** para `20261019200000_services` para
  manter a ordem; a linha correspondente em `_prisma_migrations` do banco de desenvolvimento (somente ela) foi renomeada.
  O conteúdo (e o checksum) não mudou.

## 4. Isolamento multi-tenant

- `Service` entrou em `TENANT_SCOPED_MODELS`. **Primeiro módulo a usar `forTenant()` em produção**: todo acesso do módulo passa
  por ele (o `organizationId` do contexto é injetado em toda operação; divergente é rejeitado; `update` com id alheio ⇒ `P2025` ⇒ 404).
- Teste de inventário (4.4, item 1) e matriz modelo × operação (item 2) passaram a cobrir `Service` automaticamente (lidos do schema).
- Regras estáticas ajustadas: fora dos módulos revisados, o acesso a um modelo escopado só é aceito em arquivos que usam
  `forTenant(`, e esses arquivos não podem também usar `prisma.<modelo>.` direto. **Verificado por mutação**: dois arquivos-isca
  (acesso direto; `forTenant` misturado com acesso direto) fizeram os dois testes falharem.
- Registro de rotas: as 4 rotas novas foram incluídas em `TENANT_ROUTES_WITH_AB_TESTS`; o teste **falhou** antes disso (comprova
  que o detector funciona) e agora passa. A regra "sem parâmetro de caminho" foi refinada para "só `:id`, nunca empresa/slug".
- A×B de serviços (`test/org/isolation.test.ts`): A não lê, lista, altera nem desativa o serviço de B; as respostas são **idênticas**
  às de um id inexistente; `organizationId` no corpo/na query ⇒ 400; `X-Active-Org` de B ⇒ 409; B permanece idêntico e nada é criado
  em empresa nenhuma. Sentinela de SQL: toda consulta à tabela `services` cita `organization_id`.
- OWNER de duas empresas: listas, leituras e edições ficam separadas conforme a empresa ativa.
- `forTenant` com banco real: `findUnique`/`update`/`updateMany`/`deleteMany` de serviço alheio não têm efeito.

**Limites (inalterados, V7):** `forTenant` continua sem cobrir `$queryRaw`, `include`/filtros aninhados e escritas aninhadas. Hoje
`Service` não tem filhos; quando `professional_services` e `appointments` existirem, a FK composta é a garantia.

## 5. Testes e resultados reais

| Verificação | Resultado |
|---|---|
| `npm test` (suíte completa) | **367 testes em 30 arquivos, todos passando** (eram 343 / 29) |
| Testes novos da etapa (+24 no total) | 21 em `test/services/services.test.ts`, 2 A×B em `isolation.test.ts` e 1 regra estática a mais (a regra de acesso a modelo escopado foi dividida em duas) |
| `npm run lint` | 0 erros |
| `npm run format:check` | passou |
| `npm run typecheck` | 0 erros |
| `npm run db:drift` | "No difference detected" |
| Migrations em banco limpo | 4 aplicadas, sem drift (item 3) |

Cobertura funcional: criação com padrões e fronteiras; 16 entradas inválidas e 6 campos proibidos na criação; 10 inválidas/proibidas no
`PATCH`; 401 sem sessão em todas as rotas; 403 sem empresa ativa; CSRF; `X-Active-Org`; filtro `?active=`; ordenação; 404 idêntico
(inexistente × malformado × alheio); desativar/reativar sem apagar; `DELETE` inexistente; edições simultâneas de campos diferentes
(nenhum se perde); CHECKs do banco por SQL cru (e a aceitação do valor-limite); `UNIQUE (organization_id, id)` presente; FK
RESTRICT/RESTRICT e impossibilidade de apagar empresa com serviços; limite de criação (121ª ⇒ 429). Regressão: as 343 provas das
etapas anteriores seguem verdes.

## 6. Limitações, riscos e decisões a confirmar

- **Sem controle otimista de versão** em `services`: duas edições do **mesmo** campo valem "a última vence" (a seção 5 do plano não prevê
  coluna `version` para serviços). Campos diferentes não se perdem (testado).
- **Nome duplicado é permitido** (o plano não pede unicidade); duas "Corte" na mesma empresa são aceitas.
- **Lista sem paginação** (resultado ilimitado por empresa). Mitigação: limite de 120 criações/h por usuário; paginar fica para quando houver volume/UX.
- Tetos de sanidade (1440 min; R$ 1.000.000; 100 caracteres) e o limite de 120 criações/h são decisões minhas, não do plano.
- `services.read` / `services.create` / `services.update` são os nomes das ações; a matriz usa o curinga `services.*`, então qualquer outro nome também passaria
  para `OWNER` — a distinção só terá efeito quando existir outro papel.
- Alterar duração/buffer não afeta agendamentos existentes (snapshots, 6.3): só será verificável na Etapa 10.
- Rate limit em memória (instância única), como os demais.
- Sem divergência em relação à arquitetura aprovada.

## Anexo — atualização sugerida ao `docs/ARCHITECTURE.md` (NÃO aplicada)

Documenta as rotas e as invariantes de banco do `Service` (seção 5 e etapa 7). Nenhuma validação muda de estado.

```diff
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -355,7 +355,7 @@
 | **EmailOutbox** | id, to_email, template, payload_encrypted (com key_id), status, dead_reason, attempts, next_attempt_at, locked_until, lock_token, not_after, last_error, created_at, sent_at | Seção 3.6. Entrega *at-least-once*. |
 | **Organization** | id, name, slug (único), **timezone (imutável)**, status (enum `OrganizationStatus`, valor inicial `{ ACTIVE }`, extensível por migrations futuras), **published_at?**, **public_min_notice_minutes (120)**, **public_max_advance_days (60)**, **public_max_active_bookings_per_phone (3)** | Valores entre parênteses são *configurações iniciais sujeitas à validação com usuários reais* (R6, 6.7). Editáveis só por `OWNER`. `slug` com lista de reservados. **Banco (Etapa 6):** `CHECK` de formato do slug (minúsculas/números/hífens, 3–40) e gatilho que recusa alterar `timezone`. |
 | **Membership** | id, user_id, organization_id, role | `role` aceita somente `OWNER` no MVP (mecanismo extensível a decidir no spike, V16); `UNIQUE(user_id, organization_id)`. Exatamente 1 `OWNER` por empresa criada (**índice único parcial** `memberships_one_owner_per_organization`, Etapa 6); **sem fluxo para adicionar ou remover membros no MVP** (evolução futura). |
-| **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. |
+| **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. **Banco (Etapa 7):** `CHECK`s de piso (`duration_minutes >= 1`, `buffer_minutes >= 0`, `price_cents` nulo ou `>= 0`) e `UNIQUE (organization_id, id)` (alvo das FKs compostas das etapas 8 e 10); não há `DELETE` (R-c): desativa-se com `active`. Tetos de sanidade só na API: duração e buffer ≤ 1440 min, preço ≤ R$ 1.000.000,00, nome ≤ 100 caracteres. |
 | **Professional** | id, organization_id, name, active | Sem `user_id` (D2). |
 | **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. |
 | **WorkingHours** | id, organization_id, professional_id, weekday (0–6), start_time, end_time | Hora **local** da empresa; vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. |
@@ -750,7 +750,7 @@
 - Aceite: itens 1–7 de 4.4 implementados e verdes; testes de `can()` (todas as ações permitidas ao `OWNER`, *default deny* para papel desconhecido); usuário sem membership ⇒ 404; criar empresa sem e-mail verificado ⇒ erro; `timezone` não pode ser alterado depois; divergência de `X-Active-Org` ⇒ 409; `organizationId` no body ⇒ 400; usuário `OWNER` de 2 empresas isolado corretamente. **Nenhum teste, seed ou código de `ADMIN`.**
 
 **Etapa 7 — Serviços**
-- Entrega: CRUD de `Service` com `duration_minutes` e `buffer_minutes` (padrão 0).
+- Entrega: CRUD de `Service` com `duration_minutes` e `buffer_minutes` (padrão 0). Rotas: `GET`/`POST /api/services` e `GET`/`PATCH /api/services/:id` (sem `DELETE`: ativar/desativar é um `PATCH` de `active`); ações `services.read`, `services.create` e `services.update`.
 - Aceite: validação de limites; A×B verde; somente o `OWNER` da empresa ativa opera; usuário de outra empresa ⇒ 404.
 
 **Etapa 8 — Profissionais e vínculo com serviços**
```
