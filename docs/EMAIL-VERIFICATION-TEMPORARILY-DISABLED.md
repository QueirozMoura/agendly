# Confirmação de e-mail temporariamente dispensada (somente desenvolvimento)

> **Status: TEMPORÁRIO.** Destinado ao desenvolvimento e à validação local, enquanto o envio de e-mails (Resend) não está
> configurado. **Deve ser reavaliado e a exigência reativada antes da produção.**

## O que mudou

A única exigência de e-mail verificado que existia no backend era **criar empresa** (R10, `POST /api/organizations`,
erro `403 EMAIL_NOT_VERIFIED`). Cadastro, login, sessões, seleção de empresa e as demais rotas autenticadas **nunca**
exigiram verificação. A exigência agora é controlada por configuração do servidor:

| Variável (servidor) | Efeito |
|---|---|
| `REQUIRE_EMAIL_VERIFICATION` ausente | **Exigida em `NODE_ENV=production`; dispensada fora dela** (desenvolvimento e teste). |
| `REQUIRE_EMAIL_VERIFICATION=true` | Exigida (comportamento original, R10). |
| `REQUIRE_EMAIL_VERIFICATION=false` | Dispensada. **Em produção é recusada na inicialização** (`EnvError`). |

Não há bypass pelo cliente: a decisão vem de `loadEnv` → `buildApp({ auth.requireEmailVerification })` →
`organizationRoutes`; nenhum corpo, query, header ou cookie a influencia (há teste para isso). `buildApp` sem a opção
mantém o padrão seguro (exigido).

Para exigir também em desenvolvimento (por exemplo, ao testar o fluxo de e-mail), defina `REQUIRE_EMAIL_VERIFICATION=true` e reinicie o backend.

## O que foi preservado (nada removido)

Verificação por token (`/api/auth/verify-email`, `/api/auth/resend-verification`), outbox e sender de e-mail, `email_verified_at`,
a faixa "Confirme seu e-mail" e a página de verificação no frontend, recuperação de senha (continua por e-mail e,
sem Resend configurado, não entrega o link), schema e migrations.

## Testes

Backend: `test/env.test.ts` (padrões, produção, valor inválido), `test/org/organizations.test.ts` (usuário não verificado
cria empresa com a regra dispensada; `403 EMAIL_NOT_VERIFIED` continua no app estrito; sem sessão ⇒ 401; isolamento entre
empresas; header/query/corpo não alteram a regra). Frontend: sem alteração (a interface já depende só da resposta do servidor).

## A revisar quando o Resend for configurado (antes da produção)

1. Remover o padrão "dispensada fora de produção" em `backend/src/config/env.ts` (ou definir `REQUIRE_EMAIL_VERIFICATION=true` nos ambientes).
2. Configurar remetente, SPF/DKIM e `APP_BASE_URL`; validar verificação e recuperação de senha de ponta a ponta.
3. Texto da faixa em `frontend/src/components/AppLayout.tsx`: hoje diz que a confirmação é necessária para criar empresas, o que não vale enquanto dispensada.
4. Publicação da página pública (Etapa 14) deve exigir e-mail verificado (R10) independentemente desta variável; **a variável hoje só afeta criar empresa**.
5. Usuários criados sem verificar continuam com `email_verified_at` nulo; decidir como tratá-los.
