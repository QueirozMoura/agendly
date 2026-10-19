# Etapa 6 — Tenant, permissões e empresas

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado; as atualizações propostas
> estão no anexo (diff pronto para aplicar). Nada foi marcado como resolvido além do que a evidência permite.

## 1. Escopo (seção 11 do plano) e como foi cumprido

Entrega prevista: `tenantPlugin`, `active_organization_id`, `X-Active-Org`, `forTenant()`, `can()` (somente
`OWNER`), criar empresa (+ membership `OWNER`, exige e-mail verificado), editar configurações, listar/trocar
empresa. Aceite: itens 1–7 de 4.4; testes de `can()`; sem membership ⇒ 404/403; criar sem e-mail verificado ⇒ erro;
timezone imutável; divergência de `X-Active-Org` ⇒ 409; `organizationId` no corpo ⇒ 400; OWNER de 2 empresas isolado;
**nenhum teste, seed ou código de `ADMIN`** (cumprido).

## 2. Rotas

| Rota | Classe | Permissão (`can`) | Observações |
|---|---|---|---|
| `POST /api/organizations` | auth | — (exige e-mail verificado) | `201`. Cria empresa + membership `OWNER` + empresa ativa da sessão numa transação. `403 EMAIL_NOT_VERIFIED`, `409 SLUG_UNAVAILABLE`, `429` (5/h por usuário, 20/h por IP). |
| `GET /api/organizations` | auth | — | Só as empresas do **próprio** usuário (filtro por `user_id` da sessão) e `activeSlug`. |
| `POST /api/session/active-organization` `{slug}` | auth | `session.switch_org` | Valida a membership do destino. Inexistente e alheia ⇒ **o mesmo `404`**. |
| `GET /api/organization` | **tenant** | `org.view` | Empresa ativa + papel. Query string rejeitada (`400`). |
| `PATCH /api/organization` | **tenant** | `org.settings.update` | Só `name`, `slug`, `publicMinNoticeMinutes`, `publicMaxAdvanceDays`, `publicMaxActiveBookingsPerPhone`. |

Respostas **não expõem o id interno** da empresa: o cliente a identifica pelo slug. Toda rota herda CSRF
(Origin + JSON), `no-store` e a validação de sessão com `credentials_version` (Etapa 4).

## 3. Decisões

1. **Escopo de tenant derivado só no servidor.** Sessão validada → `active_organization_id` → membership
   `(user, empresa)` com a empresa em JOIN. Nenhum `organizationId` é lido de corpo, query, path ou header
   (testado estática e dinamicamente). `X-Active-Org` (slug) é asserção de consistência: divergente ⇒ `409` sem
   executar nada; **ausente é aceito** (o documento diz que o frontend o envia; torná-lo obrigatório é decisão futura).
2. **Códigos de erro** (o plano fixa só 403/404/409): sem empresa ativa ⇒ `403 NO_ACTIVE_ORGANIZATION`;
   membership perdida ou empresa inativa ⇒ `403 ORGANIZATION_ACCESS_REVOKED` + a sessão perde a empresa ativa (4.1);
   sem permissão ⇒ `403 FORBIDDEN`; recurso inexistente/alheio ⇒ `404 NOT_FOUND`.
3. **Trocar de empresa usa o slug** (o plano proíbe o id vindo do cliente e `X-Active-Org` já é slug).
4. **Criar empresa define a empresa ativa** da sessão (mesma transação). Interpretação minha; evita um passo extra.
5. **Campos editáveis** (3.2: "nome, slug e limites"): `timezone`, `status`, `publishedAt`, `id`, `organizationId`,
   `role` são rejeitados (`.strict()`). Publicar a página é da Etapa 14.
6. **Tetos de sanidade dos limites** (não são regra de produto; o plano só dá os valores iniciais 120/60/3): antecedência
   mínima ≤ 7 dias, máxima ≤ 365 dias, agendamentos por telefone ≤ 20; pisos iguais ao CHECK do banco. Regra entre
   campos: mínima < máxima, validada sob **lock da linha da empresa** (6.5) contra o valor já gravado.
7. **Slug:** minúsculas/números/hífens, 3–40, lista de reservados (rotas da SPA/API e termos de marca). Repetido
   no banco por `CHECK`. Unicidade case-insensitive vem de gravar sempre em minúsculas.
8. **Fuso horário:** formato `Área/Local` ou `UTC`, gravado no nome canônico; rejeita `+03:00`, `EST` e fusos inexistentes.
   **Imutável também no banco** (gatilho `organizations_timezone_immutable`, `23514`) — ver seção 4.
