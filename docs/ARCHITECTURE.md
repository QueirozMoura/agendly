# Agendly — Arquitetura proposta (revisão 4)

> Status: **proposta corrigida, aguardando aprovação humana.** O código de aplicação (funcionalidades do produto: autenticação, empresas, serviços, agendamentos etc.) ainda não foi implementado. Já existem a infraestrutura das Etapas 1 a 3 (monorepo, backend base, fundação do banco com a migration de identidade) e os spikes técnicos da Etapa 3, todos testados contra PostgreSQL real; ver [`STAGE-3-VALIDATIONS.md`](./STAGE-3-VALIDATIONS.md).
>
> **Aviso geral:** os testes e critérios de aceite descritos neste documento são **especificações**, salvo os já implementados e executados nas etapas concluídas (backend base e validações técnicas da Etapa 3). As validações V1–V8, V13, V15 e V16 foram concluídas na Etapa 3, com evidência em [`STAGE-3-VALIDATIONS.md`](./STAGE-3-VALIDATIONS.md). Os demais testes e critérios descritos aqui, e as validações pendentes (V9–V12 e V14), **continuam não escritos, não executados ou não verificados**.
>
> Como ler este documento (os tipos de afirmação ficam separados):
> - **Decisões de produto aprovadas** — fixas; consolidadas na **seção 15** (D1–D14 da revisão 2, R1–R10 da revisão 3 e C1–C6 da revisão 4).
> - **Proposta técnica** — o desenho deste documento, derivado das decisões aprovadas; só vira definitivo com a aprovação da arquitetura (etapa 0).
> - **[VALIDAR]** — compatibilidade ou comportamento técnico que precisa de comprovação. Lista consolidada na **seção 13**. Os itens V1–V8, V13, V15 e V16 foram **resolvidos na Etapa 3** (evidência em [`STAGE-3-VALIDATIONS.md`](./STAGE-3-VALIDATIONS.md)), com ressalvas para V7 e V8 registradas na própria seção 13; os demais continuam "não verificado". Nada ali é decisão de produto e nada que siga "não verificado" deve ser tratado como garantia antes de teste ou consulta à documentação oficial.
> - **[DECIDIR]** — pergunta que ainda precisa de resposta humana. A **seção 14** separa o que bloqueia a Etapa 1, o que se resolve na Etapa 3 e o que se resolve nas etapas seguintes.

## Sumário

0. Princípios · 1. Arquitetura geral · 2. Estrutura de diretórios · 3. Autenticação, permissões, e-mail e senha · 4. Multi-tenant · 5. Entidades · 6. Agendamentos: conflitos, buffer, idempotência e concorrência · 7. Testes, segurança, logs e erros · 8. WhatsApp (pós-MVP) · 9. Riscos · 10. Hospedagem · 11. Sequência do MVP · 12. Fora do MVP · 13. Validações técnicas pendentes · 14. Decisões humanas pendentes · 15. Decisões de produto aprovadas e rastreio

---

## 0. Princípios

1. **Monólito modular.** Um backend, um banco, um frontend. Sem microsserviços, filas externas ou cache distribuído.
2. **O servidor é a fonte da verdade** para identidade, empresa (tenant), permissões e disponibilidade.
3. **O banco garante as invariantes que ele consegue garantir** (sobreposição de agendamentos, integridade entre empresas). As que ele *não* consegue (ex.: agendamento × folga, limite por telefone) são protegidas por uma estratégia explícita de bloqueio e testadas (seção 6.5).
4. **Nenhuma garantia é presumida.** Onde um helper, uma constraint ou uma biblioteca *parece* garantir algo, a garantia só vale se houver teste que a detecte quebrando.
5. **Nada que importe vive só em memória.** Efeitos que não podem ser perdidos (e-mails de verificação/recuperação, idempotência) são persistidos no PostgreSQL na mesma transação que os origina.
6. **Simplicidade operacional:** um servidor pequeno + PostgreSQL.
7. **Sem antecipação:** WhatsApp, cobrança, convites, CAPTCHA, Sentry, RLS e demais itens da seção 12 não entram no MVP.

---

## 1. Arquitetura geral

```
 Navegador (React SPA) ──HTTPS──▶ Proxy reverso (Caddy/Nginx)
                                     ├── /          → arquivos estáticos do frontend
                                     └── /api/*     → Fastify (backend)
                                                         │
                                                         ├──▶ PostgreSQL  (dados + email_outbox + idempotência)
                                                         └── laço de manutenção/e-mail (mesmo processo no MVP)
                                                                 └──▶ EmailSender (interface; provedor definido na implementação)
```

| Camada | Responsável por | **Não** é responsável por |
|---|---|---|
| **Frontend** (React + TS + Vite, SPA, pt-BR) | UI, formulários, chamadas à API, UX de erros. Validação Zod *de conveniência*. | Segurança, autorização, disponibilidade, decisões de tenant. |
| **Backend** (Fastify + TS) | Autenticação, sessões, autorização, resolução de tenant, validação, regras de negócio, cálculo de slots, transações e bloqueios, logs, rate limit, drenagem da fila de e-mail e manutenção. | Renderização de UI. |
| **PostgreSQL** | Persistência, integridade referencial, FKs compostas, constraint de exclusão, unicidades, fila durável de e-mail. | Regras que mudam com frequência; consistência agendamento × folga/horário (feita por lock de linha, 6.5). |

Decisões gerais:

- **Mesma origem em produção** (SPA e `/api` sob o mesmo domínio): sem CORS em produção, cookies `SameSite` simples. Em desenvolvimento o Vite faz proxy de `/api`.
- **SPA**, sem SSR. A página pública de agendamento também é SPA.
- **Idioma:** UI somente em `pt-BR`, sem framework de i18n. Erros da API têm `code` estável + `message` em pt-BR.
- **Tempo:** `timestamptz` (UTC) no banco; cada empresa tem `timezone` IANA, **imutável após a criação no MVP** (R9). Biblioteca: **`date-fns-tz`** (D8) — **[VALIDAR V1]**. Um módulo `lib/time` é o único a converter fuso. Um `Clock` injetável fornece o "agora" (necessário para testar as regras de passado/antecedência).
- **IDs:** **UUID v7** (D9) em colunas `uuid`, geradas pela aplicação — **[VALIDAR V2]**. IDs nunca substituem a checagem de tenant.
- **Trabalho em segundo plano no MVP:** não há fila externa, mas **existe** um laço de manutenção no próprio processo da API que drena a tabela durável `email_outbox` e executa limpezas (idempotência expirada, sessões e tokens expirados, linhas antigas da outbox). O laço só lê estado do banco: se o processo cair, nada é perdido e o trabalho retoma no reinício. Pode ser movido para um segundo processo Node sem mudar o desenho. Detalhes em 3.6.

---

## 2. Estrutura de diretórios

npm workspaces; sem Turborepo/Nx; **sem pacote `shared/`** (D10).

```
agendly/
├── package.json              # workspaces: ["frontend", "backend"]
├── .env.example              # apenas nomes de variáveis
├── docker-compose.yml        # Postgres para dev e testes
├── docs/
│   ├── PROJECT.md
│   └── ARCHITECTURE.md
├── backend/
│   ├── package.json · tsconfig.json
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/       # inclui SQL manual (constraints, locks auxiliares)
│   ├── src/
│   │   ├── server.ts · app.ts       # buildApp(): testável sem porta
│   │   ├── config/env.ts            # valida process.env com Zod
│   │   ├── plugins/                 # session, tenant, rate-limit, error-handler
│   │   ├── jobs/                    # laço de manutenção + drenagem da email_outbox
│   │   ├── lib/
│   │   │   ├── db/                  # ÚNICO lugar que importa PrismaClient; forTenant(); unscoped/; locks/
│   │   │   ├── time/                # ÚNICO lugar que usa date-fns-tz; Clock
│   │   │   ├── ids.ts · crypto.ts
│   │   │   └── email/               # EmailSender + implementação console/captura
│   │   └── modules/
│   │       ├── auth/ · organizations/ · services/ · professionals/
│   │       ├── availability/        # WorkingHours, TimeOff, computeSlots
│   │       ├── customers/ · appointments/ (inclui idempotência) · public-booking/
│   └── test/                        # integração (Postgres real), helpers, suíte de isolamento
└── frontend/
    ├── package.json · vite.config.ts   # proxy /api → backend em dev
    └── src/ { main.tsx, api/, features/, components/, routes/, test/ }
```

Regras:

- Cada módulo: `routes.ts` (HTTP + Zod) → `service.ts` (regras) → acesso a dados via `lib/db`.
- O frontend **nunca** importa código do backend; os tipos de contrato ficam em `frontend/src/api/`.
- Imports de `@prisma/client` e `date-fns-tz` fora de `lib/db` e `lib/time` são proibidos e verificados por lint/teste estático (4.4).

---

## 3. Autenticação, permissões, e-mail e senha

### 3.1 Sessões

Sessão no servidor com cookie `HttpOnly`, **não JWT** (revogação imediata, nada sensível em `localStorage`).

