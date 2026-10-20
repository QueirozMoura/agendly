# Configuração do backend (segura por padrão)

A API **não sobe** com configuração ausente ou inválida; a mensagem lista só os NOMES das variáveis, nunca valores.
Fonte: `backend/src/config/env.ts`. Exemplo comentado: `.env.example`.

## `NODE_ENV` (obrigatório, sem padrão)

| Valor | Uso | Efeito |
|---|---|---|
| `development` | desenvolvimento local | cookie sem `Secure`, origem padrão do Vite, chave de outbox pública, e-mail no console |
| `test` | testes automatizados | idem (o vitest define sozinho) |
| `production` | produção | cookie `Secure` + `__Host-`, `ALLOWED_ORIGINS`, chaves da outbox, `TRUST_PROXY` e provedor de e-mail **obrigatórios**; verificação de e-mail sempre exigida |

Ausente, vazio ou com outro valor (`prod`, `Production`, `staging`…) ⇒ erro na inicialização. Antes, a ausência virava
`development` em silêncio (cookie sem `Secure`, chave pública, verificação dispensada).

Scripts: `npm run dev -w backend` define `NODE_ENV=development`. `npm start -w backend` **não** define: em produção
exporte `NODE_ENV=production` no ambiente do processo. (Um `.env` antigo sem `NODE_ENV` precisa da linha `NODE_ENV=development`
para usar `npm start` localmente.)

## `TRUST_PROXY` (de onde vem `req.ip`, base de todos os rate limits)

| Valor | Quando usar |
|---|---|
| `false` | API alcançada direto, sem proxy (desenvolvimento). Padrão fora de produção. |
| `1` a `10` | **Número** de proxies confiáveis à frente da API (Caddy/Nginx/balanceador = `1`). |
| `10.0.0.0/8,127.0.0.1` | Alternativa: lista de IPs/CIDRs dos proxies confiáveis. |
| `true` | **Recusado.** |

- **Produção: obrigatório** (declarar `false` ou o nº de proxies). Esquecê-lo atrás de um proxy faria todos os clientes dividirem
  o IP do proxy, e com ele os limites de login/cadastro (bloqueio coletivo).
- **Por que não `true`:** confiaria em qualquer `X-Forwarded-For`; o cliente forjaria o IP e fugiria do rate limit.
  Com um número de saltos, o IP é lido da **direita** do cabeçalho (o que o proxy anexou); entradas forjadas à esquerda são ignoradas.
  Com lista, o cabeçalho só vale se a conexão vier de um proxy listado.
- **Requisitos de infraestrutura:** o proxy deve anexar/sobrescrever `X-Forwarded-For` e a API **não** pode ser alcançável
  sem passar por ele (firewall/rede privada). Conferir o nº de saltos reais (CDN + proxy = 2).
- Testes: `backend/test/env.test.ts` (parsing) e `backend/test/auth/trust-proxy.test.ts` (IP forjado ignorado; o limite
  continua valendo trocando o `X-Forwarded-For` a cada pedido).

## E-mail (`REQUIRE_EMAIL_VERIFICATION`, `RESEND_API_KEY`, `EMAIL_FROM`)

- `REQUIRE_EMAIL_VERIFICATION`: exigida por padrão em todos os ambientes; `false` só fora de produção (em produção a API não sobe).
- `RESEND_API_KEY` + `EMAIL_FROM`: obrigatórios em produção; sem eles, fora de produção, o e-mail vai para o console.
  Formatos validados em qualquer ambiente (chave `re_…`; remetente `x@dominio.tld` ou `Nome <x@dominio.tld>`).
  Em produção, a subida consulta o Resend (`GET /domains`) e falha se a chave for recusada ou o domínio do remetente não estiver verificado.
- Produção exige **HTTPS** em `ALLOWED_ORIGINS` (inclusive `localhost`) e em `APP_BASE_URL`; desenvolvimento e teste seguem aceitando HTTP local.
- Entrega real **não validada**. Guia completo e pendências: [`EMAIL-VERIFICATION.md`](EMAIL-VERIFICATION.md).

## Limitação conhecida
O rate limit é em memória: vale por instância e zera ao reiniciar. Com mais de uma instância, o limite efetivo é multiplicado.
