# Verificação de e-mail e recuperação de senha

> **Status da entrega real de e-mails: PENDENTE e NÃO validada.** Nenhuma credencial do provedor estava disponível. A lógica
> (tokens, outbox, regra de bloqueio, adaptador do Resend) foi testada com **mocks**; nenhum e-mail real foi enviado e a
> chamada à API do Resend nunca foi feita. Não declarar V10 (entregabilidade, SPF/DKIM/DMARC, limites do plano) como resolvida.

## Regra (R10)

Criar empresa (`POST /api/organizations`) exige e-mail verificado: sem ele, `403 EMAIL_NOT_VERIFIED` e nada é gravado.
Cadastro, login, sessões e as demais rotas autenticadas nunca exigiram verificação.

| Ambiente | Padrão | `REQUIRE_EMAIL_VERIFICATION=false` |
|---|---|---|
| `production` | exigida | **recusado na inicialização** (`EnvError`) |
| `development` / `test` | **exigida** (antes era dispensada) | dispensa explícita, só para quem opta |

Defesas em camadas contra desligar em produção: `loadEnv` recusa; `buildApp` lança se receber cookies seguros (produção)
com a verificação dispensada. Nada vindo do cliente (query, corpo, cabeçalho, cookie) influencia a regra (há teste).
Qualquer valor diferente de `true`/`false` (inclusive vazio) é recusado.

A API informa a regra efetiva em `user.emailVerificationRequired` (login e `GET /api/me`), junto de `user.emailVerified`.

**Publicar a página pública (Etapa 14) ainda não existe**; quando existir, deve exigir e-mail verificado (R10) pela política
`emailPolicyAllows`, sem depender desta variável (ver "Contas antigas"). Hoje a variável só afeta criar empresa. A interface não menciona publicação.

## Interface

A faixa em `AppLayout` aparece só para conta não verificada e segue a API:
- exigida: "Confirme seu e-mail para criar empresas." + botão de reenvio;
- dispensada (só desenvolvimento): "Seu e-mail ainda não foi confirmado. Neste ambiente de desenvolvimento a confirmação não é exigida.";
- verificada: nenhuma faixa.

## Fluxos

- Cadastro enfileira `VERIFY_EMAIL` na mesma transação; link com token de 32 bytes, só o SHA-256 no banco, validade de 1 h, uso único.
- Reenvio (`POST /api/auth/resend-verification`, autenticado, com rate limit): invalida o link anterior; já verificado ⇒ resposta idêntica e nenhum e-mail.
- Recuperação (`forgot-password` → `reset-password`): resposta idêntica exista o e-mail ou não; token de 1 h, uso único; troca a senha,
  revoga todas as sessões. **Redefinir a senha não marca o e-mail como verificado.**
- Entrega: outbox transacional + worker (retentativas com backoff; 4xx 400/422 do Resend ⇒ falha definitiva).

## Provedor de e-mail (Resend)

| Variável | Descrição |
|---|---|
| `RESEND_API_KEY` | chave de API (segredo; nunca versionar; mascarada nos logs). Formato `re_…` |
| `EMAIL_FROM` | remetente em domínio verificado no Resend: `ana@dominio.com` ou `Agendly <no-reply@dominio.com>` |

- **Produção:** os dois são obrigatórios e `ALLOWED_ORIGINS`/`APP_BASE_URL` precisam ser **HTTPS** (HTTP é recusado; links com token não trafegam em claro).
- **Desenvolvimento/teste:** nenhum ⇒ o e-mail (com o link) é impresso no terminal; os dois ⇒ Resend; só um ⇒ erro. HTTP local continua aceito.
- **Validação de formato** (qualquer ambiente): remetente realista (`x@`, `x@y`, `x..y@d.com`, nome com `<>"` ou quebra de linha, vários endereços são recusados)
  e chave `re_` + 16 a 200 caracteres `[A-Za-z0-9_]`. É só formato: **não prova** que a chave existe nem que pode enviar, e o formato exato não é garantido pela documentação.
- **Verificação na subida (só produção, Resend real):** `GET /domains` com a chave. Chave recusada (400/401/403) ou domínio do remetente (ou o domínio pai) ausente/não
  `verified` ⇒ **a API não sobe**, antes de abrir banco e porta. Chave restrita a envio, rede fora, timeout (5 s), 429/5xx, lista paginada sem o domínio ⇒ sobe com
  aviso "A entrega NÃO foi confirmada" (uma instabilidade do provedor não deve derrubar a API). Baseada na documentação; **não exercitada contra a API real**.

### Classificação de erros de envio (segundo a documentação do Resend; NÃO validada na API real)

| Resposta | Tratamento |
|---|---|
| 400/422 de requisição inválida, 409 `invalid_idempotent_request`, 404/405 | **definitivo** (`DEAD`, `PERMANENT_ERROR`) |
| 400 cujo texto cita "API key", 401, 403 (chave, permissão, domínio não verificado, suspensão) | temporário: configuração que o operador corrige; tenta de novo até o limite da outbox |
| 409 `concurrent_idempotent_requests`/`resource_locked`, 408, 429, 5xx, rede | temporário, com backoff |

