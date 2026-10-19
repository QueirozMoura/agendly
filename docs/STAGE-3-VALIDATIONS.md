# Etapa 3 — Resultados das validações técnicas

> Status: **para aprovação humana antes da Etapa 4.** Este arquivo registra evidências reais. O
> `docs/ARCHITECTURE.md` **não** foi alterado: as correções que os resultados sugerem estão listadas na
> seção 3 e aguardam sua decisão.
>
> Ambiente: PostgreSQL **18.6** (imagem `postgres:18.6`, Docker, porta 5433), Node **24.19.0**, Prisma
> **7.10.1** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`), `date-fns` **4.4.0**, `date-fns-tz`
> **3.2.0**, `uuid` **14.0.3**, `pg` **8.23.1**. Evidência = teste automatizado em `backend/test/` (Postgres real) ou
> saída de CLI citada. Nada aqui vem de memória ou de suposição.

## 1. Decisões de versão

| Item | Escolha | Motivo |
|---|---|---|
| Prisma | **7.10.1** (dist-tag `@prisma/client latest`) | O dist-tag `latest` do pacote `prisma` aponta para `8.0.0-rc.23` (release candidate); `prev` = 7.10.1. Escolhida a última estável compatível com `@prisma/client latest`. |
| Prisma 7 | Exige *driver adapter* (`@prisma/adapter-pg`) e `prisma.config.ts`; gerador `prisma-client` com `output` obrigatório | Cliente gerado em `backend/src/generated/prisma` (ignorado pelo Git; `npm run db:generate`, executado também antes do `typecheck`). |
| `date-fns` / `date-fns-tz` | 4.4.0 / 3.2.0 | Peer de `date-fns-tz@3.2.0`: `date-fns ^3 \|\| ^4`. |
| UUID v7 | `@default(uuid(7))` no schema + `newId()` (pacote `uuid`) | Ver V2. |

Observação de ambiente: o npm 11 avisou que o `postinstall` de `@prisma/engines` foi bloqueado
(`allow-scripts`). O CLI e o *schema engine* funcionaram normalmente (binário já presente), então nada
foi aprovado; se um `npm ci` limpo falhar por isso, é preciso `npm approve-scripts`.

## 2. Resultado por item [VALIDAR]

Legenda: ✅ resolvido com evidência · ⚠️ resolvido com ressalva · — fora desta etapa.

### V1 ✅ `date-fns-tz` × `date-fns`, IANA e DST — `test/spikes/v1-time.test.ts`
- Compatível com `date-fns` 4.4.0; São Paulo (UTC-3 hoje, UTC-2 em janeiro/2018) e Nova York corretos.
- **Armadilhas encontradas:** (a) horário local **inexistente** (lacuna do DST) é convertido
  silenciosamente para um instante 1 h antes, que corresponde a *outro* horário local; (b) fuso inválido
  devolve `Invalid Date` sem lançar; (c) horário **ambíguo** resolve para a 1ª ocorrência.
- **Decisão:** `lib/time/zone.ts` (único importador de `date-fns-tz`) valida o fuso com `Intl`, faz
  ida-e-volta e lança `TimeZoneError` para horário inexistente. `computeSlots` (Etapa 9) deve tratar esse
  erro como "slot inexistente".

### V2 ✅ UUID v7 — `test/db/identity.test.ts`
- `@default(uuid(7))` gera v7 em colunas `uuid`; 20 inserções saem em ordem lexicográfica = ordem de criação.
- `newId()` (pacote `uuid`) gera v7, aceito como PK; 1000 ids únicos e ordenados.
- PostgreSQL 18 tem `uuidv7()` nativo (testado; **não adotado**: a aplicação precisa do id antes do INSERT).
- **Decisão:** default do Prisma no schema; `newId()` quando o id for necessário antes do INSERT.

### V3 ✅ FK composta no Prisma — `test/spikes/v3-composite-fk.test.ts`
- Um mesmo campo `organizationId` compartilhado por **4 relações** (1 simples + 3 compostas) é aceito
  (`prisma validate`) e gera as 3 FKs compostas (`pg_constraint`).
- `create` com profissional de outra empresa ⇒ P2003; SQL cru ⇒ `23503` na FK
  `appointments_organization_id_professional_id_fkey` (a FK, não a exclusão, barra o par inconsistente);
  `connect` aninhado cruzado também ⇒ P2003 e nada gravado.
- **Relação composta opcional:** com `professional_id = NULL` a FK **não verifica nada** (MATCH SIMPLE) —
  aceito; com valor, volta a valer. `onDelete: SetNull` em relação composta opcional: o Prisma só
  *avisa* e gera `ON DELETE SET NULL` sobre **as duas colunas** (anularia `organization_id NOT NULL`).
  **Regra:** nunca usar `SetNull` em FK composta; usar `Restrict`.
- Detalhe: o Prisma emite `ON UPDATE CASCADE` por padrão. Os IDs são imutáveis, mas nas etapas 7–10
  convém declarar `onUpdate: Restrict` explicitamente.
- Com `ON DELETE RESTRICT` o SQLSTATE é **`23001`** (não `23503`) — ver V6.

### V4 ✅ SQL manual sem drift — `test/spikes/v4-v5-v8-constraints.test.ts`, migração de identidade
- `EXCLUDE USING gist`, `CHECK`, índice parcial e `CREATE EXTENSION` em migration manual aplicam com
  `migrate dev`/`deploy`; `prisma migrate diff --from-config-datasource --to-schema … --exit-code` ⇒
  "No difference detected" (exit 0). Em **banco novo** (`agendly_clean`, criado e descartado): `migrate
  deploy` aplicou a migration de identidade, o diff não mostrou drift e os dois CHECKs existiam.
- Uma mudança de schema (nova coluna) gera SQL que **não** toca EXCLUDE/CHECK/índice parcial.
- ⚠️ **Limite:** o Prisma **não detecta** a remoção manual da EXCLUDE (diff após `DROP CONSTRAINT` ⇒
  "No difference detected"). A proteção contra drift é o teste de `pg_constraint` (6.1, teste 9) — já existe
  no spike e deve ser portado na Etapa 10.

### V5 ✅ `btree_gist` com `uuid` — mesmo arquivo
- `btree_gist` 1.8 em PG 18.6 aceita `organization_id WITH =, professional_id WITH =` (ambos `uuid`) +
  `tstzrange(...) WITH &&`.
- ⚠️ A extensão foi criada com a role superusuária do contêiner local. Em hospedagem gerenciada é preciso
  confirmar o privilégio para `CREATE EXTENSION` (não verificado; relevante para a Etapa 16 / V12).

### V6 ✅ SQLSTATE no Prisma 7 — `test/spikes/v6-v15-errors-locks.test.ts`, `src/lib/db/errors.ts`
| Situação | Código Prisma | SQLSTATE |
|---|---|---|
| EXCLUDE, ORM `create` | `P2039` | `23P01` em `meta.driverAdapterError.cause.originalCode` |
| EXCLUDE, `$executeRaw` | `P2010` | idem |
| UNIQUE, ORM / raw | `P2002` / `P2010` | `23505` |
| FK com `RESTRICT`, ORM `delete` | `P2003` | **`23001`** (`restrict_violation`) |
| CHECK, ORM | — | `23514` |
| Deadlock / `lock_timeout` | — | `40P01` / `55P03` (em transação interativa e raw) |
- **Decisão:** `classifyDbError()` lê o SQLSTATE e usa os códigos `P2002`/`P2003` como reserva; mapeia
  `23001`+`23503` ⇒ `foreign_key_violation`. O mapeamento para HTTP 409/503 fica para as etapas que usam.
- O campo `detail` do erro do driver traz **valores de chave** (PII potencial): o sanitizador de logs da Etapa 2
  já o descarta.

### V7 ⚠️ `forTenant` — `test/spikes/v7-for-tenant.test.ts` (protótipo descartável; produção = Etapa 6)
- **Coberto** pelo extension (`$allOperations`, lista fechada): `findMany/First/Unique(OrThrow)`, `count`,
  `aggregate`, `groupBy`, `update`, `updateMany`, `delete`, `deleteMany`, `create`, `createMany`, `upsert`;
  `findUnique`/`update`/`delete` aceitam `where` estendido com `organizationId` (id de outro tenant ⇒
  `null`/`P2025`); funciona dentro de `$transaction` interativa; operação fora da lista lança erro.
- **Não coberto (confirmado):** `$queryRaw` (vê todos os tenants), filtros/`include` aninhados, escritas
  aninhadas. Nesses casos a garantia vem da **FK composta** (`connect` cruzado ⇒ P2003).
- Confirma a postura do documento: o helper é redução de risco; o isolamento é helper + FKs + testes (4.4).

### V8 ⚠️ Coerência de `blocked_until` — decisão proposta: **opção 1 com `CHECK`**
Critérios de 6.1: (a) funciona com `create`/`update` do Prisma ✅ (a aplicação precisa recalcular os três
campos juntos; um `update` parcial de `starts_at` é rejeitado com `23514`); (b) a exclusão usa
`blocked_until` ✅; (c) sobrevive a `pg_dump`/restore ✅ (dump do schema spike restaurado em banco novo, com
as três constraints presentes); (d) SQL cru incoerente falha ✅ (`23514`, `appointments_range_coherent`).
- `CHECK (ends_at = starts_at + make_interval(mins => duration_minutes_snapshot) AND blocked_until =
  ends_at + make_interval(mins => buffer_minutes_snapshot))`.
- `timestamptz + interval` é `STABLE` (`timestamptz_pl_interval`), então **coluna gerada falha** (`42P17`);
  `make_interval` é `IMMUTABLE`. O resultado do CHECK foi igual com `TimeZone` = UTC, São Paulo e Nova York
  (intervalo só em minutos, sem componente de dia/mês).
- Trigger "rejeita" também funciona (testado em tabela temporária), mas é redundante. Trigger que
  *sobrescreve* **não foi testado** (opção 2 descartada por desnecessária).
- **Ainda dependente de aprovação** (14.2): confirmar a opção 1.

### V13 ✅ `INSERT … ON CONFLICT DO UPDATE … WHERE` — `test/spikes/v13-idempotency.test.ts`
- Chave nova ⇒ insere e devolve a linha; vigente ⇒ **nenhuma** linha e nada alterado; vencida ⇒ re-reivindicada.
- Duas transações com a mesma chave nova: a segunda **espera** a primeira (bloqueada no índice único) e,
  após o commit, não devolve linha (READ COMMITTED vê a linha vigente) ⇒ cai no replay/409. Com
  `ROLLBACK` da primeira, a segunda vira a dona.
- Duas re-reivindicando a mesma chave vencida: exatamente uma vence (a outra reavalia o `WHERE` e não casa).
- Limpeza `DELETE … FOR UPDATE SKIP LOCKED` com margem não remove linha vigente nem de transação aberta.

### V15 ✅ locks de linha — mesmo arquivo de V6
- `SELECT … FOR NO KEY UPDATE` via `$queryRaw` dentro de `$transaction` interativa serializa o mesmo
  profissional e **não** bloqueia profissionais diferentes (L3). `SET LOCAL lock_timeout` vale só na transação;
  o isolamento padrão é `read committed`.
- Timeout de transação interativa do Prisma: expirar ⇒ `P2028`; o padrão é **5 s** (medido: erro após
  5 607 ms). `maxWait` padrão **não** foi medido.
- Deadlock (`40P01`) e `lock_timeout` (`55P03`) chegam com SQLSTATE e são classificados.
- Compatibilidade: com `FOR NO KEY UPDATE` no `users`, o `INSERT` em `sessions` (checagem `FOR KEY SHARE`)
  **não espera**; com `FOR UPDATE` espera e estoura `55P03`. Confirma o raciocínio de 3.4 (por isso a
  validação de `credentials_version` por requisição é necessária).
- ⚠️ **Achado importante (afeta a especificação do teste 8 de 6.1):** só com a EXCLUDE, N inserções
  concorrentes no mesmo slot terminam com **1 sucesso e perdedores com `40P01`** (deadlock resolvido após
  `deadlock_timeout`, ~1 s+), não `23P01`. Nenhum agendamento duplicado é gravado (invariante preservada),
  mas o erro e a latência são ruins. **Com o lock do profissional** (N2) as 8 criações paralelas deram 1
  sucesso + 7×`23P01`, em < 900 ms, sem deadlock. Conclusão: o lock N2 não é opcional para o fluxo normal;
  a EXCLUDE é a rede de segurança.

### V16 ✅ `memberships.role` — `test/spikes/v16-role.test.ts`
- **Decisão:** enum nativo `MembershipRole { OWNER }`. Adicionar `ADMIN` gera exatamente
  `ALTER TYPE "MembershipRole" ADD VALUE 'ADMIN';` (migration de uma linha). SQL cru com `'ADMIN'` hoje
  falha (`22P02`). Não testado: usar o valor novo na mesma transação do `ADD VALUE` (restrição conhecida do
  PostgreSQL; a migration do `ADMIN` deve ficar separada de qualquer uso do valor).

### Não pertencem a esta etapa
V9 (Etapa 4), V10 (5 e 16), V11 (condicional), V12 (16), V14 (5): **não tocadas e continuam "não verificado"**.

## 3. Correções sugeridas ao `docs/ARCHITECTURE.md` (NÃO aplicadas — aguardam aprovação)
1. **Seção 13:** marcar V1–V8, V13, V15, V16 como resolvidos, com link para este arquivo (V7 e V8 com as ressalvas acima).
2. **Seção 6.1, decisão V8:** registrar a opção 1 (`CHECK` com `make_interval`).
3. **Seção 6.1, teste 8:** reescrever — "N inserções paralelas **com o lock N2**: 1 sucesso, N−1 `23P01`/409; sem
   o lock, a invariante vale mas perdedores podem receber `40P01`".
4. **Seção 4.3/7:** mapeador de erros — SQLSTATE em `meta.driverAdapterError.cause.originalCode`; FK `RESTRICT` ⇒ `23001`.
5. **Seção 4.3:** FK composta — proibir `SetNull`; declarar `onUpdate: Restrict`.
6. **Seção 5:** `organizations.status` ficou como enum `OrganizationStatus { ACTIVE }` (o documento não lista valores).

## 4. O que a Etapa 3 entregou além dos spikes
- Prisma 7 + `prisma.config.ts`; schema e migration `init_identity` (`users` com `credentials_version`,
  `organizations`, `memberships`, `sessions`, `auth_tokens`) com dois CHECKs manuais
  (`users_email_lowercase`, `organizations_public_limits_valid`). Não existem tabelas de negócio, outbox nem
  idempotência no schema de produção.
- `lib/db/client.ts` (único `PrismaClient`), `lib/db/errors.ts`, `lib/ids.ts`, `lib/time/zone.ts`.
- Os spikes ficam em `backend/spikes/` (banco `agendly_spike`, schema próprio, **fora** do schema de
  produção) e em `backend/test/spikes/`. Testes de banco usam `agendly_test` e `agendly_spike`, criados e
  migrados pelo `globalSetup` do Vitest.