9. **`forTenant()`** com lista **fechada** de operações e função pura `scopeOperationArgs` (testável); só modelos
   escopados são acessíveis; modelos globais lançam erro. Hoje só `Membership` é escopada.
10. **Classificação de rotas** declarada na própria rota (`config.access`) e coletada por `onRoute` (`app.routeRegistry`).
    Rotas `tenant` só podem ser criadas por `tenantRoute(action)`, que encadeia 401 → 403/409 → 403(permissão).
11. `authenticate` foi extraído de `auth/routes.ts` para `auth/authenticate.ts` (previsto na Etapa 4); comportamento inalterado.

## 4. Migration `20261019190000_organization_tenant_guards` (SQL manual)

- `UNIQUE INDEX memberships_one_owner_per_organization ON memberships(organization_id) WHERE role='OWNER'` — exatamente 1 `OWNER`
  por empresa (seção 5); continua válido quando `ADMIN` existir.
- `CHECK organizations_slug_format`.
- Gatilho `organizations_timezone_immutable` (R9) — decisão desta etapa: o banco garante o que consegue (princípio 3).
- Aplicada em banco novo (`agendly_clean`, criado e descartado; os outros bancos não foram tocados): 3 migrations
  aplicadas, objetos presentes, `db:drift` ⇒ "No difference detected"; no banco de desenvolvimento `migrate status` ⇒ "up to date".
- O teste da Etapa 3 que criava uma empresa com slug `"x"` foi ajustado para um slug válido (o novo CHECK o recusa).

## 5. Evidência (PostgreSQL real)

**Verificações finais:** `lint` e `typecheck` sem erros; `format:check` ok; **343 testes em 29 arquivos** passando
(eram 233 / 24); `db:drift` sem diferenças.

| Critério de 4.4 / do plano | Onde |
|---|---|
| Item 1 — inventário: todo modelo escopado **ou** global explícito; modelo novo não classificado falha | `test/org/tenant-lib.test.ts` (lido de `schema.prisma`) |
| Item 2 — matriz modelo × operação (15 operações): o `where`/`data` enviado tem o `organizationId`; divergente é rejeitado; lista fechada | `tenant-lib.test.ts` (+ `forTenant` com banco real: P2025 para id alheio, `$transaction` escopada) |
| Item 3 — regras estáticas (importação do Prisma/`date-fns-tz`, `new PrismaClient`, `…Unsafe`, allowlist de raw SQL, `FOR UPDATE`, acesso direto a modelo escopado, DELETE de pais, `organizationId` vindo do cliente) | `test/org/static-rules.test.ts` — **verificado por mutação**: um arquivo-isca com 7 violações fez 7 testes falharem |
| Item 4 — registro de rotas × classificação × teste A×B; rotas `tenant` sem sessão ⇒ 401 | `test/org/isolation.test.ts` |
| Item 5 — suíte A×B (ids/slug/headers/query/corpo manipulados; B intacto após todos os ataques) | `isolation.test.ts` |
| Item 6 — sentinela de SQL (nenhuma consulta a tabela escopada sem `organization_id`, exceto a allowlist justificada) | `isolation.test.ts` (+ teste de que a sentinela acusa uma consulta ruim) |
| Item 7 — FK composta entre tabelas escopadas | `isolation.test.ts` varre o catálogo: **banco do spike** (4 FKs compostas, nenhuma simples) e produção (0 FKs entre tabelas escopadas); cruzamento via SQL cru: `v3-composite-fk.test.ts` (Etapa 3) |
| `can()`: ações do OWNER permitidas; papel desconhecido/`constructor`/`__proto__` negado; ações inexistentes negadas | `test/org/permissions.test.ts` |
| Criação + `OWNER` atômica; falha em `membership` ou em `session` ⇒ nada gravado | `test/org/organizations.test.ts` |
| Sem e-mail verificado ⇒ 403; sem sessão ⇒ 401 em todas as rotas; entradas inválidas; campos não permitidos | `organizations.test.ts` |
| Timezone imutável (API **e** banco); `X-Active-Org` ⇒ 409; membership perdida; OWNER de 2 empresas | `organizations.test.ts` |
| Edições concorrentes que violariam a regra entre campos: uma passa, a outra recebe 400 | `organizations.test.ts` |
| Regressão de auth, verificação, recuperação de senha, outbox, CSRF, cookies, rate limits | suíte anterior inteira (233 testes) + 1 teste novo de redefinição com empresa ativa |

## 6. Garantias de isolamento (e o que NÃO é garantido)

