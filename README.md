<div align="center">

# Agendly

**Agenda, serviços, profissionais e disponibilidade para negócios que atendem com hora marcada.**

Aplicação Full Stack multiempresa, com regras de agendamento no servidor e proteção contra sobreposição no PostgreSQL.

![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)

[Visão geral](#visão-geral) · [Funcionalidades](#funcionalidades) · [Demonstração](#demonstração-visual) · [Stack](#stack-tecnológica) · [Arquitetura](#arquitetura) · [Decisões técnicas](#desafios-técnicos-e-decisões-de-engenharia)

[Execução local](#instalação-e-execução-local) · [Ambiente](#variáveis-de-ambiente) · [Testes](#testes-e-qualidade) · [Deploy](#deploy) · [Limitações](#limitações-e-próximos-passos) · [Autor](#autor)

</div>

> **Demonstração em produção:** o endereço público do frontend ainda não está registrado nos arquivos versionados. A configuração de publicação disponível está descrita em [Deploy](#deploy).

## Visão geral

O Agendly centraliza a operação de pequenos negócios de atendimento, como estúdios, barbearias e consultórios: cadastro de serviços e profissionais, expediente semanal, folgas, contatos dos clientes e agenda de atendimentos.

O responsável cria uma empresa, configura seus serviços e a disponibilidade dos profissionais e passa a agendar pelo painel. A aplicação calcula horários livres, revalida as regras ao salvar e prepara mensagens de confirmação para envio manual pelo WhatsApp.

Um usuário pode administrar várias empresas, com dados separados por organização. O papel operacional atual é **`OWNER`**; profissionais e clientes são cadastros do negócio e não possuem acesso próprio ao sistema. A interface é em português brasileiro.

## Funcionalidades

### Contas e organizações

- Cadastro, login, logout e encerramento de sessões em todos os dispositivos.
- Verificação de e-mail, reenvio da confirmação e recuperação de senha com links de uso único. Criar uma empresa exige e-mail verificado por padrão.
- Criação e seleção de empresas, com nome, slug e fuso horário IANA definido na criação.
- Tratamento de sessão expirada e de troca da empresa ativa em outra aba.

A API também permite atualizar dados da organização; o painel atual oferece criação e seleção. O fuso horário da empresa permanece imutável.

### Serviços, profissionais e clientes

| Área          | Recursos implementados                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serviços      | Cadastro, edição, ativação e desativação; duração em minutos, intervalo após o atendimento (_buffer_) e preço opcional em centavos.                 |
| Profissionais | Cadastro, edição, ativação e desativação; associação aos serviços atendidos; expediente e folgas na tela de detalhes.                               |
| Clientes      | Criação ou reaproveitamento pelo telefone ao agendar. A API permite consultar e editar um cliente por ID, incluindo dados de contato e observações. |

O telefone é normalizado para E.164 e único por empresa. Reutilizar um telefone existente ao agendar preserva o cadastro já salvo. **Não há tela independente de clientes nem endpoint de listagem de clientes nesta versão.**

### Agenda e disponibilidade

- Visualização diária e semanal, agrupada por profissional, com navegação por data.
- Criação, remarcação e cancelamento pelo painel; cancelamentos preservam o registro.
- Horários disponíveis em grade de 15 minutos, considerando serviço, vínculo com o profissional, expediente, folgas e reservas ativas.
- Revalidação no servidor e mensagens de conflito quando o horário ou o agendamento mudou durante a operação.
- Nome, duração, buffer e preço do serviço preservados no agendamento por meio de snapshots.

A API também oferece confirmação, conclusão, registro de falta e reativação de cancelados. Essas ações ainda não têm controles no painel.

| Status      | Significado    | Bloqueia horário |
| ----------- | -------------- | ---------------- |
| `SCHEDULED` | Agendado       | Sim              |
| `CONFIRMED` | Confirmado     | Sim              |
| `COMPLETED` | Concluído      | Não              |
| `CANCELLED` | Cancelado      | Não              |
| `NO_SHOW`   | Não compareceu | Não              |

Concluir e registrar falta só são permitidos após o fim do atendimento. Reativar um cancelado exige nova validação de disponibilidade; concluídos e faltas são estados terminais.

### WhatsApp, e-mails e interface

**WhatsApp manual.** Para agendamentos ativos e futuros, o painel prepara uma mensagem com os dados do atendimento e permite abrir o WhatsApp com o texto preenchido. O usuário revisa e envia. Abrir a mensagem no WhatsApp não altera o status da reserva; não há envio automático nem integração com a API oficial.

**E-mails de conta.** Verificação, recuperação de senha, aviso de senha alterada e aviso de conta já existente usam uma outbox persistente, com envio pelo Resend. Fora de produção, sem provedor configurado, os e-mails são exibidos no terminal do backend.

**Apresentação.** Landing page responsiva, painel autenticado e temas claro, escuro e do sistema. A preferência de tema é persistida no navegador; dados de sessão e dados pessoais não são guardados em `localStorage` ou `sessionStorage` pela aplicação. A página inicial do painel reúne informações da empresa e atalhos, sem indicadores analíticos.

## Demonstração visual

As capturas reais ainda não estão versionadas. Esta seção está reservada para uma galeria com dados fictícios:

| Tela                     | O que demonstrar                                              |
| ------------------------ | ------------------------------------------------------------- |
| Landing page             | Apresentação do produto e navegação responsiva                |
| Agenda                   | Visões diária e semanal, horários e formulário de agendamento |
| Serviços e profissionais | Catálogo, vínculos, expediente e folgas                       |
| Temas                    | A mesma tela nos modos claro e escuro                         |

<!-- Adicionar capturas reais em docs/screenshots/ e substituir esta tabela por imagens com texto alternativo. Incluir apenas arquivos existentes; não usar dados de usuários reais, tokens ou credenciais. -->

## Stack tecnológica

Versões declaradas nos `package.json` e no Docker Compose; as dependências estão fixadas sem intervalos de versão.

| Camada                       | Tecnologias                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Frontend                     | React / React DOM **19.3.1**, React Router **8.5.0**, Vite **8.3.4**, TypeScript **6.0.3**, CSS e Zod **4.6.7**            |
| Backend                      | Node.js **24**, Fastify **5.12.7**, Zod **4.6.7**, date-fns **4.4.0**, date-fns-tz **3.2.0**, uuid **14.0.3**              |
| Banco e acesso a dados       | PostgreSQL **18.6** no ambiente local; Prisma / adapter-pg **7.10.1**, pg **8.23.1**                                       |
| Autenticação e segurança     | Sessões persistidas, Argon2id nativo do Node.js, @fastify/cookie **11.1.3**, @fastify/rate-limit **11.2.1**, proteção CSRF |
| Testes                       | Vitest **5.0.5**, Testing Library React **16.3.3**, user-event **14.6.8**, MSW **3.0.3**, jsdom **30.1.3**                 |
| Qualidade                    | ESLint **10.13.0**, typescript-eslint **8.71.2**, Prettier **3.9.10**, verificação estática com TypeScript                 |
| Infraestrutura e integrações | Configuração de frontend na Vercel, destino da API no Render, Docker Compose local e Resend por HTTP                       |

O backend executa TypeScript diretamente com Node.js 24, sem script de build. O frontend gera os arquivos estáticos com Vite.

## Arquitetura

O repositório utiliza **npm workspaces**, com uma SPA React e uma API Fastify organizada por módulos. O banco PostgreSQL é compartilhado entre organizações, com escopo de acesso por empresa e integridade referencial reforçada nas migrations.

```mermaid
flowchart LR
    UI["Navegador · React SPA"] -->|"/api/* · cookie de sessão"| Proxy["Proxy de mesma origem"]
    Proxy --> API["API Fastify"]
    subgraph Backend["Processo Node.js"]
        API --> Guards["Sessão · CSRF · tenant · permissões"]
        Guards --> Modules["Módulos e regras de negócio"]
        Jobs["Jobs · outbox e manutenção"]
    end
    Modules --> Prisma["Prisma + adapter pg"]
    Prisma --> DB[(PostgreSQL)]
    Jobs --> DB
    Jobs -->|"HTTP"| Resend["Resend"]
    UI -.->|"Link com mensagem · envio manual"| WhatsApp["WhatsApp"]
```

O proxy é fornecido pelo Vite em desenvolvimento e pelos rewrites da Vercel na configuração de produção. O cliente HTTP usa `/api` na origem da própria página e envia cookies com `credentials: same-origin`.

### Organização do código

No **frontend**, `features/` reúne telas e lógica por domínio; `components/` contém layouts e controles compartilhados. Contextos mantêm autenticação e empresa ativa. O cliente em `api/` centraliza chamadas HTTP, erros de sessão e inconsistências de organização entre abas. Guards controlam o acesso às rotas, enquanto a autorização efetiva permanece na API.

No **backend**, os módulos separam rotas, schemas Zod e regras de negócio. `plugins/` concentra proteções transversais; `lib/db/` fornece acesso ao banco, escopo por tenant e locks; `jobs/` executa envio de e-mail e manutenção no mesmo processo da API. Relógio e provedor de e-mail podem ser substituídos nos testes.

### Persistência e isolamento

O [schema Prisma](backend/prisma/schema.prisma) modela identidade, memberships, sessões, tokens, organizações, serviços, profissionais, disponibilidade, clientes, agendamentos, idempotência e outbox. Os IDs usam UUID v7; instantes são persistidos em `timestamptz`, e a conversão para horário local usa o fuso IANA da empresa.

A organização ativa é resolvida pela sessão e validada contra a membership do usuário. O cabeçalho `X-Active-Org` contém apenas uma asserção do slug exibido na interface: divergência retorna `409 ACTIVE_ORG_CHANGED`, sem conceder acesso a outra organização. Recursos de outro tenant retornam `404`.

As relações entre entidades do negócio usam chaves estrangeiras compostas com `organization_id`. O Prisma organiza o acesso a dados; SQL manual nas [migrations](backend/prisma/migrations) acrescenta `CHECK`, constraints de exclusão e a extensão `btree_gist`, que não são integralmente representados pelo schema Prisma.

### API implementada

Resumo das rotas; os corpos, filtros e validações estão nos arquivos `routes.ts` e `schemas.ts` de cada [módulo](backend/src/modules).

| Área            | Métodos e caminhos                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saúde           | `GET /api/health`, `GET /api/ready` (inclui verificação de banco)                                                                                            |
| Conta           | `POST /api/auth/register`, `/login`, `/logout`, `/logout-all`, `/verify-email`, `/resend-verification`, `/forgot-password`, `/reset-password`; `GET /api/me` |
| Organizações    | `GET/POST /api/organizations`; `POST /api/session/active-organization`; `GET/PATCH /api/organization`                                                        |
| Serviços        | `GET/POST /api/services`; `GET/PATCH /api/services/:id`                                                                                                      |
| Profissionais   | `GET/POST /api/professionals`; `GET/PATCH /api/professionals/:id`; `PUT /api/professionals/:id/services`                                                     |
| Expediente      | `GET/POST /api/working-hours`; `PATCH/DELETE /api/working-hours/:id`                                                                                         |
| Folgas          | `GET/POST /api/time-off`; `PATCH/DELETE /api/time-off/:id`                                                                                                   |
| Horários livres | `GET /api/availability/slots`                                                                                                                                |
| Clientes        | `GET/PATCH /api/customers/:id`                                                                                                                               |
| Agendamentos    | `GET/POST /api/appointments`; `GET /api/appointments/:id`; `POST /api/appointments/:id/{reschedule,reactivate,cancel,confirm,complete,no-show}`              |

Na linha de conta, os sufixos compartilham o prefixo `/api/auth`; as chaves na linha de agendamentos representam ações alternativas. Rotas de negócio exigem sessão, empresa ativa e permissão. Métodos que alteram estado exigem `Origin` permitido e `Content-Type: application/json`, inclusive quando o corpo é `{}`. Criar um agendamento exige `Idempotency-Key`; suas alterações exigem a versão atual do registro.

## Desafios técnicos e decisões de engenharia

### 1. Impedir sobreposição mesmo com pedidos simultâneos

Consultar horários livres antes de inserir não basta: duas requisições podem observar a mesma disponibilidade. A migration de agendamentos define uma **exclusion constraint GiST** por empresa e profissional, sobre o intervalo `[starts_at, blocked_until)`, para `SCHEDULED` e `CONFIRMED`.

O banco rejeita a sobreposição mesmo sob concorrência. O intervalo inclui o buffer; a fronteira aberta permite que o próximo atendimento comece exatamente quando o bloqueio anterior termina. Constraints `CHECK` verificam a coerência entre início, fim, buffer e snapshots. A aplicação traduz o conflito para uma resposta de negócio.

### 2. Coordenar reservas, expediente e folgas

Uma reserva precisa permanecer válida enquanto outra requisição altera a disponibilidade. As operações compartilham locks do profissional e seguem uma ordem centralizada em [lib/db/locks](backend/src/lib/db/locks): cliente, profissionais em ordem determinística, idempotência e escrita, conforme os recursos usados pela operação.

Um guard verifica a ordem das aquisições. Há timeout de lock de 2 segundos e limite de 8 segundos para a transação interativa. Timeouts e deadlocks tratados resultam em rollback e `503 TEMPORARILY_BUSY`, com `Retry-After`. A estratégia reduz disputas e permite testar a disciplina de bloqueios, sem pressupor ausência absoluta de deadlocks.

### 3. Separar repetição de pedido de edição concorrente

A criação usa uma chave UUID de idempotência, com resultado persistido por organização e escopo por 24 horas. Repetir a chave com o mesmo conteúdo devolve a resposta registrada e `Idempotent-Replay: true`; reutilizá-la com outro conteúdo retorna `409`.

Edições usam o campo `version`: um cliente desatualizado recebe `409 STALE_VERSION`. No painel, remarcação e cancelamento recarregam os dados em vez de repetir silenciosamente uma edição sobre uma versão mais recente.

### 4. Modelar tempo e preservar o histórico do serviço

A grade de início é de 15 minutos, mas a duração do serviço é independente dela. O atendimento deve caber no expediente e não atravessar uma folga; o buffer pode ultrapassar o expediente ou alcançar uma folga, mas continua bloqueando a próxima reserva.

Mudanças de expediente ou folgas incompatíveis com agendamentos futuros ativos são recusadas com os conflitos encontrados. A conversão de fuso fica concentrada nos utilitários de tempo, e o relógio injetável torna testes de datas determinísticos. Snapshots evitam que uma alteração posterior no catálogo modifique duração, preço ou nome de um atendimento já registrado.

### 5. Manter autenticação e autorização no servidor

As senhas usam Argon2id e validação contra senhas comuns. O cookie contém um token aleatório; apenas seu hash SHA-256 é persistido. As sessões expiram por 7 dias de inatividade ou pelo teto absoluto de 30 dias, com `HttpOnly`, `SameSite=Lax` e, em produção, `Secure` e prefixo `__Host-`.

A comparação de `credentials_version` a cada autenticação invalida sessões anteriores após redefinição de senha, inclusive em cenários de login concorrente. Tokens de verificação e recuperação têm validade de uma hora e consumo único. A recuperação mantém a mesma resposta para e-mails existentes e inexistentes.

A autorização nega ações desconhecidas por padrão. CSRF combina cookie, validação de origem e exigência de JSON; limites de tentativas protegem fluxos de autenticação. `TRUST_PROXY` exige configuração explícita em produção e recusa `true`, evitando confiança irrestrita em cabeçalhos encaminhados.

### 6. Persistir a intenção de enviar e-mail

Token e mensagem são gravados na mesma transação. O payload da outbox usa **AES-256-GCM**, com identificação de chave para rotação. Um worker adquire mensagens com lease, envia e aplica retentativas com backoff e jitter; falhas definitivas, expiração ou esgotamento das tentativas encerram o processamento.

A entrega é _at-least-once_: duplicatas ainda são possíveis. O adaptador envia o ID da mensagem como chave de idempotência ao Resend, mas o efeito real dessa proteção permanece pendente de validação conforme o [guia de e-mail](docs/EMAIL-VERIFICATION.md). O worker e a manutenção rodam junto da API, sem broker externo.

### 7. Tornar falhas compreensíveis e verificáveis

A API padroniza erros com `code`, `message`, `requestId` e detalhes opcionais. O frontend distingue erros de campo, sessão, conflito e rede; os logs aplicam sanitização de informações sensíveis. Configurações inválidas impedem a inicialização, com mensagens que identificam nomes de variáveis sem revelar seus valores.

Testes exercitam essas fronteiras: concorrência e constraints em PostgreSQL real, isolamento entre empresas, sessões e tokens, falhas na outbox e fluxos da interface com respostas HTTP simuladas.

## Estrutura do projeto

```text
agendly/
├── backend/
│   ├── prisma/                 # Schema e migrations, incluindo SQL manual
│   ├── spikes/                 # Experimentos técnicos e schema de validação
│   ├── src/
│   │   ├── config/             # Validação de ambiente
│   │   ├── jobs/               # Outbox e manutenção
│   │   ├── lib/                # Banco, locks, tempo, criptografia e logs
│   │   ├── modules/            # Auth, organizações, catálogo, agenda e e-mail
│   │   ├── plugins/            # CSRF, tenant, registro de rotas e erros
│   │   ├── app.ts              # Composição da API
│   │   └── server.ts           # Entrada do processo
│   ├── test/                   # Testes unitários, integração e concorrência
│   └── tools/                  # Configuração de banco para CLI e testes
├── frontend/
│   ├── public/                 # Inicialização de tema
│   ├── src/
│   │   ├── api/                # Cliente HTTP, contexto e tipos
│   │   ├── components/         # Layouts, controles e guards
│   │   ├── features/           # Telas organizadas por domínio
│   │   ├── hooks/              # Recursos e ações assíncronas
│   │   ├── lib/                # Datas, valores, telefone, tema e WhatsApp
│   │   ├── routes/             # Rotas da SPA
│   │   └── test/               # Componentes e fluxos com MSW
│   ├── vercel.json             # Rewrites de API e fallback da SPA
│   └── vite.config.ts          # Desenvolvimento, proxy e testes
├── docs/                       # Arquitetura, configuração e validações
├── .env.example                # Modelo de configuração local
├── docker-compose.yml          # PostgreSQL local
└── package.json                # Workspaces e comandos de qualidade
```

## Instalação e execução local

### Pré-requisitos

- Node.js **24.7 ou superior dentro da linha 24** e npm, devido ao uso de `crypto.argon2`. A versão principal está em `.nvmrc`; o intervalo declarado em `engines` é `>=24.0.0 <25`.
- Docker com Compose, ou PostgreSQL acessível. O Compose utiliza PostgreSQL **18.6**.
- Permissão para aplicar migrations e instalar a extensão `btree_gist` no banco local.

Na raiz do repositório:

```bash
npm ci
cp .env.example .env
```

Se já existir `.env`, preserve-o e ajuste somente o necessário. Configure `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` e `POSTGRES_PORT`; faça `DATABASE_URL` corresponder a esses valores. Use credenciais próprias de desenvolvimento, sem versioná-las.

O exemplo define porta **5432**; sem `POSTGRES_PORT`, o Compose publica **5433**. A porta da URL deve coincidir com a porta publicada.

```bash
# Subir o PostgreSQL local e verificar seu estado
docker compose up -d postgres
docker compose ps

# Gerar o cliente Prisma e aplicar as migrations existentes
npm run db:generate -w backend
npm run db:deploy -w backend

# Iniciar a API
npm run dev -w backend
```

Em outro terminal, na raiz:

```bash
npm run dev -w frontend
```

Acesse **http://localhost:5173**. O backend escuta em `http://127.0.0.1:3000`, e o Vite encaminha `/api` para ele. O comando `dev` do backend inicia o processo sem modo watch; alterações no servidor exigem reinício.

### Primeiro uso

1. Cadastre uma conta e abra o link de verificação exibido no terminal do backend, quando estiver usando o envio para console.
2. Crie a empresa e escolha seu fuso horário.
3. Cadastre serviços, profissionais e os vínculos entre eles.
4. Configure o expediente do profissional; adicione folgas quando necessário.
5. Abra a agenda e crie um atendimento com dados fictícios para experimentar o fluxo.

Sem expediente ou vínculo entre profissional e serviço, não haverá horários elegíveis. Não é necessário um seed para iniciar esse fluxo.

Para desenvolver mudanças no modelo de dados, existe `npm run db:migrate -w backend` (`prisma migrate dev`). Para reproduzir a versão atual, utilize `db:deploy`, que aplica as migrations já versionadas. Preserve as migrations SQL: `db push` não substitui as constraints manuais.

## Variáveis de ambiente

Fontes: [modelo de ambiente](.env.example), [validação do backend](backend/src/config/env.ts) e [guia de configuração](docs/CONFIGURATION.md). O frontend utiliza a origem atual e não exige variável `VITE_*` para a API.

| Variável                                            | Quando é necessária      | Finalidade / padrão                                                                                                     |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                      | Sempre para a API        | Conexão PostgreSQL. Formato ilustrativo: `postgresql://USUARIO:SENHA@HOST:PORTA/BANCO`.                                 |
| `NODE_ENV`                                          | Sempre                   | `development`, `test` ou `production`, sem padrão implícito. O script `dev` define `development`.                       |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Docker Compose local     | Usuário, senha e banco do contêiner.                                                                                    |
| `POSTGRES_PORT`                                     | Opcional                 | Porta local publicada; padrão do Compose: `5433`.                                                                       |
| `HOST`, `PORT`                                      | Opcionais                | Interface e porta da API; padrões `127.0.0.1` e `3000`.                                                                 |
| `LOG_LEVEL`                                         | Opcional                 | Nível de log; padrão `info`.                                                                                            |
| `ALLOWED_ORIGINS`                                   | Obrigatória em produção  | Origens permitidas para alterações, separadas por vírgula. Padrão local: `http://localhost:5173`; produção exige HTTPS. |
| `TRUST_PROXY`                                       | Obrigatória em produção  | `false`, número de saltos de 1 a 10 ou lista de IPs/CIDRs. Padrão local: `false`; `true` é recusado.                    |
| `APP_BASE_URL`                                      | Opcional                 | Origem da SPA para links de e-mail; padrão: primeira origem permitida. HTTPS em produção.                               |
| `OUTBOX_ENCRYPTION_KEYS`                            | Obrigatória em produção  | Chaves de 32 bytes em Base64, no formato `ID:CHAVE_BASE64`, separadas por vírgula.                                      |
| `OUTBOX_CURRENT_KEY_ID`                             | Obrigatória em produção  | ID da chave usada para novas mensagens.                                                                                 |
| `REQUIRE_EMAIL_VERIFICATION`                        | Opcional                 | Padrão `true`. `false` é aceito somente em desenvolvimento/teste.                                                       |
| `RESEND_API_KEY`, `EMAIL_FROM`                      | Obrigatórias em produção | Chave do provedor e remetente. Fora de produção, configure ambas ou nenhuma; sem ambas, o envio vai para o console.     |

Fora de produção existe uma chave pública de outbox para desenvolvimento/testes. Em produção, forneça chaves próprias pelo ambiente da plataforma e mantenha as antigas enquanto houver mensagens cifradas com elas. Os placeholders acima são descritivos e devem ser substituídos localmente.

`AGENDLY_DB_NAME` é uma variável auxiliar da CLI Prisma, utilizada pelos testes para selecionar o banco; não é necessária para iniciar a aplicação. Não há `JWT_SECRET`: a autenticação usa sessões persistidas.

## Testes e qualidade

**Backend.** Vitest combina testes unitários com integração em PostgreSQL real. As suítes cobrem autenticação, autorização, isolamento, migrations, constraints, disponibilidade, concorrência, idempotência, locks e outbox. Arquivos de teste são executados sequencialmente porque compartilham bancos de teste.

**Frontend.** Vitest com jsdom, Testing Library e MSW exercita componentes e fluxos: autenticação, organizações, serviços, profissionais, disponibilidade, agenda, WhatsApp, temas e tratamento de erros. As respostas da API são simuladas; esses testes não constituem uma suíte ponta a ponta em navegador real.

### Preparação do backend

Utilize uma instância PostgreSQL **local e exclusiva para desenvolvimento/testes**. O setup usa a conexão configurada, acessa o banco administrativo `postgres`, cria `agendly_test` e `agendly_spike`, gera clientes Prisma e aplica migrations. Os testes limpam tabelas e alguns criam bancos temporários: o usuário precisa de permissão para criar bancos.

Instale também `psql` e `pg_dump` no `PATH`, com versão compatível com o servidor; há testes de dump/restauração. Não execute a suíte contra uma instância de produção.

```bash
# Suítes
npm test
npm test -w frontend
npm test -w backend

# Qualidade e build
npm run lint
npm run typecheck
npm run format:check
npm run build -w frontend

# Comparação do banco configurado com o schema Prisma
npm run db:drift -w backend
```

`typecheck` também gera o cliente Prisma por meio de `pretypecheck` no backend. `db:drift` consulta o banco configurado e não substitui testes das constraints SQL manuais. Os comandos acima correspondem aos scripts versionados; este README não publica contagem de testes ou percentual de cobertura sem uma medição atual.

## Deploy

| Componente        | Evidência no repositório                       | Configuração relevante                                                                                                                                        |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend / Vercel | [frontend/vercel.json](frontend/vercel.json)   | Rewrite de `/api/:path*` para o backend e fallback das demais rotas para `/index.html`. Build: `npm run build -w frontend`; saída em `frontend/dist`.         |
| API / Render      | Destino `agendly-0y4y.onrender.com` no rewrite | Inicialização disponível por `npm start -w backend`; configuração do serviço na plataforma não está versionada.                                               |
| PostgreSQL        | Prisma e migrations                            | Aplicação das migrations por `npm run db:deploy -w backend`. O provedor de produção não está identificado nos arquivos versionados; Neon não está confirmado. |
| E-mail / Resend   | Adaptador HTTP e guia de e-mail                | Variáveis do provedor, domínio remetente e chaves da outbox configurados no servidor.                                                                         |

Para preparar o backend, os scripts disponíveis são `npm ci`, `npm run db:generate -w backend`, `npm run db:deploy -w backend` e `npm start -w backend`. Esta sequência descreve as operações necessárias, sem presumir os comandos atualmente salvos no painel de hospedagem.

Em produção, defina `NODE_ENV=production`, as variáveis obrigatórias e `HOST=0.0.0.0` quando o serviço precisar escutar em todas as interfaces; utilize a `PORT` fornecida pela plataforma. Configure `TRUST_PROXY` conforme os saltos efetivos e o acesso de rede. O proxy precisa tratar corretamente `X-Forwarded-For`; não há um número universal de saltos para copiar.

A mesma origem pública permite usar o cookie de sessão sem CORS entre SPA e API. `ALLOWED_ORIGINS` deve corresponder ao frontend HTTPS; `APP_BASE_URL` deve apontar para a origem pública usada nos links de verificação e recuperação.

O [registro de validação de e-mail](docs/EMAIL-VERIFICATION.md) documenta entrega real em desenvolvimento em 20/10/2026, com validação de produção ainda pendente. Na inicialização em produção, a API consulta o Resend: configuração identificada como inválida impede a subida; verificação inconclusiva gera aviso. Isso não comprova entregabilidade em produção.

## Limitações e próximos passos

### Limitações atuais

- O painel não oferece gestão independente de clientes, edição de organização ou controles para todas as transições de status disponíveis na API.
- A página inicial autenticada tem atalhos e informações da empresa, sem dashboard analítico. A listagem da agenda tem limite de 500 registros, sinalizado pela interface quando atingido.
- Apenas `OWNER` opera o sistema; não há convites nem gestão de equipe. Fuso da organização e e-mail da conta não são editáveis.
- WhatsApp depende de revisão e envio manual; não há webhooks, lembretes automáticos ou atualização de status a partir de mensagens.
- Rate limits ficam em memória por instância e são reiniciados com o processo. Jobs de e-mail e manutenção compartilham o processo da API.
- Reenvios de verificação podem deixar na fila mensagens anteriores com links já invalidados. Duplicatas de e-mail continuam possíveis.

### Evoluções previstas ou pendentes

A documentação de projeto prevê página pública de agendamento e evolução de papéis/membros. **Esses fluxos ainda não estão implementados**, mesmo havendo campos de publicação e o valor `PUBLIC` no schema. Consulte o [escopo do projeto](docs/PROJECT.md) e as [decisões de arquitetura](docs/ARCHITECTURE.md) para propostas futuras.

Permanecem pendentes a galeria de screenshots, o registro da URL pública do frontend e a atualização das evidências de entrega de e-mail em produção. Ampliação do painel e de integrações deve ser tratada como evolução, não como capacidade disponível nesta versão.

## Documentação técnica

| Referência                                          | Conteúdo                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| [Arquitetura](docs/ARCHITECTURE.md)                 | Modelo de dados, segurança, locks e decisões de produto                 |
| [Configuração](docs/CONFIGURATION.md)               | Ambiente, origens, proxy e comportamento por ambiente                   |
| [Verificação de e-mail](docs/EMAIL-VERIFICATION.md) | Fluxos de conta, outbox, provedor e pendências de validação             |
| [Projeto](docs/PROJECT.md)                          | Escopo e princípios do produto                                          |
| [Validações por etapa](docs/)                       | Arquivos `STAGE-*-VALIDATIONS.md`, com cenários e resultados históricos |

Os documentos de planejamento e os resultados por etapa registram momentos do desenvolvimento. Propostas futuras e contagens históricas não devem ser interpretadas como funcionalidades ou métricas atuais; para o comportamento implementado, consulte o código e suas migrations.

## Autor

**Gustavo Moura de Queiroz**

[GitHub](https://github.com/QueirozMoura) · [LinkedIn](https://www.linkedin.com/in/gustavomoura-/) · [Portfólio](https://gustavomoura.dev)

## Licença

Não há um arquivo `LICENSE` na raiz do repositório. Nenhuma licença foi atribuída ao projeto por este README. Avisos de licença de recursos de terceiros, como a fonte incluída no frontend, permanecem nos respectivos diretórios.
