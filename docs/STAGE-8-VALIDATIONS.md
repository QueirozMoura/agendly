# Etapa 8 — Profissionais e vínculo com serviços

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado; a atualização sugerida está no
> anexo (diff pronto). Nenhuma validação `[VALIDAR]` mudou de estado.

## 1. Escopo (seção 11 do plano)

"`Professional` (sem login), `ProfessionalService`." Aceite: vincular serviço de outra empresa falha (aplicação ⇒ 404; SQL cru ⇒
erro de FK composta); A×B verde. Conferido antes de começar: Etapa 7 commitada (`f3ffbce`) e árvore limpa.

## 2. Rotas, permissões e regras

Todas `access: "tenant"` (`tenantRoute(action)`): 401 → 403/409 de contexto → 403 de permissão. Escritas exigem Origin e JSON.

| Rota | Ação (`can`) | Resultado |
|---|---|---|
| `GET /api/professionals[?active=]` | `professionals.read` | Lista por nome, com `serviceIds`. Outro parâmetro de consulta ⇒ 400. |
| `POST /api/professionals` | `professionals.create` | `201`. Limite de 120 criações/h por usuário (`429`, em memória). |
| `GET /api/professionals/:id` | `professionals.read` | 404 idêntico para inexistente, malformado **e** de outra empresa. |
| `PATCH /api/professionals/:id` | `professionals.update` | `name` e/ou `active` (ativar/desativar). Sob a trava N2 do profissional. |
| `PUT /api/professionals/:id/services` | `professionals.link_service` | Define o conjunto **completo** de serviços (substitui o anterior; `[]` desvincula tudo). |

Regras: `name` 1–100 caracteres (teto de sanidade); `.strict()` rejeita `organizationId`, `id`, `userId` (profissionais não têm conta, D2) e
`active` na criação; sem `DELETE` (R-c). `serviceIds`: UUIDs, no máximo 200 (sanidade), repetidos são ignorados; formato inválido ⇒ 400.
Serviço **inexistente ou de outra empresa ⇒ 404** (igual a inexistente) e **nada é aplicado** (nem os serviços válidos da mesma chamada).
Serviços e profissionais **inativos podem ser vinculados** (o plano não restringe; decisão a confirmar).

### Concorrência (6.5)
Desativar profissional e alterar vínculos são "N2 profissional → N4": `lockProfessional` (`FOR NO KEY UPDATE`, filtrada por
`organization_id`, em `lib/db/locks`) serializa as duas operações. Sem a trava, dois `PUT` simultâneos deixariam a **união** dos
conjuntos; com ela, o resultado é sempre exatamente um dos dois (testado, 6 rodadas × 4 requisições). Só uma trava (um profissional) existe
hoje: o `lockProfessionals` ordenado, o guard de ordem e o `lock_timeout` seguem na Etapa 9.

## 3. Migration `20261019210000_professionals`

- `professionals` com `UNIQUE (organization_id, id)` (alvo das FKs compostas das etapas 9 e 10) e índice `(organization_id, active, name)`.
- `professional_services`: PK `(professional_id, service_id)`; **duas FKs compostas** `(organization_id, professional_id)` e
  `(organization_id, service_id)`, ambas `ON DELETE RESTRICT ON UPDATE RESTRICT` (nunca `SET NULL`); índice `(organization_id, service_id)`.
- Sem SQL manual nesta migration (nada além do que o Prisma modela). O carimbo gerado era anterior ao da Etapa 7 (relógio do ambiente); a pasta
  foi renomeada para `20261019210000_professionals` **antes** de ser aplicada, então nenhuma linha de `_prisma_migrations` precisou ser alterada.
- Banco novo temporário (`agendly_tmp_s8check`, criado e descartado; antes e depois existiam só `agendly`, `agendly_spike` e `agendly_test`):
  5 migrations aplicadas, `db:drift` ⇒ "No difference detected"; checksums idênticos entre arquivos, banco temporário e banco de desenvolvimento
  (`migrate status` ⇒ "up to date").

## 4. Isolamento multi-tenant

