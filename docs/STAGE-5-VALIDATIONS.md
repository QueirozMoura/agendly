# Etapa 5 — Outbox de e-mail, verificação de e-mail e recuperação de senha

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado; as mudanças de estado que
> esta etapa sugere estão na seção 5, para aprovação.

## 1. Escopo e divergência tratada antes de codificar

O pedido original descrevia "organizações, memberships `OWNER` e configurações da empresa" como Etapa 5.
Esse escopo é o da **Etapa 6** do plano aprovado (seção 11 de `ARCHITECTURE.md`); a **Etapa 5** do plano é
*E-mail (outbox), verificação e recuperação de senha*. A Etapa 6 ainda exige e-mail verificado para criar
empresa (R10), e a verificação só passa a existir agora. Decisão do responsável: **executar a Etapa 5 do plano**.
Nada de organizações foi implementado.

Entregue: tabela `email_outbox` + laço de drenagem/manutenção (3.6), `EmailSender` com implementação de
console/captura, verificação de e-mail e reenvio (3.3), recuperação de senha (3.4), "sair de todos os
dispositivos" (necessário ao teste S10; `account.*` da matriz 3.2) e as ações de conta associadas.

## 2. Rotas

| Rota | Autenticação | Resultado |
|---|---|---|
| `POST /api/auth/register` *(alterada)* | — | Mesma resposta `202`. Novo: usuário + token + `VERIFY_EMAIL` na mesma transação. Existente: só `ACCOUNT_EXISTS`. |
| `POST /api/auth/verify-email` `{token}` | — | `204`, ou `400 TOKEN_INVALID_OR_EXPIRED` (idêntico para expirado, usado, inexistente, lixo e token de outro tipo). |
| `POST /api/auth/resend-verification` | sessão | `202` sempre com a mesma mensagem (verificado ou não). Limite por usuário e por IP. |
| `POST /api/auth/forgot-password` `{email}` | — | `202` idêntico exista o e-mail ou não (status, corpo e cabeçalhos). Limite por IP e por e-mail. |
| `POST /api/auth/reset-password` `{token,newPassword}` | — | `204`; revoga sessões, soma 1 à `credentials_version`, enfileira `PASSWORD_CHANGED`. |
| `POST /api/auth/logout-all` | sessão | `204`; revoga todas as sessões do usuário (A1 → A3). |

Todas herdam CSRF (Origin + JSON), `Cache-Control: no-store` e rate limit. Os tokens trafegam só no corpo.

## 3. Decisões fixadas (14.3) e justificativas

| Decisão | Valor | Observação |
|---|---|---|
| Validade dos tokens de verificação e de redefinição | **60 min** | 3.4 pede 30–60 min; 3.6 supõe tokens de vida curta (≤ ~1 h). Verificação de 1 h é curta para o usuário: o reenvio existe para isso. |
| Tentativas máximas | **8** | `attempts` soma já na **reivindicação**: um processo que morre repetidamente também esgota as tentativas (DEAD `MAX_ATTEMPTS`). |
| Backoff | 30 s × 2^(n−1), teto 15 min, jitter ±20% | |
| Lease / timeout do provedor | **60 s / 10 s** | Timeout bem menor que o lease (3.6, regra 3). |
| `not_after` | = validade do token; avisos sem token: 24 h | Verificado antes de cada tentativa. |
| Retenção de linhas finalizadas | 7 dias | Sessões revogadas: 7 dias; sessões/tokens vencidos: apagados 1 h após o vencimento. |
| Laços | outbox a cada 5 s; manutenção a cada 60 s | No processo da API; `stop()` espera o ciclo atual e roda antes de fechar app e banco. |
| Chave | `OUTBOX_ENCRYPTION_KEYS=id:base64,…` + `OUTBOX_CURRENT_KEY_ID` | 32 bytes cada; ausência/malformação em produção impede a subida (O10). Em dev/teste há uma chave fixa e pública (`dev`), **recusada em produção**. |
| Links dos e-mails | `APP_BASE_URL` (padrão: 1ª origem permitida) + fragmento `#token=` | `/verificar-email`, `/redefinir-senha` (3.4). Rotas do SPA são da Etapa 11. |
| AAD da cifragem | id da linha | Um payload copiado para outra linha não decifra (testado). |
| Constraints manuais na migration `email_outbox` | `email_outbox_payload_lifecycle`, `email_outbox_dead_reason_consistent` | O banco impede `SENT`/`DEAD` com payload, `PENDING`/`SENDING` sem payload ou sem `key_id`, e `dead_reason` fora de `DEAD`. |
| Provedor de e-mail | **não escolhido** | V10 continua "não verificado". Em **produção a API recusa subir sem provedor** (em vez de "enviar" para o console e perder e-mails). Em dev, `ConsoleEmailSender` imprime a mensagem **com o link/token** — por isso só existe fora de produção. |

## 4. Evidência (testes de integração com PostgreSQL real)

**3.4 — recuperação de senha**