- Login por e-mail + senha; hash **argon2id**; mínimo de 10 caracteres + checagem contra lista de senhas comuns (**[VALIDAR V9]**).
- No login gera-se token aleatório de 32 bytes (CSPRNG). Só o **hash SHA-256** vai para `sessions`. Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/` (prefixo `__Host-` em produção).
- Expiração deslizante (ex.: 7 dias de inatividade) + teto absoluto (ex.: 30 dias); `last_seen_at` atualizado no máximo 1×/hora.
- **`credentials_version`:** inteiro em `users`, incrementado **somente** na troca/redefinição de senha, na mesma transação que grava o novo hash (3.4). A sessão grava, ao ser criada, a versão que o login leu.
- **Validação de sessão a cada requisição (obrigatória).** O servidor localiza a sessão pelo hash do token e, **na mesma consulta**, junta o usuário. A sessão só é válida se **todas** as condições forem verdadeiras:
  1. `sessions.revoked_at IS NULL`;
  2. expiração deslizante e teto absoluto não vencidos;
  3. **`sessions.credentials_version = users.credentials_version`** — a versão registrada na sessão tem de ser igual à versão **atual** do usuário.

  Qualquer falha ⇒ `401` e o cookie é limpo. **Não existe cache de sessão validada entre requisições** (um cache deixaria a versão obsoleta); requisições já em andamento quando a senha muda terminam normalmente.
- **Login com leitura única.** O login lê `password_hash` **e** `credentials_version` na **mesma consulta/linha**, verifica a senha contra aquele hash e cria a sessão com a versão lida nessa mesma leitura. Ler hash e versão em consultas separadas poderia parear hash antigo com versão nova e criar uma sessão válida para a senha antiga.
- Novo token a cada login; "sair de todos os dispositivos" revoga as sessões do usuário (3.4 e 6.5 descrevem a ordem de locks).
- **CSRF:** `SameSite=Lax` + verificação de `Origin` em métodos não-GET + exigir `Content-Type: application/json`.
- **Brute force:** rate limit por IP **e** por e-mail; resposta idêntica para usuário inexistente e senha errada. Armazenamento em memória no MVP (instância única); reinicia com o processo e não serve a múltiplas instâncias — limitação aceita e documentada.
- Sem login social, 2FA ou magic link no MVP.

### 3.2 Papéis e permissões (R1 ajustada por C1)

- **No MVP, `OWNER` é o único papel operacional.** Quem cria a empresa vira `OWNER` e é o único com login nela. Um usuário pode ser `OWNER` de várias empresas (D1). Profissionais são cadastros sem conta; clientes finais não têm conta (D3).
- **`ADMIN`, convites e gerenciamento de membros são evolução futura** (seção 12). Não existe seed, endpoint, tela, teste nem ramo de código para `ADMIN` no MVP, e nenhum fluxo artificial é criado para simulá-lo.
- Autorização por `can(role, action)`, **negando por padrão**. Usuário sem membership na empresa recebe `404` no recurso.
- **Preservação da evolução para `ADMIN`:**
  - `memberships.role` guarda o papel e, no MVP, seu único valor válido é `OWNER` (enum nativo do PostgreSQL ou texto com `CHECK` — o mecanismo que facilitar a extensão será escolhido no spike da etapa 3, **[VALIDAR V16]**).
  - `can()` recebe o papel como parâmetro e a matriz é um dado indexado por papel, não condicionais espalhadas.
  - Adicionar `ADMIN` depois = novo valor do papel (migration), nova coluna na matriz e sua suíte de testes. Não exige mudar rotas, o modelo de tenant nem o formato da sessão.

**Matriz do MVP**

| Ação (chave em `can`) | `OWNER` |
|---|:-:|
| Conta própria: ver/encerrar sessões, sair de todos os dispositivos (`account.*`) | ✔ |
| Ver dados e configurações da empresa (`org.view`) | ✔ |
| Alterar nome, slug e limites da página pública (`org.settings.update`) | ✔ |
| Publicar / despublicar a página pública (`org.public_page.publish`) — exige e-mail verificado | ✔ |
| Serviços: criar, editar, ativar/desativar (`services.*`) | ✔ |
| Profissionais e vínculos com serviços (`professionals.*`) | ✔ |
| Disponibilidade: `WorkingHours` e `TimeOff` (`availability.*`) | ✔ |
| Clientes: ver, criar, editar (`customers.read/write`) | ✔ |
| Clientes: exportar / anonimizar dados (`customers.privacy`) | ✔ |
| Agendamentos: criar, remarcar, cancelar, confirmar, mudar status (`appointments.*`) | ✔ |
| Trocar a empresa ativa da sessão entre empresas onde é `OWNER` (`session.switch_org`) | ✔ |

O `timezone` da empresa não é uma ação: é imutável para todos (R9). Ações de gerenciar membros e encerrar a empresa **não existem** no MVP.

**Proposta para a evolução futura (NÃO implementada e NÃO é critério de aceite do MVP).** Quando `ADMIN` for autorizado, a proposta da revisão 3 permanece como ponto de partida: `ADMIN` opera serviços, profissionais, disponibilidade, clientes e agendamentos; não altera nome/slug/limites da página pública, não publica a página, não gerencia membros, não encerra a empresa e (proposta) não exporta/anonimiza clientes. Essa matriz deverá ser revalidada com o produto naquele momento.

**Testes do MVP (especificação):** (1) todas as ações definidas são permitidas ao `OWNER` da empresa ativa; (2) `can()` nega um papel desconhecido e a ausência de papel (teste de *default deny*); (3) usuário sem membership na empresa ⇒ `404`; (4) a suíte A×B de 4.4 usa apenas `OWNER`s de duas empresas diferentes.

### 3.3 Verificação de e-mail (R10)

- Tabela `auth_tokens` com `type = EMAIL_VERIFICATION | PASSWORD_RESET`, `user_id`, `token_hash`, `expires_at`, `used_at`.
- Fluxo: registro → e-mail (via outbox, 3.6) → `POST /api/auth/verify-email` com o token no corpo → `email_verified_at`.
- **Regra de produto (R10):** o e-mail precisa estar verificado **antes de criar uma empresa e antes de publicar a página pública**. Usuário não verificado pode fazer login e ver a tela de aviso, nada mais. A verificação é feita no servidor em ambas as operações (criar empresa e `org.public_page.publish`); a publicação revalida `email_verified_at` do usuário que publica.
- **Registro sem enumeração:** `POST /api/auth/register` responde sempre a mesma mensagem. Se o e-mail já existe, o e-mail enfileirado avisa que já há conta (com link para login/recuperação) em vez de criar outra.
- Consumo do token de verificação é atômico e de uso único, no padrão de 3.4 e na ordem de locks do domínio de autenticação: leitura sem lock do token → trava `users` → `UPDATE auth_tokens SET used_at = now() WHERE … AND used_at IS NULL AND expires_at > now() RETURNING` → `UPDATE users SET email_verified_at`. Zero linhas ⇒ erro genérico. Verificação repetida com o usuário já verificado responde de forma genérica, sem vazar informação.
- Reenvio: rate limit por usuário e por IP.
- **Troca de e-mail da conta está fora do MVP** (R8): o e-mail de login não pode ser alterado; sem endpoint nem tela.

### 3.4 Recuperação de senha — transacional e segura contra concorrência (ajuste B)

**Ordem de locks do domínio de autenticação** (detalhada em 6.5): `users` → `auth_tokens` → `sessions` → `email_outbox`. Toda operação que altera tokens ou sessões de um usuário trava primeiro a linha desse usuário.

**Solicitação** — `POST /api/auth/forgot-password { email }`:

1. Sempre responde `202` com a mesma mensagem ("se o e-mail estiver cadastrado, enviaremos instruções"), mesmo corpo e mesmos cabeçalhos.
2. Se o usuário existe, em **uma transação**: trava `users` (`FOR NO KEY UPDATE`), invalida os tokens `PASSWORD_RESET` pendentes (`used_at = now()`), cria o novo (32 bytes CSPRNG, base64url; **só o hash SHA-256 é guardado**; expira em 30–60 min, valor a fixar na etapa 5) e **insere a mensagem na `email_outbox`**. Commit ⇒ token e mensagem existem juntos; rollback ⇒ nenhum dos dois.
3. O envio é feito pelo laço da outbox (3.6), nunca dentro da requisição.
4. Rate limit por IP e por e-mail normalizado. *Risco residual:* a resposta é idêntica, mas o caminho "usuário existe" faz mais escritas que o "não existe", então pode haver diferença sutil de tempo; mitigações: rate limit e, se necessário, trabalho equivalente fictício (risco 8).

**Redefinição** — `POST /api/auth/reset-password { token, newPassword }`. O hash argon2id da nova senha é calculado **antes** da transação (operação lenta, não pode segurar locks). Depois, **tudo numa única transação `READ COMMITTED`**, nesta ordem:

0. Leitura **sem lock** do token pelo hash para descobrir o `user_id`. Inexistente ⇒ erro genérico `TOKEN_INVALID_OR_EXPIRED`.
1. `SELECT id FROM users WHERE id = $u FOR NO KEY UPDATE` — serializa com qualquer outra operação de credencial do mesmo usuário (outra redefinição, novo `forgot-password`, verificação de e-mail, sair de todos os dispositivos).
2. `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $h AND type = 'PASSWORD_RESET' AND used_at IS NULL AND expires_at > now() RETURNING user_id`. Zero linhas (expirado, já usado, inexistente) ⇒ rollback e o mesmo erro genérico. Uma segunda requisição com o mesmo token espera o lock do passo 1, depois reavalia o `WHERE`, vê `used_at` preenchido e obtém zero linhas.
3. `UPDATE users SET password_hash = $novo, credentials_version = credentials_version + 1`.
4. Invalida os demais tokens `PASSWORD_RESET` pendentes do usuário.
5. Revoga as sessões existentes do usuário (`revoked_at = now()`).
6. Insere na `email_outbox` o aviso "sua senha foi alterada".
7. `COMMIT`. Qualquer falha entre 0 e 6 faz `ROLLBACK` completo: o token **continua utilizável** (nada mudou), a senha e as sessões ficam intactas e nenhuma linha vai para a outbox.

Demais regras: o token trafega no **corpo** de um `POST` (nunca em query string de API); o link do e-mail usa o fragmento da URL (`/redefinir-senha#token=…`) com `Referrer-Policy: no-referrer`; logs redigem o campo.

**Interação entre `credentials_version`, revogação transacional e logins concorrentes.** A revogação do passo 5 só alcança sessões que **já existem e estão visíveis** para aquele comando (`READ COMMITTED`). Um login concorrente pode criar uma sessão que ela não vê. Quem fecha essa janela é a **validação de versão a cada requisição** (3.1), não a revogação. Cenários:

| Cenário | Resultado esperado |
|---|---|
| Login leu o usuário (hash antigo, versão V) antes do commit da redefinição e cria a sessão depois do commit | A sessão carrega V, o usuário agora tem V+1 ⇒ **401** na primeira requisição. |
| Login cria a sessão (versão V) enquanto a redefinição está em andamento, e a sessão ainda não é visível ao passo 5 | Idem: a sessão commita com V ⇒ inválida pela versão após o commit da redefinição. |
| Login cria a sessão (versão V) e ela já é visível ao passo 5 | Revogada pelo passo 5 e também inválida pela versão. |
| Login lê o usuário depois do commit | Verifica a senha contra o **novo** hash: a senha antiga falha; a nova gera sessão com V+1, válida. |
| Redefinição sofre rollback | A versão **não** muda, o passo 5 também some: as sessões anteriores continuam válidas, de forma coerente. |
| Requisição autenticada antes do commit ainda em execução | Termina normalmente; a próxima já vê a nova versão. |

O login lê hash e versão numa **única** consulta (3.1); do contrário, hash antigo + versão nova produziria sessão válida para a senha antiga. A inserção da sessão exige uma checagem de chave estrangeira (`FOR KEY SHARE`) em `users`; o lock do passo 1 usa `FOR NO KEY UPDATE`, que **não** conflita com ela, de modo que o login não fica bloqueado — e justamente por isso a validação de versão é necessária (**[VALIDAR V15]**: confirmar o comportamento dos modos de lock).

**Testes e critérios de aceite (especificação, nada executado):**

- **S1.** Duas redefinições simultâneas com o mesmo token e senhas diferentes ⇒ exatamente uma sucede; a senha final é a da vencedora; a outra recebe `TOKEN_INVALID_OR_EXPIRED`.
- **S2.** Falha injetada após o consumo do token (ex.: erro forçado no passo 3 ou 5) ⇒ rollback total: token ainda `used_at IS NULL`, senha, versão e sessões intactas, nenhuma linha na outbox.
- **S3.** Login concorrente com a redefinição, usando barreira para reproduzir cada linha da tabela acima ⇒ nenhuma sessão baseada na senha antiga é aceita após o commit.
- **S4.** Pedir novo token invalida os anteriores; token expirado, usado e inexistente produzem a mesma resposta.
- **S5.** Após a redefinição nenhuma sessão anterior é válida e existe exatamente um aviso na outbox.
- **S6.** O banco guarda só o hash do token (exceto o payload cifrado da outbox, 3.6).
- **S7.** `forgot-password` com e-mail cadastrado e não cadastrado ⇒ mesma resposta (status, corpo, cabeçalhos).
- **S8.** Validação de versão: sessão com `credentials_version` diferente do usuário, mesmo com `revoked_at IS NULL` e não expirada ⇒ `401`; alterar a versão no banco entre duas requisições faz a segunda falhar (prova que não há cache).
- **S9.** O login lê hash e versão na mesma consulta (verificado pelo log de queries) e, com barreira entre a leitura e a criação da sessão, uma redefinição que confirma nesse intervalo invalida a sessão criada.
- **S10.** Concorrência no domínio de autenticação — redefinição × `forgot-password`, × sair de todos os dispositivos, × verificação de e-mail, × manutenção (`SKIP LOCKED`), repetidas com inícios aleatórios ⇒ sem `40P01` e com resultado consistente (evidência estatística, não prova; ver 6.5).

### 3.5 Provedor de e-mail

Escolhido **na etapa de implementação** (D4). O código depende só da interface `EmailSender { send({ to, subject, text, html }) }`; dev/testes usam implementação de console/captura. **[VALIDAR V10]** limites do plano, SPF/DKIM/DMARC e entregabilidade antes do deploy.

### 3.6 Envio de e-mail: outbox persistente (ajuste A)

O envio **não** depende de trabalho em memória executado depois da resposta HTTP. Especificação (sem implementar ainda):

**Tabela `email_outbox`:** `id`, `to_email`, `template` (`VERIFY_EMAIL`, `RESET_PASSWORD`, `PASSWORD_CHANGED`, `ACCOUNT_EXISTS`…), `payload_encrypted` (bytea, com o `key_id` usado), `status` (`PENDING` | `SENDING` | `SENT` | `DEAD`), `dead_reason` (`MAX_ATTEMPTS` | `EXPIRED` | `PERMANENT_ERROR` | `KEY_UNAVAILABLE` | `DECRYPT_FAILED`), `attempts`, `next_attempt_at`, `locked_until`, `lock_token` (identifica a tentativa em curso), `not_after`, `last_error` (texto sanitizado, sem token), `created_at`, `sent_at`.

**Garantia de entrega: *at-least-once*.** Cada mensagem é entregue ao provedor **uma ou mais vezes**; **e-mails duplicados são possíveis e esperados em certas falhas**. Não há *exactly-once*. Os templates toleram duplicata: os links são de uso único, um segundo clique em um link já usado produz resposta genérica sem vazar informação, e o aviso `PASSWORD_CHANGED` repetido é inofensivo.

**Regras:**

1. **Enfileirar na mesma transação** que cria o token/usuário (outbox transacional). A requisição HTTP nunca chama o provedor.
2. **Reivindicação (claim):** o laço seleciona lotes `status = 'PENDING' AND next_attempt_at <= now()` — ou `SENDING` com `locked_until < now()` — com `FOR NO KEY UPDATE SKIP LOCKED`, marca `SENDING`, grava `locked_until = now() + lease` e um novo `lock_token`, e só então chama o provedor, **fora de transação**.
3. **Timeout da chamada ao provedor bem menor que o lease** (valores iniciais a fixar na etapa 5), para reduzir a chance de um envio ainda em curso quando o lease vencer.
4. **Atualização final condicionada ao `lock_token`:** `UPDATE … WHERE id = $id AND lock_token = $meu`. Um processo atrasado, cujo lease já foi reivindicado por outro, não sobrescreve o estado da tentativa nova.
5. **Retry:** falha transitória ⇒ `attempts + 1`, `next_attempt_at` com backoff exponencial e *jitter*, até o máximo de tentativas; a linha volta a `PENDING`.
6. **`not_after`:** verificado antes de **cada** tentativa. Vencido ⇒ `DEAD (EXPIRED)` sem chamar o provedor.
7. **Payload:** contém o token em claro necessário ao e-mail, portanto é **cifrado** (algoritmo autenticado; AES-256-GCM via módulo nativo do Node é a proposta, **[VALIDAR V14]**) e **apagado (`NULL`) ao passar para `SENT` ou `DEAD`**. Linhas finalizadas são removidas após N dias.
8. **Manutenção no mesmo laço:** idempotência expirada (6.4), sessões e `auth_tokens` expirados, linhas antigas da outbox — sempre em lotes pequenos com `SKIP LOCKED` (nunca esperam lock).