- Identidade só da sessão; empresa ativa só da sessão + membership conferida **em toda requisição** (sem cache).
- Adulterar `sessions.active_organization_id` para a empresa de outro usuário ⇒ 403 e a empresa ativa é limpa (testado).
- `forTenant` + FKs compostas + regras estáticas + sentinela de SQL + A×B formam camadas independentes.
- **Não coberto pelo helper:** `$queryRaw`, filtros/`include` aninhados e escritas aninhadas (V7). Hoje isso é inócuo:
  o único modelo escopado é `Membership`, sem filhos. A proteção real dos filhos (Etapas 7–10) virá das FKs compostas
  e dos testes A×B de cada módulo.
- **Limite da Etapa 6:** o teste A×B "com todos os tipos de recurso" só pode usar os recursos que existem (empresa e
  membership). Cada módulo novo precisa ampliar `TENANT_ROUTES_WITH_AB_TESTS` e a suíte A×B, sob pena de o teste
  de registro de rotas falhar.

## 7. Limitações e riscos remanescentes

- Edição concorrente de configurações é "último que grava vence" por campo (não há coluna `version` em `organizations`).
- Slug alterado muda o `X-Active-Org` esperado; abas antigas recebem `409` (comportamento desejado).
- Trocar o slug de uma empresa não deixa redirecionamento do endereço antigo (a página pública ainda não existe).
- Rate limit de criação em memória (instância única), como os demais.
- `NO_ACTIVE_ORGANIZATION` como `403` e o `X-Active-Org` opcional são decisões a confirmar (seção 3, itens 1–2).
- O gatilho de timezone e o índice de OWNER único são SQL manual: o Prisma não detecta sua remoção (V4); estão cobertos
  por testes que falham se sumirem.
- `ORGANIZATION_ACCESS_REVOKED` só ocorre se a membership for removida fora do produto (o MVP não tem fluxo para remover membros); foi testado simulando um `DELETE` administrativo.

## Anexo — atualização proposta ao `docs/ARCHITECTURE.md` (NÃO aplicada)

Itens que mudariam: V7 (seção 13), decisões da Etapa 6 em 4.1 e as três invariantes de banco na seção 5.
Nenhum outro item passa a "resolvido".

