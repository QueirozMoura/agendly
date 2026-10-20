# Etapa 11 — Frontend base

> Status: **correções da revisão final aplicadas (seção 8); para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado. Nenhuma validação `[VALIDAR]` mudou de estado.
> Sem commit e sem push. Conferido antes de começar: Etapa 10 commitada e enviada (`832dd10` = `origin/main`), árvore limpa.

## 1. Escopo (seção 11 do plano)

"Vite + React Router + cliente HTTP único; telas pt-BR de registro, login, verificação, recuperação de senha, seletor de empresa, layout protegido."
Aceite: "fluxo completo contra o backend local (navegador headless); 401/409 tratados centralmente; testes de componente nos fluxos de auth; nenhum token em `localStorage`."

Dependências: contratos de autenticação (Etapas 4–5: cookie de sessão HttpOnly, CSRF por `Origin` + `Content-Type: application/json`, links de e-mail
`/verificar-email#token=` e `/redefinir-senha#token=`), empresas (Etapa 6: `X-Active-Org`, empresa ativa por slug) e o tratamento global de erros (Etapas 9–10).

**Fora do escopo (continua pendente):** painel de serviços/profissionais/disponibilidade (Etapa 12), agenda (13), página pública (14), endurecimento/CI (15), deploy (16).

## 2. O que foi implementado