**Comportamento esperado por cenário de falha:**

| Cenário | Comportamento |
|---|---|
| Falha transitória do provedor (timeout, 5xx, rede) | `attempts + 1`, volta a `PENDING` com backoff; ao estourar o máximo ⇒ `DEAD (MAX_ATTEMPTS)`. |
| Falha permanente (ex.: destinatário rejeitado definitivamente, se o provedor classificar assim — **[VALIDAR V10]**) | `DEAD (PERMANENT_ERROR)` sem novas tentativas. |
| **Lease expirado** com o envio ainda em curso (provedor lento, processo travado) | Outro ciclo pode reivindicar e enviar de novo ⇒ **duplicata possível**. O processo atrasado não consegue sobrescrever o estado (regra 4). Duplicata é aceita. |
| **Processo reiniciado/morto** durante `SENDING` | A linha permanece `SENDING` até o lease vencer e então volta a ser elegível; o atraso máximo é aproximadamente o lease. Se o envio já ocorrera, haverá duplicata. |
| Processo morre depois do envio e antes de marcar `SENT` | Igual ao anterior: reenvio ⇒ duplicata. |
| **`DEAD`** | Estado terminal: `payload_encrypted = NULL`, erro registrado em log e contado para alerta. **Sem reenvio automático nem manual** (o payload já não existe). O usuário refaz a ação (reenviar verificação, `forgot-password`), o que cria nova mensagem e novo token. |
| **`not_after` vencido** | `DEAD (EXPIRED)` sem chamar o provedor, mesmo que nunca tenha sido tentada. |
| Provedor totalmente fora do ar | A API continua respondendo normalmente; as mensagens acumulam como `PENDING` e seguem o retry até `not_after`/máximo de tentativas. |

**Chave de cifragem do payload.**

- Fica **fora do banco**: variável de ambiente (ou segredo do host) `OUTBOX_ENCRYPTION_KEYS`, mapeando `key_id → chave`, com uma marcada como corrente. **Nunca** no banco, no repositório, nos logs nem no mesmo backup do banco.
- Cada payload registra o `key_id` com que foi cifrado.
- **Comportamento definido para perda ou indisponibilidade:**
  - Chave corrente ausente ou malformada na subida ⇒ a validação de ambiente falha e a API **não inicia** (em dev/teste usa-se uma chave fixa de teste).
  - Linha cifrada com `key_id` que deixou de existir (chave removida, perdida, ou backup restaurado em outro ambiente) ⇒ `DEAD (KEY_UNAVAILABLE)` **sem chamar o provedor**, erro logado e contado para alerta; sem crash e sem retry infinito.
  - Falha de autenticação do payload (chave errada ou dado corrompido) ⇒ `DEAD (DECRYPT_FAILED)`, mesmo tratamento.
  - **Perda total da chave:** perdem-se somente as mensagens ainda pendentes (vida curta: tokens expiram em ≤ ~1 h); os usuários refazem a solicitação. Senhas, sessões e tokens (todos em hash) **não** dependem dessa chave.
  - **Rotação:** uma nova chave vira corrente; as antigas permanecem configuradas até não restar linha com aquele `key_id` (maior `not_after` + retenção). Removê-las antes torna as linhas remanescentes `KEY_UNAVAILABLE`.

**Critérios de aceite (especificação, nada executado):**

- **O1.** Provedor falso que falha N vezes e depois sucede ⇒ N retentativas com `next_attempt_at` crescente; termina `SENT`.
- **O2.** Provedor sempre falhando ⇒ após o máximo de tentativas, `DEAD (MAX_ATTEMPTS)`, sem laço infinito e sem token em `last_error`.
- **O3.** Lease vencido simulado ⇒ a linha é reenviada por outro ciclo; o teste **registra e aceita a duplicata** e verifica que o processo atrasado não sobrescreve o estado (`lock_token`).
- **O4.** Dois laços concorrentes ⇒ nenhuma linha é processada simultaneamente pelos dois (`SKIP LOCKED` + lease).
- **O5.** Rollback do registro/`forgot-password` ⇒ **nenhuma** linha na outbox; commit ⇒ exatamente uma.
- **O6.** API responde normalmente com o provedor totalmente fora do ar.
- **O7.** `not_after` vencido ⇒ `DEAD (EXPIRED)` sem chamar o provedor.
- **O8.** Após `SENT`/`DEAD`, `payload_encrypted` é `NULL`.
- **O9.** Reinício do processo (parar o laço no meio de `SENDING`) ⇒ nenhuma mensagem perdida; duplicata apenas no limite documentado.
- **O10.** Chave corrente ausente na subida ⇒ a API não inicia.
- **O11.** `key_id` desconhecido ⇒ `DEAD (KEY_UNAVAILABLE)`, provedor não chamado, laço continua processando as demais linhas.
- **O12.** Chave errada para um `key_id` conhecido ⇒ `DEAD (DECRYPT_FAILED)`.
- **O13.** Rotação: linha cifrada com a chave antiga ainda é decifrada enquanto a chave antiga estiver configurada.
- **O14.** Restaurar um dump do banco sem a chave ⇒ as linhas pendentes viram `DEAD`, nada quebra, nenhum token vaza em log.
- **O15.** Logs e `last_error` nunca contêm payload, token ou chave.

---

## 4. Estratégia multi-tenant

**Modelo:** um banco, um schema, `organization_id` em toda tabela de negócio.

> `organizationId` **nunca** é lido de body, query ou header para *conceder* acesso. Ele é derivado no servidor a partir da sessão e da membership.

### 4.1 Rotas autenticadas (painel)

- `sessions.active_organization_id` define a empresa ativa. É definida/alterada por `POST /api/session/active-organization`, que **valida a membership** do destino.
- A cada requisição, o `tenantPlugin` carrega sessão → confirma que a membership ainda existe (e o papel atual) → define `request.tenant = { organizationId, userId, role }`. Sem membership válida: 403 e a sessão perde a empresa ativa.
- Rotas do painel **não** têm `organizationId` em path/body. Schemas Zod `.strict()` rejeitam o campo se enviado.
- **Várias empresas × várias abas:** a empresa ativa é da *sessão*; trocar na aba B afeta a aba A. Mitigação: o frontend envia `X-Active-Org: <slug exibido>` como **asserção de consistência**; se divergir da empresa ativa da sessão, o servidor responde `409 ACTIVE_ORG_CHANGED` sem executar nada. O header nunca concede acesso. Teste dedicado (etapa 6).

### 4.2 Rotas públicas

- A empresa é identificada pelo `slug` em `/api/public/:slug/...`. É *identificação*, não autorização: o servidor resolve slug → `organization_id` **somente se a empresa estiver publicada** (`published_at IS NOT NULL`, que exige o e-mail do proprietário verificado — R10) e expõe apenas o necessário (serviços e profissionais ativos, slots, criar agendamento).
- Nunca expor lista de clientes ou agendamentos. A criação devolve só um resumo mínimo.

### 4.3 O que o Prisma realmente permite (ajuste E)

Todas as linhas abaixo são **riscos a comprovar** num spike da etapa 3 com a versão exata escolhida; nenhuma é presumida como funcionando.

| Tema | Limitação / risco | Postura |
|---|---|---|
| **FK composta** `(organization_id, X_id) → X(organization_id, id)` | Exige `@@unique([organizationId, id])` no pai. Possíveis problemas: campo compartilhado entre várias relações do mesmo modelo; relações **opcionais** compostas com `onDelete: SetNull` tentariam anular `organization_id` (NOT NULL); `MATCH SIMPLE` do PostgreSQL ignora a verificação se **qualquer** coluna da FK for NULL. | Usar `Restrict`/`NoAction`; evitar relações opcionais compostas. **`onDelete: SetNull` é proibido em qualquer FK composta que inclua `organization_id`** (o Prisma apenas avisa e gera `ON DELETE SET NULL` sobre todas as colunas da FK). **`onUpdate: Restrict` é obrigatório** nessas relações, porque o Prisma emite `ON UPDATE CASCADE` por padrão. Se o Prisma não modelar alguma, a FK vai em SQL manual e o schema usa campos simples — **o teste de banco é a prova**, não o schema. (V3) |
| **Constraints não modeladas** | `EXCLUDE`, `CHECK`, índices parciais, triggers: SQL manual em migrations; risco de *drift*. | Etapa 3: rodar `prisma migrate diff`/`migrate dev` e confirmar que não há drift nem tentativa de remover a constraint; teste de integração falha se ela não existir. (V4) |
| **Erros de banco** | `23P01` (exclusão), `40P01` (deadlock) e `55P03` (`lock_timeout`) podem chegar como erro genérico, não como `P20xx`. | Spike: provocar cada um via ORM e via raw; fixar um *mapeador de erros* testado que lê o SQLSTATE. **Verificado no Prisma 7 com driver adapter `pg`:** o SQLSTATE está em `error.meta.driverAdapterError.cause.originalCode`, tanto em operações do ORM (`P2039`, `P2002`…) quanto em `$queryRaw`/`$executeRaw` (`P2010`). Uma FK com `ON DELETE RESTRICT` retorna SQLSTATE **`23001`** (`restrict_violation`), não `23503`; o mapeador trata ambos como violação de FK e usa `P2002`/`P2003` como reserva. (V6, V15) |
| **`SELECT … FOR NO KEY UPDATE`** | O Prisma Client não expõe lock de linha nativamente. | Usar `$queryRaw` dentro de transação interativa (arquivo na allowlist de raw SQL, `lib/db/locks/`). Confirmar também timeout padrão de transação interativa e configuração de isolamento. (V15) |
| **Client extensions (`forTenant`)** | Atuam em operações **de topo**. Não cobrem `$queryRaw/$executeRaw`, filtros/`include`/`select` aninhados, nem escritas aninhadas (`connect`, `create`) que referenciem registros de outro tenant; semântica de `findUnique`/`upsert`/`createMany`/`updateMany` depende da versão. | O helper é **redução de risco**, não garantia (4.4). (V7) |
| **Transações interativas** | Precisam usar o cliente já escopado; usar o cliente global dentro delas perde o escopo e o lock. | `forTenant(ctx).$transaction(fn)` entrega `tx` escopado; cliente global proibido em módulos de negócio. |

### 4.4 `forTenant()` — como se detecta consulta sem escopo

`db.forTenant(ctx)` aplica `organizationId` nas operações de topo dos modelos tenant-scoped. **Isso não garante isolamento por si só.** O isolamento é a soma de helper + FKs compostas + proibições estáticas + testes que *detectam* violações. Verificações obrigatórias, bloqueantes no CI:

1. **Inventário via DMMF do Prisma:** todo modelo ou tem `organizationId` ou consta numa allowlist explícita de globais (`User`, `Session`, `Organization`, `AuthToken`, `EmailOutbox`…). Modelo novo não classificado falha o teste.
2. **Matriz de operações do helper (gerada do DMMF):** modelo tenant-scoped × operação (`findMany/findFirst/findUnique/count/aggregate/groupBy/update/updateMany/upsert/delete/deleteMany/create/createMany`) ⇒ o `where`/`data` realmente enviado contém o `organizationId` do contexto e um valor divergente passado pelo chamador é rejeitado. Operação fora da lista suportada **lança erro** (lista fechada).
3. **Regras estáticas:** proibido importar `@prisma/client`/instanciar `PrismaClient` fora de `lib/db`; proibido `$queryRawUnsafe`/`$executeRawUnsafe`; `$queryRaw/$executeRaw` só em arquivos de uma allowlist revisada (cada um com `organization_id` na consulta, ou documentado como global); cliente `unscoped` só em `auth/` e na resolução de slug.
4. **Registro de rotas × testes de isolamento:** o teste enumera as rotas do Fastify (`onRoute`) e falha se alguma não estiver classificada como (a) tenant-scoped com teste A×B, (b) pública, ou (c) não-tenant (`/health`, auth).
5. **Suíte A×B de caixa-preta:** duas empresas com todos os tipos de recurso; para cada rota tenant-scoped, o usuário de A tenta ler/alterar/apagar/vincular recurso de B ⇒ **404** e nenhum dado de B alterado; `organizationId` no body ⇒ 400; referenciar por ID serviço/profissional de B ao criar agendamento em A ⇒ 404/422.
6. **Sentinela de SQL:** durante a suíte A×B captura-se o log de queries; todo SQL em tabela tenant-scoped sem `organization_id` e fora de allowlist falha o teste (heurístico, por texto).
7. **Testes de banco com SQL cru:** inserir/atualizar filho apontando para pai de outro tenant ⇒ falha por FK composta.
8. **Revisão humana obrigatória** em PR que adicione raw SQL, uso de `unscoped` ou escrita aninhada com relação.

Row-Level Security fica fora do MVP (seção 12).

---

## 5. Modelo inicial de entidades

PKs `uuid` (v7); `created_at`/`updated_at` em tudo; `snake_case` via `@@map`; `organization_id NOT NULL` nas tabelas de negócio; todo pai de FK composta tem `UNIQUE (organization_id, id)`.

```
User ──< Membership >── Organization
User ──< Session ; User ──< AuthToken
Organization ──< Service, Professional, Customer
Professional >──< Service         (ProfessionalService)
Professional ──< WorkingHours, TimeOff
Appointment >── Professional, Service, Customer
IdempotencyRecord ──> Appointment (resultado)
EmailOutbox  (global; não pertence a uma empresa)
```