- `Professional` e `ProfessionalService` entraram em `TENANT_SCOPED_MODELS`; inventário e matriz de operações os cobrem automaticamente (lidos do schema).
  Todo acesso do módulo passa por `forTenant()`.
- **Integridade referencial entre empresas:** as FKs compostas fazem o banco recusar vínculo entre empresas diferentes, **nas quatro combinações**
  (serviço alheio, profissional alheio, nas duas empresas) — por SQL cru (`23503`, com o nome da FK esperada) e pelo Prisma sem escopo. O vínculo
  correto na mesma empresa é aceito; vínculo duplicado viola a PK; apagar profissional ou serviço vinculado é barrado (RESTRICT).
- **Varredura de FKs do catálogo** (4.4, item 7): no banco de produção agora existem exatamente 2 FKs entre tabelas escopadas
  (`professional_services→professionals`, `→services`) e **ambas são compostas** — antes a varredura era vacuamente verdadeira.
- **A×B** (`test/org/isolation.test.ts`): A não lê, altera, desativa nem vincula nada de B; as respostas de 5 tentativas de vínculo
  (profissional alheio, serviço alheio, mistura, id inexistente, profissional inexistente) são **idênticas entre si**; `organizationId` no corpo/na
  query ⇒ 400; `X-Active-Org` de B ⇒ 409; vínculos e linhas de B ficam idênticos. Sentinela de SQL: consultas a `professionals`/`professional_services`
  citam `organization_id` (inclusive a trava, que é SQL cru).
- Registro de rotas: 5 rotas novas incluídas na lista A×B (o teste exige). Regra estática de acesso direto a modelo escopado cobre os modelos novos
  (**verificado por mutação**: um arquivo-isca com acesso direto a `professional`/`professionalService` falhou o teste).
- A allowlist de SQL cru em `lib/db/locks/index.ts` foi reescrita para incluir `professionals`, e o teste "SQL cru em tabela escopada cita
  `organization_id`" passou a derivar as tabelas do schema (antes era uma lista fixa com `memberships`).

**Limites (inalterados, V7):** `forTenant` não cobre `$queryRaw`, `include`/filtros aninhados nem escritas aninhadas — o `serviceIds` do detalhe vem
de uma segunda consulta escopada, não de `include`. A garantia dos filhos é a FK composta.

## 5. Testes e resultados reais

| Verificação | Resultado |
|---|---|
| `npm test` (suíte completa) | **386 testes em 31 arquivos, todos passando** (eram 367 / 30) |
| Testes novos | 17 em `test/professionals/professionals.test.ts` + 2 A×B em `isolation.test.ts` (+ ajustes de regras/varredura) |
| `npm run lint` / `typecheck` | 0 erros / 0 erros |
| `npm run format:check` | passou |
| `npm run db:drift` | "No difference detected" |
| Migrations em banco limpo | 5 aplicadas, sem drift |

## 6. Limitações, riscos e decisões a confirmar

- Vincular serviços/profissionais inativos é permitido; se o produto quiser impedir, é uma regra nova (Etapa 12/14, disponibilidade pública).
- Sem controle otimista de versão em `professionals` (mesmo critério de `services`): duas edições do mesmo campo valem "a última vence".
- Nome duplicado é permitido; lista sem paginação (mitigada pelo limite de criação).
- O `PUT` substitui o conjunto inteiro: um cliente com a lista desatualizada pode remover vínculos feitos por outra aba. A trava garante consistência, não
  "merge". Um `PATCH` incremental (adicionar/remover) pode ser considerado depois.
- Uma trava só (N2 de um profissional): a ordem global entre vários recursos, o guard e o `lock_timeout` ainda não existem (Etapa 9).
- Os tetos de sanidade e o limite de 120 criações/h são decisões minhas, não do plano.
- Sem divergência em relação à arquitetura aprovada.

## Anexo — atualização sugerida ao `docs/ARCHITECTURE.md` (NÃO aplicada)

Documenta as invariantes de banco (seção 5) e as rotas/trava da Etapa 8. Nenhuma validação muda de estado.