| Critério | Onde |
|---|---|
| S1 duas redefinições simultâneas, mesmo token | `test/auth/recovery.test.ts` (S1) |
| S2 falha injetada após o consumo do token: rollback total (3 pontos: `user.update`, `session.updateMany`, `emailOutbox.create`) e o token segue utilizável | `recovery.test.ts` (S2) |
| S3 login concorrente, barreiras (2 cenários da tabela de 3.4 + "depois do commit") | `recovery.test.ts` (S3/S9) |
| S4 token novo invalida anteriores; expirado/usado/inexistente iguais | `recovery.test.ts` |
| S5 sessões anteriores inválidas e exatamente um aviso na outbox | `recovery.test.ts` |
| S6 só hash no banco (e payload cifrado) | `recovery.test.ts`, `verification.test.ts` |
| S7 `forgot-password` indistinguível | `recovery.test.ts` |
| S9 (metade da redefinição: sessão criada após o commit cai) | `recovery.test.ts` (S3/S9, 1º cenário) |
| S10 carga mista aleatória (6 operações, 40 rodadas, `deadlock_timeout` = 50 ms): zero `40P01`/`55P03` | `test/auth/concurrency.test.ts` (executado 4×) |

**3.6 — outbox**

| Critério | Onde |
|---|---|
| O1 retentativas com backoff e `SENT` / O2 `MAX_ATTEMPTS` sem token em `last_error` | `test/email/outbox.test.ts` |
| O3 lease vencido: duplicata aceita e processo atrasado não sobrescreve | `outbox.test.ts` |
| O4 dois ciclos concorrentes / `SKIP LOCKED` sem esperar | `outbox.test.ts` |
| O5 rollback ⇒ nenhuma linha; commit ⇒ exatamente uma | `test/auth/verification.test.ts` |
| O6 API normal com provedor fora do ar | `verification.test.ts` |
| O7 `not_after` vencido ⇒ `EXPIRED` sem chamar o provedor | `outbox.test.ts` |
| O8 payload `NULL` após `SENT`/`DEAD` (e CHECK no banco) | `outbox.test.ts` |
| O9 reinício no meio de `SENDING` | `outbox.test.ts` |
| O10 chave corrente ausente ⇒ API não inicia | `test/env.test.ts` |
| O11 `key_id` desconhecido / O12 chave errada ou payload adulterado | `outbox.test.ts` |
| O13 rotação | `outbox.test.ts` |
| O14 restaurar `pg_dump` sem a chave ⇒ `DEAD`, sem vazar token | `test/email/infra.test.ts` |
| O15 logs e `last_error` sem payload, token ou chave | `outbox.test.ts`, `auth/failures.test.ts` |

**V14 — resolvido:** AES-256-GCM via `node:crypto` (IV de 12 bytes aleatório, tag de 16, AAD = id da linha)
cifra/decifra; chave errada, AAD diferente, adulteração e truncamento falham (`infra.test.ts`); chave
desconhecida e rotação se comportam como especificado (O11–O13). Chaves e payload nunca aparecem em logs.

Verificações finais: `lint`, `format:check` e `typecheck` sem erros; **233 testes em 24 arquivos** passando;
`db:drift` sem diferenças; as 2 migrations aplicadas em banco novo (`agendly_clean`), com as constraints manuais
presentes e sem drift. Teste ponta a ponta com o servidor real (`npm start`, `NODE_ENV=development`): cadastro →
e-mail de verificação impresso no console pelo laço → verificação → esqueci a senha → redefinição → login com a
senha nova (a antiga falha) → 3 linhas da outbox em `SENT` com payload nulo; nenhum token/senha nos logs estruturados.

## 5. Mudanças sugeridas ao `ARCHITECTURE.md` (NÃO aplicadas — aguardam aprovação)

1. Seção 13: **V14** ⇒ resolvido na Etapa 5 (AES-256-GCM nativo). **V10** permanece "não verificado" (só a
   interface e a implementação de console/captura existem).
2. Seção 14.3: registrar os valores da seção 3 acima (validade 60 min, 8 tentativas, lease 60 s, timeout 10 s).
3. Seção 3.6: acrescentar que `attempts` soma na reivindicação e as duas constraints do banco sobre o ciclo de vida do payload.
4. Seção 3.2/3.x: a rota `logout-all` (já coberta por `account.*` da matriz) passou a existir.

## 6. Limitações e riscos remanescentes

- **S10 é evidência estatística**, não prova (como o documento já diz). `lockUser` não tem guard de ordem em
  tempo de execução nem `lock_timeout`: ambos são da Etapa 9. Um lock preso só é interrompido pelo timeout de 5 s da transação do Prisma.
- **Sem provedor de e-mail real**: produção não sobe. É intencional, mas bloqueia qualquer ensaio de produção
  (Etapas 15–16) até a escolha do provedor (V10, decisão humana).
- **Tempo de resposta**: `forgot-password` (usuário existe ⇒ transação com escritas) e o cadastro (novo × existente)
  fazem trabalho diferente; a diferença de tempo não foi medida nem mitigada além do rate limit (risco 8 do documento).
- O timeout do provedor usa `Promise.race` + `AbortSignal`: um `EmailSender` que ignore o sinal continua trabalhando
  em segundo plano depois do timeout (a linha é tratada como falha transitória e pode gerar duplicata — aceito, at-least-once).
- O `to_email` fica em texto claro na outbox (necessário para enviar) por até 7 dias depois de finalizado.
- Tempo: expiração de tokens, lease e backoff usam o relógio da aplicação (injetável), não `now()` do banco —
  coerente com instância única; múltiplas instâncias exigiriam rever isto.
- Rate limits continuam em memória (instância única). O limite por e-mail em `forgot-password`/cadastro também permite que
  terceiros esgotem a cota de um e-mail alheio (3/h).
- Não implementado (fora da etapa): rotas e telas do SPA, exigência de e-mail verificado onde for aplicada
  (Etapas 6 e 14), troca de senha autenticada, troca de e-mail, organizações.