| Entidade | Campos principais | Observações |
|---|---|---|
| **User** | id, email (único, minúsculo), password_hash, name, email_verified_at, **credentials_version** | Global. O e-mail não muda no MVP (R8). |
| **Session** | id, user_id, token_hash (único), active_organization_id?, credentials_version, expires_at, revoked_at?, last_seen_at, ip, user_agent | Token em claro nunca armazenado. |
| **AuthToken** | id, user_id, type, token_hash (único), expires_at, used_at | Seção 3. |
| **EmailOutbox** | id, to_email, template, payload_encrypted (com key_id), status, dead_reason, attempts, next_attempt_at, locked_until, lock_token, not_after, last_error, created_at, sent_at | Seção 3.6. Entrega *at-least-once*. |
| **Organization** | id, name, slug (único), **timezone (imutável)**, status (enum `OrganizationStatus`, valor inicial `{ ACTIVE }`, extensível por migrations futuras), **published_at?**, **public_min_notice_minutes (120)**, **public_max_advance_days (60)**, **public_max_active_bookings_per_phone (3)** | Valores entre parênteses são *configurações iniciais sujeitas à validação com usuários reais* (R6, 6.7). Editáveis só por `OWNER`. `slug` com lista de reservados. |
| **Membership** | id, user_id, organization_id, role | `role` aceita somente `OWNER` no MVP (mecanismo extensível a decidir no spike, V16); `UNIQUE(user_id, organization_id)`. Exatamente 1 `OWNER` por empresa criada; **sem fluxo para adicionar ou remover membros no MVP** (evolução futura). |
| **Service** | id, organization_id, name, duration_minutes, **buffer_minutes (default 0)**, price_cents?, active | Duração livre (inteiro ≥ 1), independente da grade de 15 min. |
| **Professional** | id, organization_id, name, active | Sem `user_id` (D2). |
| **ProfessionalService** | organization_id, professional_id, service_id | FKs compostas para ambos. |
| **WorkingHours** | id, organization_id, professional_id, weekday (0–6), start_time, end_time | Hora **local** da empresa; vários intervalos por dia, sem sobreposição entre si; múltiplos de 15 min. |
| **TimeOff** | id, organization_id, professional_id, starts_at, ends_at, reason | `CHECK (ends_at > starts_at)`. |
| **Customer** | id, organization_id, name, phone_e164, email?, notes? | `UNIQUE(organization_id, phone_e164)`. Dado pessoal (LGPD). Criação pela página pública **não sobrescreve** dados de cliente existente. Sem campos de nicho (D13). |
| **Appointment** | id, organization_id, professional_id, service_id, customer_id, **starts_at, ends_at, blocked_until**, status, `service_name_snapshot`, `duration_minutes_snapshot`, `buffer_minutes_snapshot`, `price_cents_snapshot`, source (`PANEL`/`PUBLIC`), created_by_user_id?, cancelled_at?, cancel_reason?, version | `ends_at = starts_at + duração`; `blocked_until = ends_at + buffer` (6.1 e 6.3). Remarcar mantém os snapshots originais. |
| **IdempotencyRecord** | id, organization_id, key, scope, request_hash, appointment_id?, response_status, response_body, created_at, expires_at (= created_at + 24 h) | Seção 6.4. `UNIQUE (organization_id, scope, key)`. |

`status`: `SCHEDULED`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`. **Ativos (bloqueiam horário): `SCHEDULED` e `CONFIRMED`.** Transições numa função única e testada; cancelar nunca faz `DELETE`.

Fora do MVP (**não criar agora**): convites (`Invitation`), tabelas de WhatsApp, `AuditLog`, assinaturas/faturas.

---

## 6. Agendamentos: conflitos, buffer, idempotência e concorrência

O cálculo de slots na aplicação é **sugestão para a UI**. A garantia final vem do banco (6.1) e dos bloqueios (6.5).

### 6.1 Constraint de exclusão e coerência de `blocked_until`

SQL manual em migration (Prisma não a modela — 4.3):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- [VALIDAR V5] suporte a uuid

ALTER TABLE appointments
  ADD CONSTRAINT appointments_range_valid
  CHECK (ends_at > starts_at AND blocked_until >= ends_at);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    professional_id WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  ) WHERE (status IN ('SCHEDULED', 'CONFIRMED'));
```

- **Somente ativos bloqueiam.** `CANCELLED`, `NO_SHOW` e `COMPLETED` liberam a faixa. **Reativar** um cancelado reaplica a constraint e pode falhar com 409; reativar só é permitido se `starts_at` for futuro (R7).
- **Escopo consistente com as FKs compostas:** a FK `(organization_id, professional_id) → professionals(organization_id, id)` fixa a empresa do profissional; `organization_id WITH =` na exclusão é **redundante de propósito** e é provado por teste (o par inconsistente falha na FK, não na exclusão).
- **Intervalo `[)`**: encostados são permitidos. **Faixa = serviço + buffer.**
- Violação ⇒ SQLSTATE `23P01` ⇒ `409 SLOT_UNAVAILABLE` (mapeamento sujeito a V6).
- Alinhamento à grade de 15 min e segundos = 0 em `starts_at` são validados na aplicação (D5); `ends_at` pode cair fora da grade.

**Coerência entre `ends_at`, `buffer_minutes_snapshot` e `blocked_until` (ajuste D).** Os três campos precisam concordar com `starts_at`, `duration_minutes_snapshot` e `buffer_minutes_snapshot`, e a exclusão depende de `blocked_until`. Expressões `timestamptz + intervalo` não são `IMMUTABLE`, então não servem para coluna gerada nem para índice; isso precisa ser **comprovado** (V8). Opções, em ordem de preferência:

1. **Preferida (a confirmar):** cálculo **centralizado** numa única função da aplicação (`computeAppointmentRange(starts_at, duration, buffer)`, usada por criar e remarcar) **mais verificação no banco** de que `ends_at = starts_at + duration_minutes_snapshot` minutos e `blocked_until = ends_at + buffer_minutes_snapshot` minutos — via `CHECK` (se o spike mostrar que é aceito, estável em `pg_dump`/restore e sem fricção) ou via trigger `BEFORE INSERT OR UPDATE` que **rejeita** valores incoerentes. A aplicação continua dona do cálculo; o banco impede gravar incoerência.
2. **Alternativa:** trigger que **calcula e sobrescreve** `ends_at`/`blocked_until` (fonte única no banco). Só se o spike mostrar que o Prisma lida bem com colunas preenchidas por trigger.
3. **Último recurso:** só a função central na aplicação + `CHECK (blocked_until >= ends_at)` + testes. Menos seguro: SQL manual poderia gravar incoerência.

**Decisão aprovada (Etapa 3, V8): opção 1, com `CHECK`.** A aplicação continua dona do cálculo (`computeAppointmentRange`) e o banco rejeita valores incoerentes, na migration manual da Etapa 10:

```sql
ALTER TABLE appointments
  ADD CONSTRAINT appointments_range_coherent
  CHECK (
    ends_at = starts_at + make_interval(mins => duration_minutes_snapshot)
    AND blocked_until = ends_at + make_interval(mins => buffer_minutes_snapshot)
  );
```

Critérios avaliados no spike (evidência em [`STAGE-3-VALIDATIONS.md`](./STAGE-3-VALIDATIONS.md), V8): (a) funciona com `create`/`update` do Prisma sem contornos; (b) a exclusão usa `blocked_until` sem recursão de efeitos; (c) sobrevive a `pg_dump`/restore; (d) gravar via SQL cru um valor incoerente **falha** (`23514`). Consequências: `timestamptz + interval` não é `IMMUTABLE`, então coluna gerada e índice sobre a expressão não são possíveis, e `make_interval` (que é) é a forma exigida; todo `UPDATE` que mova um agendamento deve recalcular `starts_at`, `ends_at` e `blocked_until` juntos, pois uma atualização parcial é rejeitada. O trigger que sobrescreve valores (opção 2) não foi testado e permanece descartado.

**Testes obrigatórios da constraint** (Postgres real):

1. Dois ativos sobrepostos no mesmo profissional ⇒ `23P01`.
2. Encostados (`[)`) ⇒ ambos passam.
3. Mesmo horário, profissionais diferentes ⇒ passam.
4. Sobreposto a `CANCELLED`/`NO_SHOW`/`COMPLETED` ⇒ passa; cancelar o primeiro e criar o segundo ⇒ passa; reativar o primeiro depois ⇒ falha.
5. Sobreposição apenas dentro do buffer ⇒ falha; fora do buffer ⇒ passa.
6. `UPDATE` (remarcar) não conflita consigo mesmo; para cima de outro ativo ⇒ falha.
7. `(organization_id = A, professional_id = profissional da B)` via SQL cru ⇒ falha por **FK composta**.
8. N inserções concorrentes no mesmo slot, **com o lock N2 do profissional (6.5)** ⇒ 1 sucesso e N−1 conflitos `23P01` (HTTP 409 `SLOT_UNAVAILABLE`), sem `40P01`. **Sem** o lock, a constraint mantém a invariante (nunca há dois ativos), mas os perdedores podem receber `40P01` (deadlock resolvido após `deadlock_timeout`) em vez de `23P01`; o teste deve cobrir os dois cenários, e o lock é obrigatório no fluxo normal.
9. A constraint existe no banco migrado (`pg_constraint`) — protege contra drift.
10. Incoerência `ends_at`/`blocked_until`/snapshots via SQL cru ⇒ rejeitada pelo `CHECK` `appointments_range_coherent` (opção 1 aprovada em V8; SQLSTATE `23514`). O teste também cobre a ressalva documentada: uma atualização parcial (por exemplo, mudar só `starts_at` sem recalcular `ends_at` e `blocked_until`) é rejeitada.

### 6.2 Disponibilidade (cálculo de slots)

Para serviço `S` (duração `d`, buffer `b`), profissional `P`, dia local `D` na timezone da empresa, o início candidato `t` (múltiplo de 15 min no horário local) é válido se:

1. `P` executa `S` e ambos estão ativos;
2. `t` é **futuro** (nunca no passado, R7) e, na página pública, respeita antecedência mínima e máxima (6.7);
3. `[t, t+d)` cabe inteiro dentro de um intervalo de `WorkingHours` de `P`;
4. `[t, t+d)` não intersecta nenhum `TimeOff` de `P`;
5. `[t, t+d+b)` não intersecta a faixa `[starts_at, blocked_until)` de nenhum agendamento **ativo** de `P`.

Função pura `computeSlots(inputs, clock)`, com testes unitários extensos.

### 6.3 Buffer (R3)

- Configurado em `Service.buffer_minutes` (padrão 0). Semântica: tempo de preparação **depois** do atendimento, durante o qual o profissional fica indisponível para o *próximo* atendimento.
- **Duração histórica intocada:** `ends_at = starts_at + duration_minutes_snapshot`. O buffer só entra em `blocked_until = ends_at + buffer_minutes_snapshot`. Relatórios e a UI de duração usam `ends_at`; disponibilidade e constraint usam `blocked_until`.
- **Snapshots:** duração e buffer são copiados do serviço na criação. Editar o serviço não altera agendamentos existentes nem libera/ocupa horários retroativamente. Alterar o buffer afeta só agendamentos criados depois.
- **Simetria:** cada agendamento ocupa `[start, blocked_until)`; um novo *antes* de outro deixa o *seu* buffer livre antes do início do seguinte; um *depois* começa só após `blocked_until` do anterior.
- **Aprovado (R3):** **apenas o intervalo real do atendimento `[t, t+d)` precisa caber em `WorkingHours` e não intersectar `TimeOff`.** O buffer **pode ultrapassar o fim do expediente ou encostar numa folga**; ele só importa entre agendamentos do mesmo profissional.
- Consequência para a verificação de conflitos de 6.5: ao avaliar `TimeOff`/`WorkingHours` contra agendamentos existentes usa-se `[starts_at, ends_at)`, nunca `blocked_until`.

### 6.4 Idempotência (R5)

- **Cabeçalho** `Idempotency-Key` (UUID gerado pelo frontend ao abrir o formulário) obrigatório em `POST` que cria agendamento (painel e público). Validado como UUID.
- **Escopo:** `(organization_id, scope, key)`; `organization_id` vem do tenant/slug resolvido no servidor. Empresas diferentes podem usar a mesma chave sem interação.
- **`request_hash`:** SHA-256 do JSON **canônico** (chaves ordenadas) do corpo *já validado e normalizado* (telefone E.164, datas UTC) + método + rota (+ slug).
- **Algoritmo**, na transação do agendamento, depois dos locks de 6.5:
  1. `INSERT INTO idempotency_records (…, expires_at = now() + interval '24 hours') ON CONFLICT (organization_id, scope, key) DO UPDATE SET (reivindica de novo o registro) WHERE idempotency_records.expires_at <= now() RETURNING …`. Se algo foi inserido ou reivindicado ⇒ operação nova. *(Semântica sob concorrência: V13.)*
  2. Se nada voltou, existe registro **vigente**: compara `request_hash`.
     - **Igual ⇒** devolve a resposta original (mesmo status e corpo) com `Idempotent-Replay: true`, sem criar nada.
     - **Diferente ⇒ `409 Conflict`, código `IDEMPOTENCY_KEY_REUSED`**, mensagem genérica **sem nenhum dado do registro original**.
  3. Se inseriu/reivindicou: cria o agendamento e grava `appointment_id`, `response_status`, `response_body` (resumo mínimo) **no mesmo commit**.