```diff
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -356,8 +356,8 @@
 | **Organization** | id, name, slug (único), **timezone (imutável)**, status (enum `OrganizationStatus`, valor inicial `{ ACTIVE }`, extensível por migrations futuras), **published_at?**, **public_min_notice_minutes (120)**, **public_max_advance_days (60)**, **public_max_active_bookings_per_phone (3)** | Valores entre parênteses são *configurações iniciais sujeitas à validação com usuários reais* (R6, 6.7). Editáveis só por `OWNER`. `slug` com lista de reservados. **Banco (Etapa 6):** `CHECK` de formato do slug (minúsculas/números/hífens, 3–40) e gatilho que recusa alterar `timezone`. |
 | **Membership** | id, user_id, organization_id, role | `role` aceita somente `OWNER` no MVP (mecanismo extensível a decidir no spike, V16); `UNIQUE(user_id, organization_id)`. Exatamente 1 `OWNER` por empresa criada (**índice único parcial** `memberships_one_owner_per_organization`, Etapa 6); **sem fluxo para adicionar ou remover membros no MVP** (evolução futura). |
 | **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. **Banco (Etapa 7):** `CHECK`s de piso (`duration_minutes >= 1`, `buffer_minutes >= 0`, `price_cents` nulo ou `>= 0`) e `UNIQUE (organization_id, id)` (alvo das FKs compostas das etapas 8 e 10); não há `DELETE` (R-c): desativa-se com `active`. Tetos de sanidade só na API: duração e buffer ≤ 1440 min, preço ≤ R$ 1.000.000,00, nome ≤ 100 caracteres. |
-| **Professional** | id, organization_id, name, active | Sem `user_id` (D2). |
-| **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. |
+| **Professional** | id, organization_id, name, active | Sem `user_id` (D2). **Banco (Etapa 8):** `UNIQUE (organization_id, id)` (alvo das FKs compostas); não há `DELETE` (R-c): desativa-se com `active`. Teto de sanidade só na API: nome ≤ 100 caracteres. |
+| **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. **Banco (Etapa 8):** PK `(professional_id, service_id)`; as duas FKs `(organization_id, …)` são `ON DELETE RESTRICT ON UPDATE RESTRICT` (nunca `SET NULL`); índice `(organization_id, service_id)`. Sem `id` próprio. |
 | **WorkingHours** | id, organization_id, professional_id, weekday (0–6), start_time, end_time | Hora **local** da empresa; vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. |
 | **TimeOff** | id, organization_id, professional_id, starts_at, ends_at, reason | `CHECK (ends_at > starts_at)`. |
 | **Customer** | id, organization_id, name, phone_e164, email?, notes? | `UNIQUE(organization_id, phone_e164)`. Dado pessoal (LGPD). Criação pela página pública **não sobrescreve** dados de cliente existente. Sem campos de nicho (D13). |
@@ -754,7 +754,7 @@
 - Aceite: validação de limites; A×B verde; somente o `OWNER` da empresa ativa opera; usuário de outra empresa ⇒ 404.
 
 **Etapa 8 — Profissionais e vínculo com serviços**
-- Entrega: `Professional` (sem login), `ProfessionalService`.
+- Entrega: `Professional` (sem login), `ProfessionalService`. Rotas: `GET`/`POST /api/professionals`, `GET`/`PATCH /api/professionals/:id` (sem `DELETE`: ativar/desativar é um `PATCH` de `active`) e `PUT /api/professionals/:id/services` (define o conjunto COMPLETO de serviços, de forma atômica); ações `professionals.read`, `professionals.create`, `professionals.update` e `professionals.link_service`. Desativar o profissional e alterar vínculos já passam pela trava N2 de **um** profissional (`lockProfessional`, 6.5); as várias travas ordenadas e o guard de ordem continuam na Etapa 9.
 - Aceite: vincular serviço de outra empresa falha (aplicação ⇒ 404; SQL cru ⇒ erro de FK composta); A×B verde.
 
 **Etapa 9 — Disponibilidade e locks**
```