```diff
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -294,6 +294,7 @@
 - `sessions.active_organization_id` define a empresa ativa. É definida/alterada por `POST /api/session/active-organization`, que **valida a membership** do destino.
 - A cada requisição, o `tenantPlugin` carrega sessão → confirma que a membership ainda existe (e o papel atual) → define `request.tenant = { organizationId, userId, role }`. Sem membership válida: 403 e a sessão perde a empresa ativa.
 - Rotas do painel **não** têm `organizationId` em path/body. Schemas Zod `.strict()` rejeitam o campo se enviado.
+- **Decisões da Etapa 6 (rotas de empresa):** `POST /api/session/active-organization` identifica o destino pelo **slug** (nunca por `organizationId`) e devolve `404` genérico para empresa inexistente ou de outro usuário. Sem empresa ativa, rotas escopadas respondem `403 NO_ACTIVE_ORGANIZATION`; membership perdida ⇒ `403 ORGANIZATION_ACCESS_REVOKED` e a empresa ativa é limpa. `X-Active-Org` é opcional e, **quando presente**, diverge ⇒ `409 ACTIVE_ORG_CHANGED`. Criar uma empresa a torna a ativa da sessão. Leituras do painel rejeitam qualquer parâmetro de consulta (`400`).
 - **Várias empresas × várias abas:** a empresa ativa é da *sessão*; trocar na aba B afeta a aba A. Mitigação: o frontend envia `X-Active-Org: <slug exibido>` como **asserção de consistência**; se divergir da empresa ativa da sessão, o servidor responde `409 ACTIVE_ORG_CHANGED` sem executar nada. O header nunca concede acesso. Teste dedicado (etapa 6).
 
 ### 4.2 Rotas públicas
@@ -352,8 +353,8 @@
 | **Session** | id, user_id, token_hash (único), active_organization_id?, credentials_version, expires_at, revoked_at?, last_seen_at, ip, user_agent | Token em claro nunca armazenado. |
 | **AuthToken** | id, user_id, type, token_hash (único), expires_at, used_at | Seção 3. |
 | **EmailOutbox** | id, to_email, template, payload_encrypted (com key_id), status, dead_reason, attempts, next_attempt_at, locked_until, lock_token, not_after, last_error, created_at, sent_at | Seção 3.6. Entrega *at-least-once*. |
-| **Organization** | id, name, slug (único), **timezone (imutável)**, status (enum `OrganizationStatus`, valor inicial `{ ACTIVE }`, extensível por migrations futuras), **published_at?**, **public_min_notice_minutes (120)**, **public_max_advance_days (60)**, **public_max_active_bookings_per_phone (3)** | Valores entre parênteses são *configurações iniciais sujeitas à validação com usuários reais* (R6, 6.7). Editáveis só por `OWNER`. `slug` com lista de reservados. |
-| **Membership** | id, user_id, organization_id, role | `role` aceita somente `OWNER` no MVP (mecanismo extensível a decidir no spike, V16); `UNIQUE(user_id, organization_id)`. Exatamente 1 `OWNER` por empresa criada; **sem fluxo para adicionar ou remover membros no MVP** (evolução futura). |
+| **Organization** | id, name, slug (único), **timezone (imutável)**, status (enum `OrganizationStatus`, valor inicial `{ ACTIVE }`, extensível por migrations futuras), **published_at?**, **public_min_notice_minutes (120)**, **public_max_advance_days (60)**, **public_max_active_bookings_per_phone (3)** | Valores entre parênteses são *configurações iniciais sujeitas à validação com usuários reais* (R6, 6.7). Editáveis só por `OWNER`. `slug` com lista de reservados. **Banco (Etapa 6):** `CHECK` de formato do slug (minúsculas/números/hífens, 3–40) e gatilho que recusa alterar `timezone`. |
+| **Membership** | id, user_id, organization_id, role | `role` aceita somente `OWNER` no MVP (mecanismo extensível a decidir no spike, V16); `UNIQUE(user_id, organization_id)`. Exatamente 1 `OWNER` por empresa criada (**índice único parcial** `memberships_one_owner_per_organization`, Etapa 6); **sem fluxo para adicionar ou remover membros no MVP** (evolução futura). |
 | **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. |
 | **Professional** | id, organization_id, name, active | Sem `user_id` (D2). |
 | **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. |
@@ -805,7 +806,7 @@
 | V4 | `EXCLUDE`/`CHECK`/índices parciais/trigger em migration manual sem drift (`migrate diff`) | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V4 |
 | V5 | `btree_gist` com `uuid` na versão do PostgreSQL | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V5 |
 | V6 | Mapeamento de SQLSTATE `23P01` e `P2002` no Prisma | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V6 |
-| V7 | Comportamento de `forTenant` em `findUnique`, `upsert`, `createMany`, escritas e leituras aninhadas | Etapas 3 e 6 | **Resolvido com ressalva** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V7. Ressalva: o teste foi um protótipo descartável; `$queryRaw`, filtros/`include` aninhados e escritas aninhadas **não** são cobertos pelo helper (a garantia nesses casos é a FK composta); a implementação de produção e seus testes continuam na Etapa 6 |
+| V7 | Comportamento de `forTenant` em `findUnique`, `upsert`, `createMany`, escritas e leituras aninhadas | Etapas 3 e 6 | **Resolvido com ressalva** (Etapas 3 e 6) — ver `STAGE-3-VALIDATIONS.md`, V7. Ressalva: o teste foi um protótipo descartável; `$queryRaw`, filtros/`include` aninhados e escritas aninhadas **não** são cobertos pelo helper (a garantia nesses casos é a FK composta); `forTenant()` de produção implementado e testado na Etapa 6 (lista fechada de operações, matriz modelo × operação, escopo em `$transaction`); hoje só `Membership` é escopada (a matriz é gerada do schema e passa a cobrir cada modelo novo); as limitações acima permanecem e são cobertas por FK composta, regras estáticas e revisão — ver `STAGE-6-VALIDATIONS.md` |
 | V8 | Coerência de `ends_at`/`blocked_until`: `CHECK` com `timestamptz + intervalo` (aceito? estável em dump/restore?), trigger que rejeita vs. que sobrescreve, atrito com Prisma — **decide a opção de 6.1** | Etapa 3 | **Resolvido com ressalva** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V8. Opção 1 (`CHECK`) aprovada em 6.1. Ressalvas: coluna gerada é impossível (`timestamptz + interval` não é `IMMUTABLE`); a aplicação deve recalcular `starts_at`, `ends_at` e `blocked_until` juntos em todo `UPDATE`; o trigger que sobrescreve não foi testado |
 | V9 | Biblioteca/lista de senhas comuns; parâmetros vigentes de argon2id | Etapa 4 | Não verificado |
 | V10 | Provedor de e-mail: limites do plano, SPF/DKIM/DMARC, entregabilidade, chave de idempotência, classificação de erro permanente | Etapa 5 (escolha) e 16 | Não verificado |
```