- **Não há estado "em andamento" persistido.** O registro só se torna visível junto com o agendamento (mesmo commit). Uma requisição concorrente com a mesma chave espera o índice único (ou o lock do cliente/profissional) até o commit/rollback da primeira e então cai em 2. Por isso **a expiração não pode permitir duplicar uma operação em andamento**: a linha de uma transação aberta é recém-criada (`expires_at` a 24 h no futuro) e não é elegível a re-reivindicação nem a limpeza.
- **Expiração e limpeza seguras (24 h):**
  - A leitura trata registro com `expires_at <= now()` como inexistente (re-reivindicação atômica no passo 1), mesmo que a limpeza ainda não tenha rodado.
  - A limpeza periódica (laço de 3.6) remove apenas `expires_at < now() - margem` (ex.: 1 h), em **lotes pequenos** (`DELETE … WHERE id IN (SELECT … LIMIT n)`), sem tocar linhas vigentes nem de transações abertas.
  - Transações têm `statement_timeout`/`lock_timeout`/timeout de transação interativa bem abaixo de 24 h; nenhuma operação legítima dura o suficiente para ver sua própria chave expirar.
- **Só sucessos são registrados.** Falha (ex.: `SLOT_UNAVAILABLE`) faz rollback e não consome a chave; um retry reexecuta.
- **Após 24 h** a mesma chave é uma operação nova. Mesmo assim, repetir o mesmo pedido não duplica um agendamento ainda ativo: o horário já está ocupado e a constraint responde `409 SLOT_UNAVAILABLE`.
- **Sem vazamento entre empresas:** toda consulta usa o `organization_id` do servidor; chave existente só em outra empresa é invisível. Dentro da mesma empresa o replay exige hash idêntico (quem repete conhece o payload completo) e devolve o resumo mínimo; chaves são UUID aleatórios.
- **Testes:** (1) mesma chave + mesmo pedido ⇒ mesmo resultado, 1 agendamento; (2) mesma chave + payload diferente ⇒ `409 IDEMPOTENCY_KEY_REUSED` sem dados do original; (3) mesma chave em duas empresas ⇒ independentes; (4) duas requisições simultâneas com a mesma chave ⇒ 1 agendamento, ambas obtêm o mesmo resultado; (5) conflito de horário não consome a chave; (6) registro vencido ⇒ operação nova; (7) ordem de chaves diferente ⇒ mesmo hash; (8) **limpeza concorrente com criação em andamento** (barreira) ⇒ a linha da transação aberta não é removida e não há duplicata; (9) limpeza não remove registros vigentes nem os vencidos há menos que a margem.
- Não há unicidade por (cliente, horário) no banco: um telefone pode agendar legitimamente para várias pessoas. O abuso é limitado por 6.7 e pelo rate limit.

### 6.5 Concorrência: locks, hierarquia global e testes (ajustes C e R4)

**Problema.** A constraint de exclusão só compara linhas de `appointments` entre si. Ela **não** protege contra: criar um agendamento enquanto outra transação cria um `TimeOff` que o cobriria; reduzir/remover `WorkingHours` enquanto um agendamento é criado dentro do intervalo; desativar o profissional ou desvincular o serviço durante a criação; **nem** contra duas reservas públicas simultâneas do mesmo telefone ultrapassando o limite de 6.7 (profissionais diferentes ⇒ locks diferentes).

#### Regras gerais

- **Modo de lock:** `SELECT … FOR NO KEY UPDATE` via `$queryRaw` em `lib/db/locks/` (**[VALIDAR V15]**). É exclusivo entre operações que travam o mesmo recurso, mas **não** conflita com a checagem de chave estrangeira (`FOR KEY SHARE`) de linhas-filhas inseridas por outras transações.
- **R-a, ordem global:** todo lock explícito respeita a hierarquia abaixo; nunca se adquire um nível menor depois de um maior.
- **R-b:** nenhuma chamada externa nem I/O lento com locks retidos. Dentro da transação só se usa o `tx` escopado (nunca o cliente global — isso poderia esperar por uma conexão do pool segurando locks).
- **R-c, sem `DELETE` físico de entidades-pai** (`users`, `organizations`, `professionals`, `services`, `customers`) no MVP: desativa-se ou anonimiza-se. Um `DELETE` de pai conflita com as checagens de chave estrangeira dos filhos e criaria esperas fora da hierarquia.
- **R-d:** jobs de manutenção usam `SKIP LOCKED` e **nunca esperam** locks.
- **R-e:** leitura de slots não usa lock (é sugestão; 409 ao confirmar é esperado).

#### Hierarquia global (ordem em que os locks podem ser adquiridos)

Domínio de **agendamento**:

| Nível | Recurso | Regra |
|---|---|---|
| N1 | `customers` — a linha do cliente | No máximo uma por transação. |
| N2 | `professionals` — todos os envolvidos | Em ordem **crescente de `id`**, um `SELECT … FOR NO KEY UPDATE` por vez (não um único `ORDER BY … FOR NO KEY UPDATE`, cuja ordem de aquisição não é garantida), via `lockProfessionals(tx, ctx, ids[])`, que remove duplicatas e ordena. |
| N3 | `idempotency_records` — a linha/chave | No máximo uma por transação. |
| N4 | Escrita nas linhas-folha: `appointments`, `time_off`, `working_hours`, `professional_services` | Ao final; uma linha de `appointments` pode ser relida com lock (`version`). |

Domínio de **autenticação** (disjunto do anterior; nenhuma transação mistura os dois, salvo leituras sem lock):

| Nível | Recurso |
|---|---|
| A1 | `users` — a linha do usuário (uma por transação) |
| A2 | `auth_tokens` |
| A3 | `sessions` |
| A4 | `email_outbox` (somente `INSERT`) |

#### Recursos bloqueados por operação

| Operação | Locks, em ordem | Observações |
|---|---|---|
| Criar agendamento (painel) | N1 cliente → N2 profissional → N3 idempotência → N4 `INSERT appointments` | Cliente novo: `INSERT … ON CONFLICT DO NOTHING` + lock da linha. Serviço, `WorkingHours`, `TimeOff` e agendamentos são lidos **sem** lock (consistentes porque todo escritor desses dados trava N2). |
| Criar agendamento (público) | Igual ao anterior | A contagem de agendamentos ativos futuros do telefone (6.7) é feita **sob N1**. Configurações da empresa lidas sem lock. |
| Remarcar, mesmo profissional | Leitura sem lock do agendamento → N2 profissional → N4 relê o agendamento com lock e confere profissional e `version` | Se o profissional ou a versão mudaram entre a leitura e o lock ⇒ `409 STALE_VERSION`. Não trava cliente nem idempotência. |
| Remarcar para outro profissional | Leitura sem lock → N2 `{origem, destino}` ordenados → N4 relê e atualiza | Idem. |
| Reativar cancelado | Como remarcar | Revalida futuro, expediente, folga e conflito. |
| Cancelar / confirmar / `COMPLETED` / `NO_SHOW` | Somente N4 (linha do agendamento, por `version`) | Não trava profissional: não ocupa horário. Pode causar **falso positivo transitório** na checagem de `TimeOff`/`WorkingHours` (vê como ativo algo que outra transação acabou de cancelar), nunca falso negativo: só criar/remarcar/reativar tornam um agendamento ativo, e todos travam N2. |
| Criar/alterar/remover `TimeOff` | N2 profissional → N4 | Verifica agendamentos ativos e não terminados **sem** lock. |
| Criar/alterar/remover `WorkingHours` | N2 profissional → N4 | Idem. |
| Desativar profissional / alterar `ProfessionalService` | N2 profissional → N4 | Agendamentos já existentes permanecem. |
| Operação em lote com vários profissionais (fora do MVP; se vier) | N2 todos, ordenados | Mesma função. |
| Editar cliente | N1 | Troca de telefone: espera de índice único (folha). |
| Editar serviço / ativar-desativar | Linha do serviço apenas | **Não** serializa com agendamentos (snapshots). Aceito: um agendamento pode ser criado concorrentemente a uma desativação do serviço — benigno. |
| Editar configurações da empresa / publicar | Linha da empresa apenas | Publicar/despublicar durante uma reserva em andamento é benigno. |
| Registro | Inserção em `users` (índice único) → A4 | |
| Login | Leitura única de `users`; `INSERT sessions` | Sem lock de A1. |
| Verificar e-mail | Leitura sem lock do token → A1 → A2 (consome) → `UPDATE users` | |
| `forgot-password` (usuário existe) | A1 → A2 (invalida e insere) → A4 | |
| Redefinir senha (3.4) | A1 → A2 → A3 → A4 | |
| Sair de todos os dispositivos | A1 → A3 | |
| Logout simples, atualização de `last_seen_at`, trocar empresa ativa | A3, uma linha | |
| Alterar senha autenticado (se vier a existir) | A1 → A2 → A3 → A4 | Mesma ordem da redefinição. |
| Manutenção (idempotência, sessões, tokens, outbox) | Lotes `SKIP LOCKED` | Nunca esperam. |

Esperas em índices únicos (e-mail, slug, telefone do cliente na mesma empresa, chave de idempotência, hash de token) são **folhas**: quem espera já detém apenas locks de níveis menores ou iguais, e quem segura a folha não tem mais aquisições explícitas pela frente além de N4.

#### Guard de ordem em tempo de execução

`lib/db/locks` mantém no contexto da transação o maior nível adquirido e o último `id` de profissional. Tentar adquirir um nível menor, ou um profissional com `id` menor que o último, lança `LockOrderViolation`: o teste falha em dev/CI e, em produção, a operação é abortada **antes** de esperar o lock e registrada como erro. O guard valida a **conformidade com o modelo**; ele não enxerga locks internos do PostgreSQL.

#### O que se pode e o que não se pode afirmar

- **Argumento, não prova:** com uma ordem total para todos os locks explícitos e esperas apenas em folhas, não deveriam existir ciclos de espera. É um argumento de projeto.
- **Registrar a ordem das queries emitidas prova apenas a ordem *pretendida*, não a ausência de deadlocks.** Testes de concorrência encontram problemas por amostragem; não demonstram sua inexistência.
- Locks internos do PostgreSQL (checagem de FK, índices únicos, constraint de exclusão) ficam **fora** do modelo do guard e só são cobertos por revisão e testes de estresse.
- Deadlock (`40P01`) em produção é tratado como **erro de implementação**: `503 TEMPORARILY_BUSY` ao cliente, erro em log e alerta.

#### Estratégia dentro dos locks

1. Transação em **`READ COMMITTED`**: após obter os locks, as leituras seguintes veem tudo o que transações concorrentes anteriores confirmaram. Não usar `REPEATABLE READ`.
2. *Criar/mover agendamento:* `starts_at` no futuro (R7) e, se público, dentro dos limites de 6.7; profissional/serviço ativos e vinculados; `[start, end)` cabe em `WorkingHours`; não intersecta `TimeOff`; só então insere (a exclusão continua como rede de segurança).
3. *Criar/alterar `TimeOff`* (R4): se existir agendamento **ativo e não terminado** (`ends_at > now()`) cujo `[starts_at, ends_at)` intersecte o novo intervalo ⇒ **rejeita** com `409 TIMEOFF_CONFLICTS_WITH_APPOINTMENTS` e a **lista dos conflitos**. Nada é cancelado automaticamente.
4. *Alterar/remover `WorkingHours`* (R4): se algum agendamento ativo e não terminado deixaria de caber ⇒ `409 WORKING_HOURS_CONFLICT_WITH_APPOINTMENTS` com a lista. Também valida que os intervalos do mesmo dia não se sobrepõem. O buffer não entra nessas verificações (6.3).
5. **Timeouts:** `lock_timeout` curto (valor inicial a definir). Estourar ⇒ `503 TEMPORARILY_BUSY` com `Retry-After`; nada é gravado.
6. **Custo:** operações do mesmo profissional (ou do mesmo cliente) se enfileiram; as demais não se bloqueiam.
7. **Alternativa descartada no MVP:** tabela única de "ocupações" (agendamentos + folgas) sob a mesma exclusão — resolve `TimeOff`, não `WorkingHours`, e complica o modelo.
8. Trocar o `timezone` é proibido no MVP (R9), para não reinterpretar `WorkingHours` e agendamentos futuros.

#### Testes de concorrência (especificação, nada executado)

Postgres real, transações interativas e barreiras para entrelaçamento determinístico quando aplicável.