| Área | Arquivos (`frontend/`) | Resumo |
|---|---|---|
| Infra | `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles.css` | Vite + React 19 + TypeScript estrito; `server.host = localhost:5173` (a origem que o backend aceita por padrão) com **proxy de `/api` → `127.0.0.1:3000`**; scripts `dev`, `build`, `preview`, `typecheck`, `test`. |
| Cliente HTTP único | `src/api/client.ts`, `types.ts`, `ApiContext.tsx` | Cookie da mesma origem; `Content-Type: application/json` em **toda** escrita (inclusive `{}`), `X-Active-Org: <slug>` quando há empresa ativa; erro tipado `ApiError` (`code`, `message`, `details`, `requestId`, `Retry-After`); falha de rede/corpo não-JSON ⇒ mensagem genérica pt-BR (nunca vaza detalhes técnicos). |
| Tratamento **central** | `client.ts` + `src/app.tsx` | **401** em rota autenticada ⇒ volta ao login com aviso "Sua sessão terminou"; **409 `ACTIVE_ORG_CHANGED`** ⇒ recarrega o app; **403 `NO_ACTIVE_ORGANIZATION`/`ORGANIZATION_ACCESS_REVOKED`** ⇒ relê as empresas e o guarda leva ao seletor. O erro é lançado marcado `handled` para a tela não exibi-lo duas vezes. Rotas anônimas (login, cadastro, recuperação, verificação e o `/api/me` inicial) usam `anonymous: true`: um 401 ali **não** é "sessão expirada". |
| Autenticação | `src/features/auth/*` | `AuthContext` (usuário só em memória, vindo de `GET /api/me`), `LoginPage`, `RegisterPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `VerifyEmailPage`, validação de conveniência com Zod (`schemas.ts`). Token do e-mail lido do **fragmento**, mantido só em memória e **removido da barra de endereço/histórico**. |
| Empresas | `src/features/organizations/*` | `OrganizationContext` (lista + empresa ativa por slug), `OrganizationSelectPage` (escolher, **criar empresa** com endereço sugerido a partir do nome e fuso IANA com aviso de imutabilidade). |
| Casca protegida | `src/components/*`, `src/routes/*` | `RequireAuth`, `RequireOrganization`, `PublicOnly`, `AppLayout` (empresa ativa, troca de empresa, aviso e reenvio de confirmação de e-mail, sair), `PublicLayout`, `HomePage` (lê `GET /api/organization`, rota `tenant`), 404. |

Rotas do SPA: `/entrar`, `/cadastro`, `/esqueci-senha`, `/redefinir-senha`, `/verificar-email` (estas duas **fixas**: são as que os e-mails da Etapa 5 já usam), `/empresas`, `/` (exige empresa ativa), `*` ⇒ 404.

## 3. Decisões técnicas e divergências (a aprovar)

1. **Dependências novas** (versões exatas, padrão do repositório; `npm audit`: 0 vulnerabilidades; `npm ls` sem inconsistências). Cada uma tem necessidade demonstrada pelo plano:

   | Pacote | Versão | Por quê |
   |---|---|---|
   | `react`, `react-dom` | 19.3.1 | stack aprovada |
   | `react-router` | 8.5.0 | "React Router" no plano (modo declarativo) |
   | `zod` | 4.6.7 | "Validação Zod de conveniência" no frontend (seção 1); mesma versão do backend |
   | `vite`, `@vitejs/plugin-react` | 8.3.4 / 6.1.2 | bundler/dev server do plano (o Vite 8.3.4 já vinha transitivamente do Vitest) |
   | `@types/react`, `@types/react-dom` | 19.3.0 | tipos |
   | `@testing-library/react`, `/dom`, `/user-event`, `/jest-dom` | 16.3.3 / 10.4.1 / 14.6.8 / 7.0.1 | "Testing Library + MSW" (seção 7) |
   | `msw` | 3.0.3 | idem |
   | `jsdom` | 30.1.3 | ambiente DOM do Vitest |

   Não foram adicionados: biblioteca de UI/CSS, biblioteca de formulários, cliente de dados (React Query etc.), plugin de lint do React, Playwright.
2. **Criar empresa dentro do seletor.** O plano lista só o "seletor de empresa", mas sem poder criar a primeira empresa um usuário novo não passaria do seletor (o contrato `POST /api/organizations` já existe, Etapa 6). Mantive o formulário mínimo (nome, endereço, fuso). *Aprovar ou retirar.*
3. **Sessão nova sempre começa sem empresa ativa** (comportamento do backend, 4.1): mesmo com uma única empresa, o usuário a escolhe no seletor depois do login. Não implementei seleção automática (esconderia uma decisão; é uma linha de código se aprovada).
4. **Tratamento central também de 403 sem empresa ativa** (além de 401/409 pedidos no aceite), porque `RequireOrganization` precisa reagir se a membership for perdida com o painel aberto.
5. **A confirmação de e-mail exige um clique em "Confirmar e-mail"** (revisão final, seção 8): abrir o link não consome o token, então um verificador de links que renderize a página não gasta o token de uso único.
6. **Validação local é só conveniência**: e-mail (normalizado para minúsculas), nome, tamanho da senha (10–128), formato do endereço. A lista de senhas comuns, endereços reservados e unicidade só o servidor conhece; erros `400 VALIDATION_ERROR` com `details` são mapeados para os campos.
7. **`tsconfig` do frontend** usa `moduleResolution: Bundler` e imports sem extensão (convenção do Vite), diferente do backend (`NodeNext` + `.ts`). `lib: DOM`. Sem `types: node` além do necessário para os testes.
8. **Backend não foi alterado** (nenhum arquivo em `backend/`, nenhuma migration, nenhum schema).

## 4. Testes e verificações (resultados reais)

| Verificação | Resultado |
|---|---|
| `npm test` (raiz, **uma execução**, backend + frontend) | frontend **109 testes em 6 arquivos**; backend **693 testes em 44 arquivos**; todos passando (reexecutados após as correções da seção 8) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | 0 erros (backend e frontend) |
| `npm run format:check` | "All matched files use Prettier code style!" |
| `git diff --check` | exit 0 |
| `npm run db:drift` | "No difference detected." |
| `npm run build -w frontend` | sucesso (`dist/` fora do Git): 209 módulos, JS 363 kB (112 kB gzip), CSS 3,6 kB |
| `npm audit` | 0 vulnerabilidades |

### Testes de componente e unitários (`frontend/src/test`, Testing Library + MSW) — **sintéticos**
O backend falso (`fakeBackend.ts`) reproduz caminhos, códigos e mensagens reais **e** a regra de CSRF (415 sem `Content-Type` JSON em escrita), mas **não é** o backend: não exercita cookies, `Origin` nem o proxy.

| Arquivo | Testes | Cobre |
|---|---|---|
| `api.test.ts` | 13 | cabeçalhos, `{}` em escrita, `X-Active-Org`, 204, cancelamento (AbortSignal), envelope de erro e `Retry-After`, corpo não-JSON/5xx/rede, **401/409/403 centrais** (inclusive o que NÃO deve acionar o tratador) |
| `auth.test.tsx` | 30 | proteção de rotas e retorno (`from`), login (erro, validação local, normalização, duplo clique), cadastro (validação, mensagem do servidor, `400` mapeado ao campo), verificação (StrictMode, uma só chamada, token fora da URL, inválido, ausente, usuário logado), recuperação e redefinição, sair, reenvio |
| `organizations.test.tsx` | 16 | seletor, escolha por slug, `X-Active-Org`, criação (slug sugerido sem acentos, validação, `SLUG_UNAVAILABLE`, e-mail não confirmado), troca pelo cabeçalho |
| `central.test.tsx` | 6 | **401 no meio da sessão**, aviso de sessão terminada (e que o `/api/me` inicial não o gera), **409 `ACTIVE_ORG_CHANGED` ⇒ recarrega uma vez sem erro**, 403 sem empresa ativa, falha de rede sem detalhes técnicos |
| `redirect.test.tsx` | 42 | destino `from` do login (unitário + componente) |
| `no-storage.test.ts` | 4 | **estático**: o código de produção não referencia `localStorage`, `sessionStorage`, IndexedDB, `document.cookie` nem Cache API (e o detector acusa o uso proibido); sem import do backend; sem URL fixa |

Regra **dinâmica** para todos os testes (`setup.ts`): ao fim de cada teste, `localStorage` e `sessionStorage` precisam estar vazios (aceite "nenhum token em localStorage").
**Mutações** (revertidas): desligar o tratador de 401 derrubou 2 testes; desligar o recarregamento do 409 derrubou 1. O teste de cancelamento revelou um bug real do cliente (o `AbortError` de outro "realm" não era reconhecido e virava erro de rede), já corrigido.

### Fluxo completo contra o backend local em navegador headless — **integração real**
Backend real (`node src/server.ts`, banco de desenvolvimento `agendly`) + Vite (`localhost:5173`, proxy de `/api`) + navegador headless (Chromium via a skill `browser-automation` do ambiente; **não** é um teste do repositório: E2E automatizado está fora do MVP, seção 12, e nenhuma dependência de E2E foi adicionada). O token dos e-mails foi lido do log do `ConsoleEmailSender` (único canal em desenvolvimento). Resultados (todos **OK**):

1. anônimo em `/` ⇒ `/entrar`; 2. cadastro (mensagem do servidor); 3. login com e-mail não confirmado ⇒ `/empresas` com aviso; 4. criar empresa sem confirmar ⇒ recusado pelo servidor (`EMAIL_NOT_VERIFIED`);
5. link do e-mail (`#token=`) confirma e o **token sai da barra de endereço**; o aviso some; 6. criar empresa (endereço sugerido, fuso) ⇒ painel (`GET /api/organization` com `X-Active-Org`); 7. **recarregar a página** mantém sessão e empresa ativa;
8. `localStorage`/`sessionStorage` vazios e `document.cookie` vazio (cookie HttpOnly); 9. sair e rota protegida volta ao login; 10. recuperação de senha ⇒ redefinir com o token do e-mail (fora da URL) ⇒ senha antiga deixa de valer ⇒ login com a nova ⇒ sessão nova **sem** empresa ativa (seletor) ⇒ escolher abre o painel;
11. token de reset é de uso único (`400` ao reutilizar). Segunda rodada com **duas abas** (mesma sessão): a aba B troca a empresa ativa; a aba A, ao abrir o painel, recebe **409 `ACTIVE_ORG_CHANGED`**, **recarrega** e passa a mostrar a empresa certa, sem alerta; depois a aba B sai e a aba A, ao agir, recebe **401** e cai no login com "Sua sessão terminou".
Os `console.error` registrados nessas rodadas são exatamente as respostas 401/403/409/400 provocadas de propósito (HTTP, não exceções JavaScript).
Isso exercitou, pela primeira vez, o `Origin` real do navegador com o CSRF do backend, o cookie `HttpOnly` pelo proxy e o StrictMode do desenvolvimento.

## 5. Garantias relevantes
- **Isolamento/tenant:** o cliente nunca envia `organizationId` (só o **slug**, em `POST /api/session/active-organization` e em `X-Active-Org`); os tipos do contrato não têm campo de id interno; a autorização continua 100% no servidor (o front só espelha).
- **Sessão:** só cookie HttpOnly; nenhum token, senha ou e-mail em armazenamento do navegador (verificado estática, dinâmica e no navegador real). Tokens de link vivem só em memória e saem da URL.
- **Erros:** mensagens pt-BR do servidor são mostradas; falhas inesperadas, de rede ou de proxy usam texto genérico, sem SQL, stack ou detalhes de outras empresas.
- **Backend, banco, locks, idempotência:** intactos (nenhuma alteração em `backend/`).

## 6. Limitações, riscos e itens pendentes
- **Dados de teste no banco de desenvolvimento `agendly`:** a verificação headless criou 3 usuários `e2e-<timestamp>@example.com` (e-mails confirmados) com suas empresas (`Salão E2E`, `Segunda Empresa`). Não foram apagados (operação destrutiva; os pais não têm `DELETE`, R-c). Os testes automatizados usam `agendly_test`.
- O fluxo headless **não é repetível por CI** (depende de ler o token no log e de um navegador local). Automatizá-lo seria Etapa 15 (CI) e exigiria decidir a ferramenta (Playwright) e uma forma de capturar e-mails.
- O backend falso pode divergir do real com o tempo; a mitigação hoje é o teste headless manual. Testes de contrato (gerar o backend falso a partir do real) ficam como sugestão.
- Verificação visual **não** realizada: não olhei capturas de tela; o CSS (responsivo, modo escuro) foi escrito mas não conferido em vários tamanhos/navegadores. Só Chromium headless foi usado (Firefox está instalado e não foi testado). Acessibilidade: rótulos, `aria-invalid`/`aria-describedby`, `role=alert|status` e teclado básico via Testing Library; sem auditoria dedicada.
- Sem página de erro global (error boundary), sem tela de "alterar senha" nem "sair de todos os dispositivos" (o backend tem `logout-all`; não está no plano desta etapa), sem contagem regressiva para 429 (mostra a mensagem do servidor).
- `HomePage` é só um resumo da empresa; conteúdo do painel é das Etapas 12–13.
- Lista de fusos vem de `Intl.supportedValuesOf` (depende do navegador); o servidor valida de novo.
- Servir o `dist/` em produção (Caddy, mesma origem) não foi exercitado (Etapa 16); `npm run build` passa.
- `[VALIDAR]` V9–V12 e V14 continuam **não verificados**; nada desta etapa os afeta.

## 7. Atualização documental sugerida ao `ARCHITECTURE.md` (NÃO aplicada)
- Seção 2: registrar `frontend/src/{api,features,components,routes,test}` como implementado e as dependências da tabela acima.
- Seção 11 (Etapa 11): acrescentar as rotas do SPA e a decisão de incluir "criar empresa" no seletor (se aprovada).
- Seção 7: registrar que o teste do fluxo completo em navegador foi feito manualmente (headless) nesta etapa e que sua automação fica para a Etapa 15.

## 8. Revisão final: problemas encontrados e correções aplicadas

Auditoria (segurança, UX, inspeção visual real em desktop 1280×800 e celular 375×812, claro e escuro, com capturas lidas) encontrou 2 problemas médios e 3 baixos; **nenhum impedia o aceite**. Foram corrigidos todos, mais **dois defeitos descobertos durante as correções**. Só `frontend/` e este documento mudaram; `backend/`, migrations, banco e contratos da API ficaram intactos.

| # | Gravidade | Problema | Correção (arquivos em `frontend/src`) |
|---|---|---|---|
| 1 | Média | Falha ao listar empresas aparecia como "Você ainda não tem nenhuma empresa" | `OrganizationContext.tsx` ganhou `status: "error"`, `loadError` e `retry()`; só um `200` com lista vazia é "vazio". `components/LoadError.tsx` (mensagem + "Tentar novamente") é usado no seletor e em `RequireOrganization`, que **não redireciona** a `/empresas` sem confirmação do servidor. No seletor com erro não se oferece criar empresa. |
| 2 | Média | Confirmação de e-mail consumida ao abrir a página | `VerifyEmailPage.tsx`: botão explícito **"Confirmar e-mail"**; nada é enviado antes do clique (clique duplo = 1 requisição; progresso "Confirmando…"). Token inválido/expirado/usado ⇒ mensagem do servidor + "se já confirmou, entre"; falha transitória (rede, 429, 5xx) ⇒ "Tentar novamente" (o token segue válido). O token continua só em memória e o fragmento sai da URL/histórico. |
| 3 | Baixa | F5 depois de confirmar mostrava "link incompleto" | Ao confirmar, a página grava `{ emailVerified: true }` no **estado do histórico** (`navigate(..., { replace, state })`), que sobrevive ao recarregamento; a mensagem de "sem token" agora diz "incompleto **ou já foi usado**" e orienta a entrar. |
| 4 | Baixa | Aviso de e-mail duplicado em `/empresas` | Removido o aviso interno do formulário; fica a faixa da casca (`AppLayout`), útil em todas as telas autenticadas. |
| 5 | Baixa | `from` do login só checava `startsWith("/")` | `features/auth/redirect.ts` (`safeInternalPath`): rejeita `//…`, `\`, caracteres de controle/tab, esquemas (`https:`, `javascript:`, `data:`), valores que não são texto e qualquer destino que, resolvido, saia da origem; mantém caminhos internos (com query e hash). Usado em `LoginPage` e em `PublicOnly`. |
| 6 | **Média (achado novo)** | `PublicOnly` mandava **sempre a "/"** assim que o login concluía, atropelando o retorno à página que o usuário tentava abrir (`from`). O teste antigo passava por coincidência (sem empresa ativa, "/" redireciona a `/empresas`). | `components/guards.tsx`: `PublicOnly` navega para o mesmo destino seguro. Efeito visível: depois de um 401 no meio da sessão, o novo login volta à página onde a sessão terminou (o teste de `central.test.tsx` foi atualizado para esse comportamento correto). |
| 7 | Baixa (achado novo) | Abrir um link novo do e-mail na **mesma aba** em que a página já estava aberta (só o `#` muda, sem remontar) ignorava o token. Visto no navegador real. | `VerifyEmailPage.tsx` e `ResetPasswordPage.tsx` adotam o token a cada mudança do fragmento e o removem da URL. |

### Testes adicionados (109 no frontend; eram 55)
- **Lista de empresas:** erro HTTP (503) e de rede (mensagem pt-BR sem detalhe técnico), sem a frase de lista vazia e sem formulário de criação; "Tentar novamente" com sucesso; nova falha continua em erro; **lista realmente vazia (200 com `[]`)** mostra o estado vazio; no painel `/` a falha não redireciona e se recupera.
- **Confirmação de e-mail (8):** abrir o link não envia nada (nem em StrictMode, e o token continua válido), clique envia uma vez, clique duplo, progresso, inválido/expirado sem repetir, 503 com nova tentativa, sem token, **recarregar depois de confirmar** (via estado do histórico), usuário logado (aviso some), **novo link na mesma aba**.
- **Reset:** novo link na mesma aba.
- **Aviso duplicado:** exatamente uma ocorrência em `/empresas` e o servidor ainda recusa a criação.
- **`from` (42):** válidos (`/`, `/empresas`, com query, com hash), inválidos (`//host`, `///`, `/\host`, `\\host`, tab/quebra de linha, controle, `https:`, `javascript:`, `data:`, `mailto:`, sem barra, vazio, espaço, enorme), não-texto e invariante de mesma origem; no componente: destino válido respeitado e `//evil.com`, `https://…`, `/\…`, `javascript:`, `evil.com` e objeto ignorados.
- **Mutações (revertidas):** desligar a adoção do novo token derrubou o teste da mesma aba; fazer `PublicOnly` voltar a "/" derrubou o teste de destino.

### Verificações executadas após as correções
| Verificação | Resultado |
|---|---|
| Testes do frontend | **109 passando em 6 arquivos** |
| Testes do backend (suíte completa, reexecutada) | **693 passando em 44 arquivos** |
| lint | sem erros |
| typecheck | 0 erros |
| `format:check` | passou |
| `npm run build -w frontend` | sucesso |
| `git diff --check` | exit 0 |
| `db:drift` | "No difference detected." (somente leitura) |
| `npm audit` | 0 vulnerabilidades |
| **Navegador headless real** (backend real + Vite) | abrir o link não dispara POST; F5 antes de clicar mostra "incompleto ou já foi usado"; clique confirma com 1 POST; **F5 depois de confirmar mantém o sucesso**; token já usado ⇒ mensagem + orientação; login volta a `/empresas`; **0 avisos de e-mail** em `/empresas` com a conta verificada; listagem com 503 ⇒ "O sistema está ocupado…" + "Tentar novamente" e **sem** "nenhuma empresa"; com o servidor ok a nova tentativa mostra a lista vazia de verdade |

### Pendências que continuam
- Banco de desenvolvimento: usuários `e2e-*` e empresas criados pelas verificações headless (agora mais um usuário da rodada de revisão) **não foram apagados**.
- Inspeção visual só com Chromium headless, sem auditoria formal de acessibilidade/contraste; título da aba é sempre "Agendly"; sem error boundary global.
- Teste de ponta a ponta continua manual (automação na Etapa 15). Nenhum `[VALIDAR]` mudou de estado.
