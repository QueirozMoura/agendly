<div align="center">

# Agendly

**Plataforma multiempresa de agendamento para negócios de atendimento: agenda, clientes, serviços, profissionais e confirmação pelo WhatsApp em um único painel.**

![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![Vitest](https://img.shields.io/badge/testes-Vitest-6E9F18?logo=vitest&logoColor=white)

[Visão geral](#visão-geral) ·
[Funcionalidades](#funcionalidades) ·
[Stack](#stack-tecnológica) ·
[Arquitetura](#arquitetura) ·
[Decisões de engenharia](#desafios-técnicos-e-decisões-de-engenharia) ·
[Execução local](#instalação-e-execução-local) ·
[Testes](#testes-e-qualidade) ·
[Deploy](#deploy) ·
[Limitações](#limitações-e-próximos-passos)

</div>

---

## Visão geral

Pequenos negócios que vivem de hora marcada (clínicas, estúdios, barbearias, consultórios) costumam controlar a agenda em
cadernos, planilhas e conversas de WhatsApp. O resultado são horários sobrepostos, clientes duplicados e confirmações feitas
à mão.

O **Agendly** centraliza esse fluxo em um painel web. O proprietário cria sua empresa, cadastra serviços (duração, buffer e
preço), profissionais, horários de trabalho e folgas, e passa a marcar atendimentos para os clientes. O sistema calcula os
horários livres, impede conflitos e prepara a mensagem de confirmação para ser enviada pelo WhatsApp.

- **Público-alvo:** o dono (ou responsável) de um negócio de atendimento. No estado atual, o proprietário é o único papel
  operacional; profissionais e clientes não têm conta.
- **Multiempresa:** um mesmo usuário pode ser proprietário de várias empresas, com dados isolados entre elas.
- **Idioma:** interface em português brasileiro.

> **Demonstração em produção:** o frontend está publicado na Vercel e a API no Render (ver [Deploy](#deploy)). O endereço
> público da aplicação não está registrado no repositório, por isso não é listado aqui.

## Funcionalidades

| Área                      | O que existe                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contas e autenticação** | Cadastro, login e logout; sessão por cookie `HttpOnly`; "sair de todos os dispositivos"; limite de tentativas por IP e por e-mail.                                                            |
| **Verificação e senha**   | Verificação de e-mail (exigida para criar empresa), reenvio, recuperação e redefinição de senha com token de uso único.                                                                       |
| **Organizações**          | Criar empresa (nome, slug, fuso horário IANA), listar as empresas do usuário, trocar a empresa ativa, editar configurações. O fuso horário é definido na criação.                             |
| **Clientes**              | Listagem e edição. Clientes são identificados pelo telefone (E.164) dentro da empresa e criados/reaproveitados ao agendar.                                                                    |
| **Profissionais**         | Cadastro, edição e vínculo com os serviços que cada um atende.                                                                                                                                |
| **Serviços**              | Cadastro com duração, buffer pós-atendimento e preço opcional; ativação/desativação.                                                                                                          |
| **Disponibilidade**       | Horários de trabalho semanais e folgas por profissional; consulta de horários livres em grade de 15 minutos.                                                                                  |
| **Agendamentos**          | Criar, listar por período, remarcar, confirmar, concluir, marcar falta, cancelar e reativar. Status: `SCHEDULED`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`.                           |
| **WhatsApp (manual)**     | A agenda gera a mensagem de confirmação e abre o WhatsApp com o texto preenchido; o envio é feito pelo próprio usuário. **Não há integração com a API oficial do WhatsApp.**                  |
| **E-mails**               | Fila persistente no banco (outbox) com payload cifrado, retentativas com backoff e envio via [Resend](https://resend.com). Em desenvolvimento, sem provedor, o e-mail é impresso no terminal. |
| **Tema e interface**      | Tema claro, escuro ou do sistema (preferência salva no navegador), landing page responsiva e painel autenticado.                                                                              |

## Demonstração visual

<!--
  Ainda não há capturas de tela versionadas no repositório. Para adicioná-las, salve as imagens (dados fictícios) em
  docs/screenshots/ e referencie-as aqui, por exemplo:

  | Landing page | Agenda |
  | :---: | :---: |
  | ![Landing page](docs/screenshots/landing.png) | ![Agenda](docs/screenshots/agenda.png) |
-->

_Capturas de tela serão adicionadas em `docs/screenshots/` (landing page, agenda, clientes, serviços e profissionais, tema
claro e escuro)._

## Stack tecnológica

Versões conforme os `package.json` (dependências fixadas sem `^`).

| Camada                     | Tecnologias                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**               | React 19.3, React Router 8.5, TypeScript 6.0, Vite 8.3, Zod 4.6                                                             |
| **Backend**                | Node.js 24 (execução direta de TypeScript, sem etapa de build), Fastify 5.12, Zod 4.6, date-fns 4.4 + date-fns-tz 3.2, uuid |
| **Banco de dados**         | PostgreSQL (18.6 no `docker-compose.yml`), Prisma 7.10 com `@prisma/adapter-pg`, SQL manual nas migrations (constraints)    |
| **Autenticação/segurança** | Sessões em banco com cookie `HttpOnly`, Argon2id (`crypto.argon2` nativo do Node), `@fastify/cookie`, `@fastify/rate-limit` |
| **Testes e qualidade**     | Vitest 5, Testing Library, MSW 3 e jsdom (frontend), ESLint 10, typescript-eslint, Prettier 3.9                             |
| **Infraestrutura**         | Vercel (frontend + rewrite da API), Render (API), PostgreSQL gerenciado, Resend (e-mail), Docker Compose (PostgreSQL local) |

## Arquitetura

Monólito modular em um monorepo npm (workspaces `frontend` e `backend`). A SPA fala apenas com a API REST sob `/api`; em
produção a Vercel reescreve `/api/*` para o backend, de modo que o navegador enxerga uma única origem.

```mermaid
flowchart LR
    U[Navegador<br/>React SPA] -->|/api/*| V[Vercel<br/>rewrite]
    V --> API
    subgraph API[Backend Fastify]
        direction TB
        P[Plugins<br/>CSRF · tenant · erros · rate limit]
        M[Módulos<br/>auth · organizations · services · professionals<br/>availability · customers · appointments]
        J[Jobs no mesmo processo<br/>outbox de e-mail · manutenção]
        P --> M
    end
    M --> DB[(PostgreSQL<br/>Prisma)]
    J --> DB
    J -->|API HTTP| R[Resend]
    U -.->|abre wa.me com a mensagem| W[WhatsApp<br/>envio manual]
```

**Organização do backend** (`backend/src`): cada módulo em `modules/<nome>` segue `routes.ts` (HTTP e validação Zod) →
`service.ts` (regras de negócio) → acesso a dados em `lib/db`. `plugins/` contém CSRF, resolução de tenant, tratamento de
erros e registro de rotas; `jobs/` contém o worker da outbox e a manutenção; `lib/` reúne tempo, e-mail, criptografia e banco.

**Organização do frontend** (`frontend/src`): `features/` por domínio (agenda, auth, availability, landing, organizations,
professionals, services), `components/` compartilhados, `api/` com cliente e tipos do contrato, `hooks/` e `lib/` utilitários.

**Persistência.** Prisma 7 com adapter `pg`. Colunas de tempo são `timestamptz` (UTC); cada empresa tem um fuso IANA usado
para converter horários locais. IDs são UUID gerados pela aplicação.

**Autenticação.** Sessão no servidor, não JWT: o cookie guarda um token aleatório e somente o hash vai para a tabela
`sessions`. Em produção o cookie usa `Secure` e o prefixo `__Host-`.

**Isolamento de dados.** O servidor determina a empresa ativa a partir da sessão e da membership; o cliente nunca envia um
`organizationId` para obter acesso. As tabelas filhas têm chave estrangeira composta com `organization_id`.

**Integrações externas.** Resend (e-mail) por trás de uma interface `EmailSender`, e WhatsApp via link com texto preenchido.

## Desafios técnicos e decisões de engenharia

### Conflito de horários garantido pelo banco

- **Problema:** dois pedidos simultâneos para o mesmo profissional e horário podem passar por uma checagem feita só na aplicação.
- **Solução:** a tabela `appointments` tem uma _exclusion constraint_ GiST sobre `(organization_id, professional_id, tstzrange(starts_at, blocked_until, '[)'))`, restrita aos status ativos (`SCHEDULED`, `CONFIRMED`). O intervalo inclui o buffer do serviço e `[)` permite atendimentos que apenas se encostam. Há ainda `CHECK`s que obrigam `ends_at` e `blocked_until` a serem coerentes com os _snapshots_ de duração e buffer.
- **Benefício:** mesmo que a aplicação falhe em verificar, o banco rejeita a sobreposição (`23P01`). Existem testes de concorrência e de estresse em `backend/test/appointments/`.

### Locks explícitos com ordem global

- **Problema:** regras que o banco não expressa (agendamento × folga/horário de trabalho, clientes e profissionais compartilhados entre pedidos) exigem bloqueios, e bloqueios em ordem arbitrária causam _deadlocks_.
- **Solução:** `backend/src/lib/db/locks/` centraliza `SELECT … FOR NO KEY UPDATE` em uma hierarquia fixa (cliente → profissionais ordenados por id → idempotência → escritas; e, na autenticação, usuário → tokens → sessões → outbox). Um _guard_ rejeita aquisições fora de ordem antes de enviar a consulta, e as transações têm _lock timeout_.
- **Benefício:** a ordem é verificada por código e por testes (`backend/test/locks/`), e não depende de disciplina de quem escreve a próxima rota.

### Idempotência na criação de agendamentos

- **Problema:** repetir a requisição (clique duplo, falha de rede) não deve gerar dois agendamentos.
- **Solução:** a criação exige o cabeçalho `Idempotency-Key` (UUID). O resultado é persistido por empresa e escopo; repetir o mesmo pedido devolve a mesma resposta com `Idempotent-Replay: true`, e reutilizar a chave com um pedido diferente retorna `409`. Registros expirados são removidos pela rotina de manutenção.

### Disponibilidade e fuso horário

- **Solução:** `availability/slots.ts` gera inícios em grade de 15 minutos no horário local da empresa, descontando agendamentos ativos e folgas, e exigindo que o atendimento caiba no expediente (o buffer pode ultrapassar o expediente). Alterações de horário ou folga que conflitem com agendamentos futuros ativos são recusadas, com a lista dos conflitos; nada é cancelado automaticamente. A conversão de fuso fica restrita ao módulo `lib/time`, com `Clock` injetável para testar regras de data.

### Isolamento entre empresas

- **Solução:** chaves estrangeiras compostas `(organization_id, id)`, plugin de tenant que resolve a empresa pela sessão, matriz de permissões `can(role, action)` que nega por padrão e retorna `404` para recursos de outra empresa (inexistente e alheio são indistinguíveis). Testes de isolamento em `backend/test/org/` e regras estáticas que vigiam o uso do cliente de banco.

### Autenticação e sessões

- **Solução:** senhas com Argon2id e verificação contra lista de senhas comuns; token de sessão aleatório com apenas o hash persistido; coluna `credentials_version` comparada a cada requisição, de modo que trocar a senha invalida sessões existentes inclusive diante de logins concorrentes; recuperação de senha com token de uso único consumido de forma atômica; resposta idêntica para e-mail existente e inexistente; CSRF por `SameSite=Lax`, verificação de `Origin` e exigência de `Content-Type: application/json`; rate limit por IP e por e-mail. `TRUST_PROXY` recusa `true` para impedir IP forjado via `X-Forwarded-For`.

### E-mail com outbox transacional

- **Solução:** a mensagem é gravada na tabela `email_outbox` na mesma transação que cria o token, com o payload cifrado (AES-256, chaves com identificador para rotação). Um worker faz _claim_ com _lease_, tenta de novo com backoff exponencial e jitter e marca como morta após o limite de tentativas. A entrega é _at-least-once_: um e-mail duplicado é possível em certas falhas, e isso está documentado.

### Confirmação manual pelo WhatsApp

- **Solução:** `frontend/src/lib/whatsapp.ts` apenas monta o texto (cliente, serviço, data e hora no fuso da empresa) para agendamentos ativos e futuros; não envia, não persiste e não altera o status. O usuário revisa e envia pelo próprio WhatsApp, o que evita depender da API oficial e de aprovação de templates.

### Tratamento de erros e configuração segura

- Erros da API têm `code` estável e `message` em português. A API **não sobe** com configuração ausente ou inválida (`NODE_ENV` é obrigatório e sem padrão; produção exige `ALLOWED_ORIGINS`, chaves da outbox, `TRUST_PROXY` e provedor de e-mail). O frontend não guarda token nem dado pessoal no navegador; a única exceção é a preferência de tema, com teste que vigia isso.

## Estrutura do projeto

```text
agendly/
├── backend/
│   ├── prisma/            # schema.prisma e migrations (inclui SQL manual de constraints)
│   ├── spikes/            # schema e migrations dos experimentos técnicos usados nas validações
│   ├── src/
│   │   ├── config/        # leitura e validação de variáveis de ambiente
│   │   ├── jobs/          # worker da outbox de e-mail e rotina de manutenção
│   │   ├── lib/           # db (client, tenant, locks), e-mail, tempo, criptografia, logger
│   │   ├── modules/       # auth, organizations, services, professionals, availability,
│   │   │                  # customers, appointments, email, health
│   │   └── plugins/       # CSRF, tenant, tratamento de erros, registro de rotas
│   └── test/              # testes de integração contra PostgreSQL real
├── frontend/
│   ├── src/
│   │   ├── api/           # cliente HTTP e tipos do contrato
│   │   ├── components/    # layout, UI e guards de rota
│   │   ├── features/      # agenda, auth, availability, landing, organizations,
│   │   │                  # professionals, services
│   │   ├── lib/           # tema, tempo, telefone, WhatsApp, valores monetários
│   │   ├── routes/        # rotas da SPA
│   │   └── test/          # testes de componentes e de fluxo (MSW)
│   └── vercel.json        # rewrite de /api para a API e fallback da SPA
├── docs/                  # arquitetura, configuração, e-mail e validações por etapa
├── docker-compose.yml     # PostgreSQL local
└── .env.example           # nomes e valores de exemplo das variáveis
```

## Instalação e execução local

**Pré-requisitos:** Node.js 24 (`.nvmrc`; o `package.json` exige `>=24.0.0 <25`), npm e Docker (ou outro PostgreSQL acessível).

```bash
# 1. Dependências (raiz do monorepo)
npm install

# 2. Variáveis de ambiente
cp .env.example .env   # ajuste POSTGRES_* e DATABASE_URL; a senha de exemplo é apenas ilustrativa

# 3. PostgreSQL local
docker compose up -d

# 4. Prisma: gerar o client e aplicar as migrations
npm run db:generate -w backend
npm run db:migrate -w backend     # desenvolvimento (prisma migrate dev)

# 5. Backend (http://127.0.0.1:3000)
npm run dev -w backend

# 6. Frontend, em outro terminal (http://localhost:5173, com proxy de /api)
npm run dev -w frontend
```

Em desenvolvimento, sem `RESEND_API_KEY`, os e-mails de verificação e recuperação (com o link) são impressos no terminal do
backend. Em ambientes de produção use `npm run db:deploy -w backend` para aplicar as migrations.

### Variáveis de ambiente

Fonte: `backend/src/config/env.ts`, [`.env.example`](.env.example) e [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md). A API
recusa configurações inválidas e lista apenas os **nomes** das variáveis problemáticas.

| Variável                              | Obrigatória?                 | Descrição                                                                               |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Sim                          | String de conexão PostgreSQL, ex.: `postgresql://USUARIO:SENHA@HOST:5432/BANCO`         |
| `NODE_ENV`                            | Sim (sem padrão)             | `development`, `test` ou `production`                                                   |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | Só para o Docker Compose     | Credenciais do PostgreSQL local                                                         |
| `POSTGRES_PORT`                       | Não                          | Porta publicada pelo Compose (padrão 5433 se omitida)                                   |
| `HOST`, `PORT`, `LOG_LEVEL`           | Não                          | Endereço, porta e nível de log da API                                                   |
| `ALLOWED_ORIGINS`                     | Produção                     | Origens permitidas em métodos que alteram estado (CSRF); em produção exige HTTPS        |
| `TRUST_PROXY`                         | Produção                     | `false`, número de proxies confiáveis ou lista de IPs/CIDRs; `true` é recusado          |
| `APP_BASE_URL`                        | Não                          | URL pública da SPA, usada nos links dos e-mails (padrão: primeira de `ALLOWED_ORIGINS`) |
| `OUTBOX_ENCRYPTION_KEYS`              | Produção                     | Chaves AES-256 da outbox no formato `id:base64`                                         |
| `OUTBOX_CURRENT_KEY_ID`               | Produção                     | Identificador da chave em uso                                                           |
| `REQUIRE_EMAIL_VERIFICATION`          | Não                          | Exigida por padrão; `false` só é aceito fora de produção                                |
| `RESEND_API_KEY` e `EMAIL_FROM`       | Produção (juntas ou nenhuma) | Provedor de e-mail. Sem elas, fora de produção, o e-mail vai para o console             |

Nunca versione o `.env` (já ignorado pelo `.gitignore`) nem coloque segredos reais em arquivos do repositório.

## Testes e qualidade

- **Backend:** Vitest com testes de integração contra PostgreSQL real. O _global setup_ cria os bancos `agendly_test` e
  `agendly_spike`, aplica as migrations e executa os arquivos em série. Áreas cobertas: autenticação, sessões, CSRF, rate
  limit, isolamento entre empresas, permissões, serviços, profissionais, disponibilidade, agendamentos (concorrência,
  constraint, idempotência, locks), outbox e Resend.
- **Frontend:** Vitest com jsdom, Testing Library e MSW (backend simulado) para auth, agenda, WhatsApp, tema, landing,
  serviços, profissionais e organizações.
- **Quantidade:** a contagem aproximada de blocos `it`/`test` nos arquivos é de cerca de 650 no backend e 300 no frontend
  (levantamento estático, sem execução da suíte para este README).

```bash
npm test                          # todos os workspaces (o backend precisa do PostgreSQL ativo)
npm test -w backend
npm test -w frontend
npm run lint
npm run typecheck
npm run format:check
npm run build -w frontend         # tsc + vite build
npm run db:drift -w backend       # confere se as migrations refletem o schema.prisma
```

## Deploy

Configuração confirmada no repositório:

- **Frontend na Vercel:** `frontend/vercel.json` reescreve `/api/:path*` para a API hospedada no Render e devolve
  `/index.html` nas demais rotas (fallback da SPA). Assim o navegador usa uma única origem e o cookie de sessão é de primeira parte.
- **Backend no Render:** destino do rewrite acima (`agendly-0y4y.onrender.com`). Os scripts do projeto indicam `npm start -w backend`
  com `NODE_ENV=production`; as variáveis de produção ficam na plataforma, nunca em arquivo versionado. A configuração do
  serviço no Render não está versionada.
- **PostgreSQL gerenciado:** migrations aplicadas com `npm run db:deploy -w backend`. O provedor do banco não é identificado
  em nenhum arquivo do repositório.
- **E-mail:** Resend. Segundo `docs/EMAIL-VERIFICATION.md`, a entrega real foi validada em desenvolvimento; a validação em
  produção (domínio próprio com SPF/DKIM/DMARC) constava como pendente na data daquele documento.

## Limitações e próximos passos

**Limitações atuais**

- O rate limit é em memória: vale por instância e zera ao reiniciar. Com mais de uma instância, o limite efetivo se multiplica.
- O envio de e-mail e a manutenção rodam no mesmo processo da API.
- O WhatsApp é manual: não há envio automático, webhooks nem lembretes.
- O papel `OWNER` é o único; não há convites nem equipe. O fuso horário da empresa e o e-mail da conta não podem ser alterados.
- A entrega de e-mail em produção depende de configuração e validação do domínio remetente.

**Planejado, ainda não implementado** (conforme `docs/PROJECT.md`; nada abaixo está disponível)

- Página pública de agendamento para clientes finais, com proteção contra abuso.
- Papel `ADMIN` e gerenciamento de membros.
- Integração oficial com o WhatsApp, confirmações e lembretes automáticos.
- Cobrança e assinaturas; observabilidade avançada; 2FA e login social.

## Documentação técnica

| Documento                                                  | Conteúdo                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)             | Arquitetura, modelo de dados, locks, segurança e decisões de produto |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)           | Variáveis do backend e comportamento por ambiente                    |
| [`docs/EMAIL-VERIFICATION.md`](docs/EMAIL-VERIFICATION.md) | Verificação de e-mail, outbox e status da entrega                    |
| [`docs/PROJECT.md`](docs/PROJECT.md)                       | Escopo, MVP e princípios                                             |
| `docs/STAGE-*-VALIDATIONS.md`                              | Evidências das validações técnicas, etapa a etapa                    |

> Alguns documentos em `docs/` foram escritos durante o desenvolvimento e podem descrever como "proposta" itens que já
> foram implementados; em caso de divergência, vale o código.

## Autor

**Gustavo Moura de Queiroz**

[GitHub](https://github.com/QueirozMoura) · [LinkedIn](https://www.linkedin.com/in/gustavomoura-/) · [Portfólio](https://gustavomoura.dev)

## Licença

O repositório ainda não possui um arquivo `LICENSE`; portanto, nenhuma licença de uso foi concedida. Todos os direitos
reservados ao autor até que uma licença seja definida.