- **L1.** Agendamento × `TimeOff`: T1 trava o profissional e cria `TimeOff`; `createAppointment` no intervalo **não termina** antes do commit de T1 e depois falha com `PROFESSIONAL_UNAVAILABLE`. Inverso: T1 cria o agendamento e segura o commit; `createTimeOff` espera e então falha com a lista de conflitos.
- **L2.** Agendamento × `WorkingHours`: idem, removendo/reduzindo o expediente.
- **L3.** Profissionais diferentes **não** se bloqueiam (previne regressão para lock global).
- **L4.** Estresse com invariante: execução paralela aleatória de criar/cancelar agendamentos e criar/alterar `TimeOff`/`WorkingHours`; ao final, nenhum agendamento ativo e não terminado (a) intersecta `TimeOff`, (b) cai fora de `WorkingHours`, (c) sobrepõe outro ativo. Executado também com `deadlock_timeout` baixo e **zero** `40P01`.
- **L5.** Guard (unitário): adquirir N2 antes de N1, ou profissional B antes de A, lança `LockOrderViolation`; `lockProfessionals([B, A])` emite os locks na ordem A, B (evidência da ordem pretendida, **não** prova de ausência de deadlock).
- **L6.** Remarcações cruzadas simultâneas (T1 move de A para B; T2 de B para A), muitas repetições com início em ordem aleatória ⇒ sem `40P01` e sem violação do guard (amostragem).
- **L7.** Carga mista aleatória de **todas** as operações da tabela de 6.5 (agendamento, remarcar, cancelar, `TimeOff`, `WorkingHours`, editar cliente, idempotência) com `deadlock_timeout` baixo ⇒ zero `40P01` e zero `LockOrderViolation` (amostragem).
- **L8.** Estático e de pool: `FOR NO KEY UPDATE` só em `lib/db/locks`; nenhum uso do cliente global dentro de transação (teste com pool de tamanho mínimo que falharia por espera de conexão); nenhum `delete`/`deleteMany` nos modelos-pai (verificado a partir do DMMF).
- **L9.** Cobertura do lock: qualquer função de escrita de agendamento/`TimeOff`/`WorkingHours`/vínculos chamada sem passar por `lockProfessionals` falha o teste (instrumentação/spy).
- **L10.** Estouro de `lock_timeout` ⇒ `503 TEMPORARILY_BUSY` e nada gravado.
- **L11.** Rejeição de `TimeOff`/`WorkingHours` conflitantes devolve a lista completa e **não altera nenhum agendamento**.
- **L12.** Cancelar × remarcar o mesmo agendamento em paralelo ⇒ um vence, o outro recebe `STALE_VERSION` ou resultado coerente; a invariante de L4 vale. Cobre também o falso positivo transitório documentado (cancelamento × `TimeOff`).
- **L13.** Remarcar cuja leitura sem lock encontrou o profissional X, mas outra transação o moveu para Y antes do lock ⇒ após o lock a releitura detecta e responde `409 STALE_VERSION`.
- **L14.** Cliente: duas criações simultâneas para o mesmo cliente (painel) serializam; criação de cliente novo simultânea com o mesmo telefone resulta em uma única linha; hierarquia N1 → N2 sem deadlock.
- **L15.** Leitura de slots não bloqueia nem é bloqueada; um slot livre na UI pode dar 409 ao confirmar, e a UI recarrega a disponibilidade.
- Domínio de autenticação: **S10** (3.4). Limite por telefone: **P1–P7** (6.7).

#### Cenários ainda não cobertos (conhecidos)

1. Locks internos do PostgreSQL (FK, índices, exclusão) só são exercitados por estresse (L4, L6, L7, S10); não há prova nem modelo formal.
2. Migrações ou SQL manual com bloqueios fortes (`ACCESS EXCLUSIVE`) concorrentes ao tráfego: fora dos testes; mitigação por procedimento (rodar migrations em janela de manutenção, documentado na etapa 16).
3. Pool de conexões esgotado enquanto há locks retidos: coberto apenas parcialmente por L8.
4. Desempenho sob alta contenção (muitas reservas para o mesmo profissional): não medido; o desenho serializa por profissional.
5. Mais de uma instância da API: os locks são do banco, então o desenho se mantém, mas isso **não** será testado no MVP (instância única).
6. Falha/failover do banco no meio da transação: fora do escopo.
7. Operações futuras (lote, convites, alterar senha autenticado, `ADMIN`) precisarão ser enquadradas na hierarquia e entrar na tabela e na carga de L7 quando existirem.

### 6.6 Remarcação, cancelamento e passado (R7)

- **Nenhum agendamento é criado ou remarcado para o passado**, nem pelo painel: exige `starts_at > now()` (validado sob lock, com `Clock` injetável). Não há como registrar atendimento já ocorrido no MVP. Existe apenas um limite de sanidade técnica contra erro de digitação (valor inicial a definir), que **não** é regra de produto.
- Remarcar = `UPDATE` de `starts_at/ends_at/blocked_until` na **mesma transação**, com os locks de 6.5 (profissionais de origem e destino em ordem) e revalidação. Mantém os snapshots originais. Trocar de serviço = cancelar e criar outro.
- Cancelar = mudança de status; sem `DELETE`. Marcar `COMPLETED`/`NO_SHOW` ou cancelar um agendamento cujo horário já passou é permitido (não cria nada no passado).
- Edição concorrente no painel: coluna `version`; `UPDATE … WHERE version = $n`; 0 linhas ⇒ `409 STALE_VERSION`.

### 6.7 Limites iniciais da página pública (R6)

Estas são **configurações iniciais, sujeitas à validação com usuários reais**, guardadas em colunas da `Organization` (5) e editáveis só pelo `OWNER`; não devem ser tratadas como regra definitiva de produto.

| Configuração | Valor inicial | Observação |
|---|---|---|
| Agendamentos **futuros ativos** por telefone | máximo **3** | Conta `SCHEDULED`/`CONFIRMED` com `ends_at > now()` do cliente na empresa; imposto **sob o lock do cliente (N1)** de 6.5. |
| Antecedência mínima | **2 horas** | `starts_at >= now() + 2 h`. |
| Antecedência máxima | **60 dias** | `starts_at <= now() + 60 dias`. |

- O painel **não** aplica antecedência mínima/máxima nem o limite por telefone; aplica apenas "no futuro" (6.6).
- A mensagem de limite atingido é genérica ("limite de agendamentos atingido para este contato"), com `422 BOOKING_LIMIT_REACHED`. Há um pequeno *oráculo de enumeração* (alguém pode inferir que um telefone tem 3 reservas); mitigado por rate limit e aceito no MVP (seção 9).
- **Onde cada parte nasce:** a infraestrutura de lock do cliente (N1) e sua ordem em relação aos profissionais nascem na **Etapa 10** (testes L14 e L7). A **regra** do limite de 3, a contagem sob N1 e os testes abaixo pertencem à **Etapa 14**, quando o fluxo público existe.

**Testes do limite por telefone (especificação, nada executado; Etapa 14):**

- **P1.** Cinco reservas públicas simultâneas do **mesmo telefone**, para horários e profissionais diferentes ⇒ no máximo 3 sucedem; as demais falham com `BOOKING_LIMIT_REACHED`; o banco termina com exatamente 3 ativos futuros desse cliente.
- **P2.** Telefones escritos em formatos diferentes que normalizam para o mesmo E.164 contam como o mesmo cliente.
- **P3.** Cancelados, `NO_SHOW`, `COMPLETED` e agendamentos já terminados não contam; cancelar um libera uma vaga.
- **P4.** Fronteira: com 2 ativos a terceira reserva passa; com 3, a quarta falha.
- **P5.** O limite não se aplica ao painel.
- **P6.** O mesmo telefone em empresas diferentes tem contagens independentes.
- **P7.** Antecedência mínima de 2 h e máxima de 60 dias respeitadas nas fronteiras (com `Clock` injetado); a mensagem de limite não revela dados do cliente.

---

## 7. Testes, segurança, logs e erros

### Testes (Vitest)

| Nível | O quê | Como |
|---|---|---|
| Unitário | `computeSlots`, `computeAppointmentRange`, transições de status, fuso, hash canônico de idempotência, normalização de telefone, `can()` (ações permitidas ao `OWNER`; *default deny* para papel desconhecido) | Funções puras com `Clock` injetado. |
| Integração (backend) | Rotas via `app.inject()` contra **PostgreSQL real** com migrations aplicadas | Sem mock de banco. |
| Isolamento de tenant | Seção 4.4 | Bloqueante no CI. |
| Constraint, idempotência e concorrência | Seções 6.1, 6.4 e 6.5 | Bloqueante no CI. |
| Auth, e-mail e senha | Seções 3.1, 3.3, 3.4 e 3.6 | Integração, incluindo falhas injetadas. |
| Frontend | Componentes e fluxos críticos com Testing Library + MSW | Sem testes de aparência. |
| E2E | Pós-MVP inicial (Playwright) | Não no começo. |

CI (GitHub Actions) com Postgres: `lint`, `typecheck`, `test`, `build`.

### Segurança

- Zod `.strict()` em todo body/query/params; respostas serializadas por schema.
- `@fastify/helmet`, `@fastify/rate-limit` (limites distintos para login, endpoints públicos e API autenticada), `@fastify/cookie`; CORS desligado em produção.
- **Página pública (D7):** rate limit por IP e por telefone/slug + **honeypot** (campo oculto; se preenchido, responde sucesso falso e não cria nada). CAPTCHA é pós-MVP. Nunca revelar se um telefone já é cliente. Risco aceito: sem verificação do telefone é possível agendar em nome de terceiros — mitigado por 6.7 e rate limit; OTP é pós-MVP.
- Segredos só em variáveis de ambiente (inclui a chave de cifragem da outbox), validadas na subida; `.env` fora do Git.
- Raw SQL somente via tagged template e dentro da allowlist (4.4).
- `npm audit` no CI, `package-lock.json` versionado, atualização de dependências automatizada **[DECIDIR ferramenta]**.
- Backups automáticos do Postgres com **restauração testada**.
- **LGPD:** coletar o mínimo; exportação/anonimização de cliente (`customers.privacy`); logs sem PII; política de retenção definida na etapa de endurecimento.

### Logs e monitoramento básico (D11)

- `pino`, JSON em stdout, `requestId` propagado; campos `userId`, `organizationId`, `route`, `statusCode`, `durationMs`.
- **Redaction** de `authorization`, `cookie`, `password`, `token`/`newPassword` e dados pessoais (telefone/e-mail mascarados).
- `GET /api/health` (vivo) e `GET /api/ready` (consulta ao banco).
- Monitoramento básico: verificação externa de disponibilidade + alerta por e-mail (ferramenta **[DECIDIR]**), alerta/log de erro quando uma linha da `email_outbox` vira `DEAD` e quando ocorre `40P01`. **Sentry fica pós-MVP.**

### Erros e validação

- `errorHandler` único; `AppError(code, httpStatus, message, details?)`; formato `{ "error": { "code", "message", "details?", "requestId" } }`.
- Mapeamento: Zod ⇒ 400; não autenticado ⇒ 401; sem permissão (membro) ⇒ 403; recurso de outra empresa/inexistente ⇒ **404**; conflito (`23P01`, `P2002`, versão, idempotência reutilizada, `ACTIVE_ORG_CHANGED`, conflitos de `TimeOff`/`WorkingHours`) ⇒ **409**; limite de agendamentos do telefone ⇒ 422 `BOOKING_LIMIT_REACHED`; rate limit ⇒ 429; `lock_timeout`/deadlock ⇒ 503 `TEMPORARILY_BUSY`; demais ⇒ 500 genérico. A classificação dos erros de banco lê o SQLSTATE em `error.meta.driverAdapterError.cause.originalCode` (Prisma 7 com driver adapter; ver 4.3), e uma FK com `RESTRICT` pode retornar `23001` além de `23503`.
- Frontend centraliza: 401 ⇒ login; 409 `SLOT_UNAVAILABLE` ⇒ recarregar slots; 409 `ACTIVE_ORG_CHANGED` ⇒ recarregar app.

---

## 8. WhatsApp — pós-MVP (D14)

**Fora do MVP inicial; exige autorização separada antes de qualquer implementação.** Nenhuma tabela, dependência ou rota de WhatsApp existe no MVP.

Preparação sem construção:

- O núcleo de agendamento não importa nada de mensageria. Toda escrita passa por funções de serviço únicas (`createAppointment`, `rescheduleAppointment`, `cancelAppointment`, `confirmAppointment`), onde no futuro um evento será registrado na mesma transação.
- `Customer` já guarda `phone_e164`. Opt-in e demais tabelas virão com a integração.
- O padrão de **outbox transacional + laço de drenagem** especificado em 3.6 para e-mail é o mesmo que a saída de mensagens do WhatsApp reaproveitará (com `MessageChannel`), sem mudar o núcleo.

Desenho previsto (**não implementar agora**): saída por outbox + worker + `MessageChannel`; entrada em `POST /api/webhooks/whatsapp` com validação HMAC do **corpo bruto**, gravação idempotente do evento e processamento assíncrono; o tenant vem de `phone_number_id → WhatsAppAccount`, nunca do payload; respostas do cliente chamam os mesmos casos de uso do núcleo.

**[VALIDAR V11 — documentação oficial da Meta, só quando o pós-MVP for autorizado]:** regras de templates, janela de conversa, categorias e preços, onboarding (número único vs. por empresa), verificação de negócio, segurança do token, opt-in. Nada disto foi pesquisado.

---

## 9. Riscos técnicos e mitigação