O 400 `validation_error` serve tanto a campos inválidos quanto a chave inválida; a distinção por texto é uma **heurística**. Só `name` e `message` do corpo
são lidos, e nunca vão a log nem a erro (a mensagem registrada é "Resend respondeu HTTP <status> (<name>)").

### Idempotência e duplicatas

- A documentação do Resend informa que `POST /emails` aceita `Idempotency-Key` (até 256 caracteres, validade de 24 h). A outbox envia o **id da linha** como chave,
  igual em toda tentativa da mesma mensagem (testado). Mensagens diferentes têm chaves diferentes.
- **Limitações:** a documentação consultada não detalha a resposta a uma repetição bem-sucedida nem o comportamento exato de concorrência; o efeito real contra a
  API **não foi testado**, então não se afirma que a duplicação foi eliminada. Fora da janela de 24 h a proteção some (a mensagem de verificação/recuperação expira em 1 h,
  dentro dela). Mesma chave com corpo diferente (ex.: `APP_BASE_URL` mudou entre tentativas) é recusada pelo Resend (409) e a mensagem fica `DEAD`.
- **Reenvio de verificação:** cada reenvio cria uma **nova** linha na outbox (chave nova) e invalida o token anterior ao ser emitido. Se o e-mail anterior ainda estiver na fila
  (`PENDING`, por backoff), ele ainda será enviado, com um link já inválido; o usuário pode receber dois e-mails e só o mais recente vale. Não foi alterado: cancelar linhas
  antigas exigiria um novo valor de `EmailDeadReason` (migration, fora de escopo) ou reaproveitar `EXPIRED` com semântica imprecisa. O link antigo mostra "inválido, expirado ou já utilizado".
- **`Retry-After`:** lido em 429/503/409 (segundos inteiros; datas são ignoradas). A espera até a próxima tentativa passa a ser `max(backoff, Retry-After)`, limitada a 15 min
  (`backoffMaxMs`). Se isso passar do `notAfter` da mensagem, ela expira sem novo envio.

### Como configurar (pendente de execução humana)

1. Criar conta no Resend, adicionar e verificar o domínio de envio (SPF e DKIM no DNS; publicar DMARC).
2. Gerar uma chave de API. Prefira uma com acesso de leitura de domínios para que a verificação na subida possa conferir o domínio; uma chave só de envio funciona, mas a subida apenas avisa.
3. Definir no ambiente do servidor (não no repositório): `NODE_ENV=production`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL` (https), `ALLOWED_ORIGINS` (https), `TRUST_PROXY`, `OUTBOX_ENCRYPTION_KEYS`, `OUTBOX_CURRENT_KEY_ID`.
4. Validar de ponta a ponta com uma conta real: cadastro → e-mail chega (caixa de entrada) → link verifica → criar empresa; reenvio; recuperação de senha; link expirado; e confirmar o comportamento do `Idempotency-Key`.

## Contas antigas (empresa criada sem e-mail verificado)

Definido sem apagar nem alterar dados e sem migration:
- A conta **continua dona** da empresa e a usa normalmente (agenda, serviços etc.). Nada é desativado.
- **Não cria outra empresa** (`403 EMAIL_NOT_VERIFIED`) até verificar; o reenvio da confirmação segue disponível pela faixa.
- **Não publica a página pública** (Etapa 14) até verificar: a regra está em `backend/src/modules/auth/email-policy.ts` (`emailPolicyAllows("org.public_page.publish", user)`),
  vale **sempre**, no servidor, independentemente de `REQUIRE_EMAIL_VERIFICATION` e do frontend. A rota de publicar da Etapa 14 **deve chamá-la**; ela ainda não existe.
- **Despublicar nunca exige verificação** (`org.public_page.unpublish`, adicionada à matriz do `OWNER`), para retirar a página do ar por segurança.

## Testes

Backend: `test/env.test.ts` (padrões, produção, provedor), `test/auth/email-gate.test.ts` (fluxo completo, expiração, reenvio,
contornos, dispensa), `test/auth/verification.test.ts` e `test/auth/recovery.test.ts` (tokens, uso único, expiração, concorrência,
rate limit), `test/email/resend.test.ts` (adaptador, classificação, verificação de configuração e subida com `fetch` falso), `test/email/outbox.test.ts` (chave de idempotência estável, `Retry-After`). Frontend: `src/test/auth.test.tsx`.

## Pendências

1. Entrega real de e-mails em produção (credenciais, domínio, SPF/DKIM/DMARC, entregabilidade, limites do plano): **não feita**.
2. Adaptador, verificação na subida, classificação de erros, `Idempotency-Key` e `Retry-After` seguem a documentação do Resend, mas **nada foi exercitado contra a API real**
   (nomes de erro, o 400 `validation_error` ambíguo, formato da chave, resposta de `GET /domains` e o efeito da idempotência precisam ser conferidos).
3. Etapa 14: a rota de publicar deve usar `emailPolicyAllows` (no servidor) e a de despublicar não deve exigir verificação.
4. Reenvios deixam na fila o e-mail anterior com link já inválido (ver "Idempotência e duplicatas").
5. Contas antigas sem verificação mantêm a empresa e o acesso; só deixam de criar outra e (Etapa 14) de publicar até verificar.
6. Duplicatas continuam possíveis enquanto a idempotência do Resend não for confirmada em produção.