| # | Risco | Mitigação |
|---|---|---|
| 1 | Vazamento entre empresas (filtro esquecido ou fora do alcance do helper) | Helper + FKs compostas + regras estáticas + DMMF/matriz/registro de rotas/sentinela SQL + suíte A×B + 404 + revisão de raw SQL (4.4). |
| 2 | Double booking | Exclusão no banco + locks + testes de concorrência (6.1, 6.5). |
| 3 | Agendamento em folga/fora do expediente, ou 4º agendamento do mesmo telefone, por corrida | Locks por cliente e profissional + revalidação + testes de invariante (6.5). |
| 4 | Deadlock por múltiplos locks | Hierarquia global (N1–N4 e A1–A4), `lockProfessionals` ordenado, guard de ordem em tempo de execução, `lock_timeout`, `SKIP LOCKED` na manutenção, sem `DELETE` físico de pais, testes L5–L8 e S10. **A ausência de deadlocks não é provada**, apenas argumentada e testada por amostragem (6.5). |
| 5 | Limitações do Prisma (FK composta, constraints manuais, erros, `FOR NO KEY UPDATE`, extensions) | Spikes na etapa 3; SQL manual versionado; testes de banco independentes do ORM (4.3). |
| 6 | Bugs de fuso/horário | UTC no banco, IANA por empresa, `timezone` imutável, `lib/time` único, `Clock` injetável, testes de borda; **[VALIDAR V1]**. |
| 7 | Abuso da página pública | Rate limit + honeypot, limite por telefone (valores iniciais, 6.7), sem confirmar clientes; CAPTCHA se necessário. |
| 8 | Roubo/abuso de sessão ou token de e-mail; enumeração de contas | Cookie HttpOnly/Secure, hash de tokens, expiração, uso único transacional, `credentials_version`, respostas idênticas (3). *Residual:* diferença sutil de tempo em `forgot-password`, mitigada por rate limit e, se necessário, trabalho equivalente fictício. |
| 9 | E-mail perdido, duplicado ou travado | Outbox persistente transacional com lease, backoff, `DEAD` visível, *at-least-once* documentado (3.6). |
| 10 | Token em claro na outbox | Payload cifrado, apagado ao finalizar, retenção curta, logs sem token (3.6); **[VALIDAR V14]**. |
| 11 | Reuso malicioso/acidental de `Idempotency-Key`; expiração duplicando operação | Hash canônico, escopo por empresa, 409 genérico, re-reivindicação atômica, limpeza em lotes com margem, testes de limpeza concorrente (6.4). |
| 12 | Aba desatualizada operando na empresa errada | `X-Active-Org` + `409 ACTIVE_ORG_CHANGED` (4.1). |
| 13 | Entregabilidade de e-mail | Provedor com SPF/DKIM/DMARC, reenvio com rate limit; **[VALIDAR V10]**. |
| 14 | Rate limit em memória inadequado a múltiplas instâncias | Aceito no MVP (instância única); migrar a armazenamento compartilhado se escalar. |
| 15 | Oráculo de enumeração pelo limite de 3 agendamentos por telefone | Mensagem genérica + rate limit; aceito no MVP. |
| 16 | Evolução futura para `ADMIN` e gerenciamento de membros | `role` extensível (V16), `can()` parametrizado por papel e matriz como dado; nenhuma lógica de `ADMIN` no MVP; a matriz futura entra com sua própria suíte quando autorizada (3.2). |
| 17 | Código gerado por agentes inconsistente | Etapas pequenas com aceite, CI obrigatório, convenções em `CLAUDE.md`/`AGENTS.md` quando houver código, revisão humana em auth, tenant, SQL e locks. |
| 18 | Perda de dados / operação solo | Backups + restore testado, Docker Compose, migrations versionadas, monitoramento básico. |
| 19 | Escopo inflado | Seção 12 explícita; sem campos de nicho (D13). |
| 20 | LGPD | Minimização, exportação/anonimização, logs sem PII. |
| 21 | Perda ou indisponibilidade da chave de cifragem da outbox | Chave fora do banco; API não inicia sem a chave corrente; linhas afetadas viram `DEAD (KEY_UNAVAILABLE/DECRYPT_FAILED)` sem chamar o provedor; rotação por `key_id`; testes O10–O14 (3.6). |
| 22 | E-mails duplicados (*at-least-once*) | Templates tolerantes à repetição, links de uso único, `lock_token` na atualização final, timeout do provedor menor que o lease (3.6). Duplicata é comportamento aceito e documentado. |

---

## 10. Hospedagem e custo (referência)

- MVP: 1 VPS pequena (Docker Compose: Caddy + API + Postgres) **ou** PaaS barato + Postgres gerenciado. Caddy dá HTTPS automático. **[DECIDIR]** com orçamento mensal-alvo; preços mudam e devem ser consultados na hora (V12).
- Backup: `pg_dump` diário para armazenamento de objetos externo, retenção de 7–30 dias, restore testado.
- Instância única da API no MVP (compatível com rate limit em memória e o laço de manutenção).

---

## 11. Sequência do MVP

Cada etapa é pequena, termina em um commit e só começa após a anterior estar verde **e autorizada**. "Aceite" é o critério objetivo de conclusão. Nenhuma etapa inclui WhatsApp, cobrança, convites ou itens da seção 12.

**Etapa 0 — Aprovar esta arquitetura**
- Aceite: seção 14 respondida; `PROJECT.md` aprovado.

**Etapa 1 — Esqueleto do monorepo**
- Entrega: workspaces, TypeScript, ESLint, Prettier, `.env.example`, `docker-compose.yml` (Postgres).
- Aceite: `npm install` limpo; `npm run lint`, `typecheck` e `test` (mesmo vazio) passam; Postgres sobe com `docker compose up -d`; nenhum segredo versionado.

**Etapa 2 — Backend base**
- Entrega: `buildApp()`, validação de env, logger com redaction, `errorHandler`, `GET /api/health` e `/api/ready`, `Clock`.
- Aceite: testes de health, 404 e erro de validação no formato padrão; env inválida impede a subida; logs sem `cookie`/`authorization`.

**Etapa 3 — Fundação do banco + spikes de validação**
- Entrega: Prisma; spikes que resolvem V1–V8, V13, V15 e V16 (UUID v7, FK composta, constraint manual sem drift, `23P01`/`40P01`/`55P03`, `btree_gist` com `uuid`, `date-fns-tz`, opção para `blocked_until`, `ON CONFLICT DO UPDATE … WHERE`, `FOR NO KEY UPDATE` via `$queryRaw` e compatibilidade com `FOR KEY SHARE`, mecanismo extensível para `memberships.role`); migration inicial de identidade (`users` com `credentials_version`, `organizations`, `memberships`, `sessions`, `auth_tokens`).
- Aceite: migrations aplicam em banco limpo e `prisma migrate diff` não mostra drift; cada item [VALIDAR] resolvido **com evidência** (teste ou documentação oficial citada) ou registrado como decisão/alternativa neste documento; teste de integração com UUID v7; **decisão sobre `blocked_until` (6.1) e resultados dos spikes apresentados para aprovação antes da etapa 4**.

**Etapa 4 — Auth núcleo**
- Entrega: registro (sem enumeração), login, logout, `GET /api/me`, sessões com hash, expiração e `credentials_version`, CSRF/Origin, rate limit de login.
- Aceite: cookie com flags corretas; token só em hash no banco; senha errada e usuário inexistente ⇒ resposta idêntica; sessão expirada/revogada ⇒ 401; sessão com `credentials_version` diferente da atual do usuário ⇒ 401, sem cache de sessão (**S8**); o login lê hash e versão numa única consulta (**S9**, parte de consulta única); rate limit testado.

**Etapa 5 — E-mail (outbox), verificação e recuperação de senha**
- Entrega: tabela `email_outbox` + laço de drenagem/manutenção (3.6), `EmailSender` com implementação de console/captura, fluxos de 3.3 e 3.4 (sem troca de e-mail), validação de `credentials_version` já implementada na etapa 4 e exercitada aqui.
- Aceite: testes **S1–S7 e S10** (3.4) e a metade de **S9** que usa redefinição (a verificação de consulta única e **S8** já são exigidas na etapa 4) e **O1–O15** (3.6) verdes; usuário não verificado é bloqueado onde exigido (a verificação é aplicada na criação de empresa na etapa 6 e na publicação na etapa 14). Provedor real **não** é exigido aqui.

**Etapa 6 — Tenant, permissões e empresas**
- Entrega: `tenantPlugin`, `active_organization_id`, `X-Active-Org`, `forTenant()`, `can()` com a matriz do MVP (3.2, somente `OWNER`), criar empresa (+ membership `OWNER`, **exige e-mail verificado**), editar configurações da empresa, listar/trocar empresa.
- Aceite: itens 1–7 de 4.4 implementados e verdes; testes de `can()` (todas as ações permitidas ao `OWNER`, *default deny* para papel desconhecido); usuário sem membership ⇒ 404; criar empresa sem e-mail verificado ⇒ erro; `timezone` não pode ser alterado depois; divergência de `X-Active-Org` ⇒ 409; `organizationId` no body ⇒ 400; usuário `OWNER` de 2 empresas isolado corretamente. **Nenhum teste, seed ou código de `ADMIN`.**

**Etapa 7 — Serviços**
- Entrega: CRUD de `Service` com `duration_minutes` e `buffer_minutes` (padrão 0).
- Aceite: validação de limites; A×B verde; somente o `OWNER` da empresa ativa opera; usuário de outra empresa ⇒ 404.

**Etapa 8 — Profissionais e vínculo com serviços**
- Entrega: `Professional` (sem login), `ProfessionalService`.
- Aceite: vincular serviço de outra empresa falha (aplicação ⇒ 404; SQL cru ⇒ erro de FK composta); A×B verde.

**Etapa 9 — Disponibilidade e locks**
- Entrega: `WorkingHours`, `TimeOff` (CRUD **sem** verificação contra agendamentos, pois ainda não existem — essa verificação entra na etapa 10; entre as etapas 9 e 10 não há agendamentos no banco), `lib/db/locks` com a hierarquia e o guard de ordem, `lockProfessionals`, `computeSlots` puro.
- Aceite: testes unitários de `computeSlots` (grade de 15 min, duração fora da grade, buffer, fuso, virada de dia, folgas, antecedência); `WorkingHours` do mesmo dia sem sobreposição; **L5** (guard), **L8** (estático e de pool), **L9** (cobertura do lock, na parte de `TimeOff`/`WorkingHours`) e **L10** (`lock_timeout`) verdes.

**Etapa 10 — Agendamentos (núcleo)**
- Entrega: `Customer`, `Appointment`, `IdempotencyRecord`; migration manual da constraint e da coerência de `blocked_until` (opção decidida na etapa 3); criar/remarcar/cancelar/confirmar com a hierarquia N1→N4 e a tabela de operações de 6.5; rejeição de `TimeOff`/`WorkingHours` conflitantes com a lista (R4); proibição de passado (R7). **O limite de 3 por telefone e os limites públicos não entram aqui** (etapa 14).
- Aceite: testes de 6.1 (1–10), 6.4 (1–9) e de concorrência **L1–L4, L6, L7, L9 (completo), L11–L15** verdes; `blocked_until` coerente; editar serviço depois não muda agendamentos; remarcar/criar no passado ⇒ erro; transições inválidas rejeitadas; A×B verde. Os resultados de L4, L6 e L7 são evidência por amostragem, não prova de ausência de deadlock.

**Etapa 11 — Frontend base**
- Entrega: Vite + React Router + cliente HTTP único; telas pt-BR de registro, login, verificação, recuperação de senha, seletor de empresa, layout protegido.
- Aceite: fluxo completo contra o backend local (navegador headless); 401/409 tratados centralmente; testes de componente nos fluxos de auth; nenhum token em `localStorage`.

**Etapa 12 — Painel: serviços, profissionais e disponibilidade**
- Aceite: criar/editar serviço (com buffer), profissional, vínculos, horários e folgas; conflito de `TimeOff`/`WorkingHours` exibe a lista de agendamentos afetados e não altera nada; testes de componente.

**Etapa 13 — Painel: agenda**
- Aceite: visão diária/semanal; criar/remarcar/cancelar com `Idempotency-Key`; `409 SLOT_UNAVAILABLE` recarrega slots; tentativa de agendar no passado bloqueada na UI e na API; fluxo manual guiado documentado.

**Etapa 14 — Página pública de agendamento**
- Entrega: publicar/despublicar (`OWNER`, **exige e-mail verificado**), `/api/public/:slug/...`, telas, honeypot, rate limit, e a **regra** dos limites de 6.7 (3 futuros ativos por telefone, 2 h, 60 dias) sobre a infraestrutura de lock do cliente criada na etapa 10.
- Aceite: só empresa publicada responde; publicar sem e-mail verificado ⇒ erro; nada de outras empresas exposto; honeypot preenchido não cria registro; rate limit por IP/telefone testado; **P1–P7** (6.7) verdes, incluindo as cinco reservas simultâneas do mesmo telefone; cliente existente não é sobrescrito; replay idempotente funciona.

**Etapa 15 — Endurecimento e CI**
- Entrega: helmet, limites finais, redaction revisada, `npm audit`, GitHub Actions, backup + restauração documentada, monitoramento básico, alerta de `DEAD`/`40P01`.
- Aceite: CI verde com a suíte completa (isolamento, constraint, concorrência, auth/e-mail); restauração de backup executada com sucesso; checklist de segurança revisado.

**Etapa 16 — Deploy do MVP**
- Aceite: produção com HTTPS, migrations aplicadas, e-mail real com SPF/DKIM validados, smoke test (registro → verificação → criar empresa → publicar → agendar pela página pública) executado e documentado.

---

## 12. Fora do MVP (pós-MVP, exige autorização)

Integração com WhatsApp (mensagens, webhooks, worker de mensageria), confirmações/lembretes automáticos, cobrança/assinaturas, **papel `ADMIN`, convites de equipe e qualquer fluxo de gerenciamento de membros** (R2, C1), **troca de e-mail da conta** (R8), **troca de timezone da empresa** (R9), **agendamentos retroativos** (R7), CAPTCHA, Sentry, Row-Level Security, 2FA/login social, verificação de telefone por OTP, i18n, pacote `shared/`, Redis/filas externas, integração com calendários externos, relatórios avançados, campos especializados por nicho, E2E completo automatizado.

---

## 13. Validações técnicas pendentes ([VALIDAR])

> Nenhum item desta tabela é decisão de produto. Os itens V1–V8, V13, V15 e V16 foram **resolvidos na Etapa 3**, com evidência (testes de integração em PostgreSQL real e saídas de CLI) registrada em [`docs/STAGE-3-VALIDATIONS.md`](./STAGE-3-VALIDATIONS.md). Os demais continuam **"não verificado"**: nenhum spike foi executado e nenhuma documentação oficial foi consultada para eles. Até serem resolvidos **com evidência** (teste ou documentação oficial citada), não devem ser tratados como garantia.

| # | Item | Resolve em | Estado |
|---|---|---|---|
| V1 | `date-fns-tz`: compatibilidade com a versão de `date-fns` escolhida; IANA/DST corretos | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V1 |
| V2 | UUID v7: `uuid(7)` no Prisma escolhido; versão do PostgreSQL; geração na aplicação; ordenação | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V2 |
| V3 | FK compostas no Prisma: campo compartilhado entre relações, relações opcionais, `onDelete` | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V3 |
| V4 | `EXCLUDE`/`CHECK`/índices parciais/trigger em migration manual sem drift (`migrate diff`) | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V4 |
| V5 | `btree_gist` com `uuid` na versão do PostgreSQL | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V5 |
| V6 | Mapeamento de SQLSTATE `23P01` e `P2002` no Prisma | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V6 |
| V7 | Comportamento de `forTenant` em `findUnique`, `upsert`, `createMany`, escritas e leituras aninhadas | Etapas 3 e 6 | **Resolvido com ressalva** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V7. Ressalva: o teste foi um protótipo descartável; `$queryRaw`, filtros/`include` aninhados e escritas aninhadas **não** são cobertos pelo helper (a garantia nesses casos é a FK composta); a implementação de produção e seus testes continuam na Etapa 6 |
| V8 | Coerência de `ends_at`/`blocked_until`: `CHECK` com `timestamptz + intervalo` (aceito? estável em dump/restore?), trigger que rejeita vs. que sobrescreve, atrito com Prisma — **decide a opção de 6.1** | Etapa 3 | **Resolvido com ressalva** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V8. Opção 1 (`CHECK`) aprovada em 6.1. Ressalvas: coluna gerada é impossível (`timestamptz + interval` não é `IMMUTABLE`); a aplicação deve recalcular `starts_at`, `ends_at` e `blocked_until` juntos em todo `UPDATE`; o trigger que sobrescreve não foi testado |
| V9 | Biblioteca/lista de senhas comuns; parâmetros vigentes de argon2id | Etapa 4 | Não verificado |
| V10 | Provedor de e-mail: limites do plano, SPF/DKIM/DMARC, entregabilidade, chave de idempotência, classificação de erro permanente | Etapa 5 (escolha) e 16 | Não verificado |
| V11 | WhatsApp Cloud API: regras, preços, templates, onboarding, segurança | Somente se o pós-MVP for autorizado | Não verificado |
| V12 | Preços de hospedagem | Etapa 16 | Não verificado |
| V13 | Semântica de `INSERT … ON CONFLICT DO UPDATE … WHERE` (re-reivindicação de registro vencido) sob concorrência | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V13 |
| V14 | Cifragem do payload da outbox (AES-256-GCM via módulo nativo do Node), gestão/rotação da chave, comportamento com `key_id` desconhecido | Etapa 5 | Não verificado |
| V15 | `SELECT … FOR NO KEY UPDATE` via `$queryRaw` em transação interativa do Prisma; timeout padrão da transação; `lock_timeout`; mapeamento de `40P01`/`55P03`; compatibilidade entre `FOR NO KEY UPDATE` e a checagem `FOR KEY SHARE` das chaves estrangeiras | Etapa 3 | **Resolvido** (Etapa 3) — ver `STAGE-3-VALIDATIONS.md`, V15 |
| V16 | Mecanismo extensível para `memberships.role` (enum nativo vs. texto com `CHECK`), pensando na futura adição de `ADMIN` | Etapa 3 | **Resolvido** (Etapa 3) — enum nativo; ver `STAGE-3-VALIDATIONS.md`, V16 |

**Resolvem-se na Etapa 3, antes da Etapa 4:** V1–V8, V13, V15, V16. **Em etapas posteriores:** V9 (4), V14 (5), V10 (5 e 16), V12 (16). **Condicional:** V11.

---

## 14. Decisões humanas pendentes

Separadas por **quando precisam ser resolvidas**. Nenhuma está aprovada; cada uma tem proposta já refletida no texto.

### 14.1 Bloqueiam o início da Etapa 1

A Etapa 1 só cria o esqueleto (workspaces, lint, TypeScript, Postgres local) e **não toca em regra de negócio**; portanto **nenhuma decisão de produto pendente a bloqueia**. Falta apenas:

1. **Aprovação formal desta arquitetura (Etapa 0)**, incluindo as correções C1–C6 da revisão 4 (em especial: `OWNER` como único papel operacional no MVP).
2. **Versões-alvo do esqueleto:** Node.js (proposta: a versão LTS ativa) e major do PostgreSQL no `docker-compose.yml`. O número exato deve ser conferido na documentação oficial no momento da Etapa 1 e pode ser trocado depois; a escolha do PostgreSQL será reconfirmada pelos spikes V2, V5, V13 e V15. Decisão humana: aceitar que a proposta seja escolhida e registrada na própria Etapa 1.

### 14.2 Resolvidas durante a Etapa 3, antes da Etapa 4

Não são decisões de produto: são **resultados de validação técnica que precisam de aprovação humana** antes de avançar.

- Resultados de V1–V8, V13, V15 e V16 (seção 13), com evidência.
- Opção final para a coerência de `blocked_until` (6.1).
- Versões exatas de Prisma, PostgreSQL e `date-fns`/`date-fns-tz`; estratégia de geração de UUID v7.
- Mecanismo de `memberships.role` que preserve a futura adição de `ADMIN`.

### 14.3 Resolvidas na etapa que as implementa

| Decisão | Etapa | Proposta já no texto |
|---|---|---|
| Parâmetros de senha (argon2id, lista de senhas comuns) | 4 | 3.1 (V9) |
| Tempo de expiração dos tokens (30–60 min), máximo de tentativas, tamanho do lease e timeout do provedor na outbox | 5 | 3.4, 3.6 |
| Provedor de e-mail | 5 (escolha), 16 (verificação) | 3.5 |
| `lock_timeout` inicial e demais timeouts | 9 | 6.5 |
| Limite de sanidade técnica para datas muito distantes no painel | 10 | 6.6 |
| Página pública começa **despublicada** por padrão | 14 | 4.2, 5 |
| Ferramenta de monitoramento externo e de atualização de dependências | 15 | 7 |
| Hospedagem, orçamento e janela de migrations em produção | 16 | 10 |

**Resolvidas pela revisão 4 (não pendentes):** papel `ADMIN` e matriz de permissões no MVP (C1); exportar/anonimizar cliente passa a ser ação do `OWNER` (3.2).

---

## 15. Decisões de produto aprovadas e rastreio

### Revisão 2 (D1–D14)

| ID | Decisão | Onde está refletida |
|---|---|---|
| D1 | Usuário pode ter várias empresas (memberships) | 3.2, 4.1, 5 |
| D2 | Só quem tem login opera; profissionais sem conta (**no MVP, somente `OWNER`**, ver C1) | 3.2, 5 |
| D3 | Cliente final agenda sem criar conta | 3.2, 4.2, 11 (etapa 14) |
| D4 | Verificação de e-mail e recuperação de senha no MVP; provedor escolhido na implementação | 3.3–3.6, 11 (etapa 5) |
| D5 | Grade de 15 min; duração do serviço independente | 5, 6.1, 6.2 |
| D6 | Buffer por serviço, padrão 0 | 5, 6.3 |
| D7 | Rate limit + honeypot (CAPTCHA se necessário) | 7, 11 (etapa 14) |
| D8 | `date-fns-tz`, após confirmar compatibilidade | 1, 13 (V1) |
| D9 | UUID v7, após confirmar suporte | 1, 13 (V2) |
| D10 | Sem pacote `shared/` | 2 |
| D11 | Logs estruturados e monitoramento básico; Sentry depois | 7 |
| D12 | UI somente em pt-BR | 1 |
| D13 | Sem especialização por nicho | 5, 12 |
| D14 | WhatsApp fora do MVP, com autorização separada | 8, 12 |

### Revisão 3 (R1–R10)

| ID | Decisão | Onde está refletida |
|---|---|---|
| R1 | Matriz de permissões `OWNER`/`ADMIN` (**ajustada por C1:** no MVP só `OWNER`; a matriz de `ADMIN` fica como proposta para a evolução futura) | 3.2, 12 |
| R2 | Convites fora do MVP | 3.2, 5, 11, 12 |
| R3 | Buffer pode ultrapassar expediente/encostar em folga; só o atendimento real precisa caber | 6.2, 6.3, 6.5 |
| R4 | `TimeOff`/`WorkingHours` conflitantes com agendamentos ativos futuros são rejeitados com lista; nada cancelado automaticamente | 6.5, 11 (etapas 10 e 12) |
| R5 | Reuso de `Idempotency-Key` com payload diferente ⇒ `409`; retenção de 24 h com limpeza segura | 6.4, 7, 11 (etapa 10) |
| R6 | Página pública: 3 agendamentos futuros ativos por telefone, antecedência mínima de 2 h e máxima de 60 dias — configurações iniciais sujeitas a validação | 5, 6.2, 6.7, 11 (etapa 14) |
| R7 | Sem agendamentos no passado no MVP, inclusive pelo painel | 6.1, 6.2, 6.6, 11 (etapas 10 e 13), 12 |
| R8 | Troca de e-mail da conta fora do MVP | 3.3, 5, 12 |
| R9 | `timezone` da empresa imutável no MVP | 1, 5, 6.5, 12 |
| R10 | E-mail verificado antes de criar empresa ou publicar a página pública | 3.3, 4.2, 11 (etapas 5, 6 e 14) |

### Revisão 4 (C1–C6)

| ID | Correção / decisão | Onde está refletida |
|---|---|---|
| C1 | `OWNER` é o único papel operacional do MVP; `ADMIN` e gerenciamento de membros são evolução futura, sem fluxos artificiais por seed; extensibilidade preservada | 3.2, 5, 9 (risco 16), 11 (etapas 6, 7, 14), 12, 13 (V16), 14 |
| C2 | O teste de cinco reservas simultâneas do mesmo telefone pertence à etapa em que o limite de 3 é implementado (14); a infraestrutura de lock do cliente e os testes gerais de concorrência ficam na etapa 10 | 6.5 (L14), 6.7 (P1–P7), 11 (etapas 10 e 14) |
| C3 | Hierarquia global de locks com recursos por operação, guard de ordem, testes de concorrência e cenários não cobertos; sem afirmar que o log de queries prova ausência de deadlock | 6.5, 9 (risco 4) |
| C4 | Validação explícita de `credentials_version` da sessão contra a versão atual do usuário; interação com revogação e login concorrente; critérios S1–S10 | 3.1, 3.4, 11 (etapas 4 e 5) |
| C5 | Outbox de e-mail *at-least-once* com duplicatas possíveis; comportamento por falha, lease, reinício, `DEAD` e `not_after`; chave de cifragem fora do banco e comportamento definido para sua perda; critérios O1–O15 | 3.6, 9 (riscos 10, 21 e 22), 13 (V14) |
| C6 | Pendências separadas em: bloqueiam a Etapa 1, resolvidas na Etapa 3, resolvidas na etapa que as implementa; validações técnicas listadas como não verificadas | 13, 14 |

### Ajustes técnicos da revisão 3 (mantidos)

| Ajuste | Onde |
|---|---|
| A — envio de e-mail persistente (outbox) | 1, 3.6, 11 (etapa 5) |
| B — redefinição de senha transacional e segura contra concorrência | 3.1, 3.4 |
| C — locks em ordem determinística | 6.5 |
| D — coerência de `blocked_until` (decisão final na etapa 3) | 6.1, 13 (V8), 11 (etapa 3) |
| E — consistência entre seções e entre os dois documentos | Verificada na revisão 4 |
| F — separação entre decisões aprovadas (15), validações técnicas (13) e decisões pendentes (14) | Cabeçalho, 13, 14, 15 |
