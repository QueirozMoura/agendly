# Agendly — Planejamento do projeto

> Arquitetura detalhada, modelo de dados, segurança, validações técnicas
> pendentes e sequência de etapas: veja [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
> (as decisões de produto aprovadas estão consolidadas na seção 15 daquele documento).

## Objetivo
Construir uma plataforma SaaS multiempresa para gerenciar agendamentos
e automatizar comunicações com clientes.

## Escopo

### MVP
- Cadastro e autenticação de usuários, com verificação de e-mail e
  recuperação de senha. O envio de e-mails usa uma fila persistente no banco
  (entrega *at-least-once*: um e-mail duplicado é possível em certas falhas).
- Um usuário pode ser proprietário (`OWNER`) de várias empresas. **No MVP o
  proprietário é o único papel operacional**: somente ele tem login na empresa.
- Cadastro e configuração de empresas. O fuso horário é definido na criação e
  não pode ser alterado.
- Serviços (duração e buffer configuráveis, buffer padrão zero) e
  profissionais (sem conta própria).
- Disponibilidade (horários de trabalho e folgas) e agendamentos, com grade
  inicial de 15 minutos.
- Painel administrativo (operado pelo proprietário).
- Página pública de agendamento para clientes finais, sem criação de conta,
  protegida por rate limit e honeypot.
- Interface somente em português brasileiro (`pt-BR`).
- Logs estruturados e monitoramento básico.

### Pós-MVP (cada item exige autorização explícita)
- Papel `ADMIN` (equipe administrativa), convites de equipe e gerenciamento de
  membros. O modelo é preparado para receber o papel depois, sem implementá-lo agora.
- Integração oficial com WhatsApp (mensagens e webhooks).
- Confirmações e lembretes automáticos.
- Cobrança e assinaturas.
- Troca de e-mail da conta e troca de fuso horário da empresa.
- Agendamentos retroativos (registrar atendimentos já ocorridos).
- CAPTCHA, caso o rate limit e o honeypot não bastem.
- Sentry ou outra observabilidade avançada.
- Row-Level Security, 2FA e login social.
- Internacionalização, pacote `shared/` e filas/workers externos.
- Especialização por nicho, somente após validar a demanda com negócios reais.

## Regras de produto aprovadas (resumo)

Detalhes, justificativas e rastreio em `docs/ARCHITECTURE.md`, seção 15.

**Permissões**
- No MVP existe um único papel operacional, `OWNER`, que gerencia a empresa
  (configurações, página pública), serviços, profissionais, disponibilidade,
  clientes e agendamentos.
- `ADMIN` e gerenciamento de membros ficam como evolução futura. Matriz de
  permissões do MVP e proposta futura: `docs/ARCHITECTURE.md`, seção 3.2.

**Agendamento**
- Buffer: tempo de preparação depois do atendimento, configurado por serviço.
  Pode ultrapassar o expediente ou encostar numa folga; apenas o intervalo real
  do atendimento precisa caber nos horários de trabalho e não intersectar folgas.
- Não são permitidos agendamentos no passado, nem pelo painel.
- Alterações de folga ou horário de trabalho que conflitem com agendamentos
  ativos futuros são rejeitadas com a lista dos conflitos; nenhum agendamento
  é cancelado automaticamente.
- Repetir a mesma operação de criação não gera duplicata; reutilizar a mesma
  chave de idempotência com pedido diferente retorna `409 Conflict`
  (retenção de 24 horas).

**Página pública (configurações iniciais, sujeitas à validação com usuários reais)**
- No máximo 3 agendamentos futuros ativos por telefone.
- Antecedência mínima de 2 horas e máxima de 60 dias.

**Conta e empresa**
- O e-mail precisa estar verificado antes de criar uma empresa ou publicar a
  página pública.

## Princípios
- Isolamento rigoroso dos dados de cada empresa: o servidor determina a
  empresa; o cliente nunca informa `organizationId` para obter acesso.
- Invariantes críticas (conflito de horário, integridade entre empresas) são
  garantidas pelo banco sempre que possível; o restante tem estratégia
  explícita (locks com ordem global) e testada.
- Nada que não possa ser perdido vive apenas em memória (e-mails
  transacionais e idempotência são persistidos no banco).
- Validação de dados no servidor.
- Testes automatizados, incluindo isolamento entre empresas e concorrência.
- Segredos somente em variáveis de ambiente.
- Integrações externas são adaptadores desacoplados do núcleo de agendamento.
- Desenvolvimento incremental, em etapas pequenas e verificáveis.
- Nenhuma integração paga sem necessidade validada.
- Nenhuma garantia técnica é presumida: itens marcados como `[VALIDAR]` em
  `docs/ARCHITECTURE.md` (seção 13) só são tratados como fato após evidência
  (teste ou documentação oficial). Os itens V1–V8, V13, V15 e V16 foram resolvidos
  na Etapa 3, com resultados e ressalvas (V7 e V8) em
  `docs/STAGE-3-VALIDATIONS.md`; os demais (V9–V12 e V14) continuam
  **não verificados**.
- Os testes e critérios de aceite descritos nos documentos são especificações.
  Parte deles já foi implementada e executada nas etapas concluídas (backend
  base na Etapa 2; fundação do banco e validações técnicas na Etapa 3). O plano
  de testes como um todo ainda não está pronto: os testes das etapas seguintes
  (autenticação, isolamento entre empresas, concorrência de agendamentos, outbox
  de e-mail, frontend etc.) continuam por escrever e executar.

## Stack planejada
- Frontend: React + TypeScript + Vite.
- Backend: Fastify + TypeScript.
- Banco de dados: PostgreSQL.
- ORM: Prisma.
- Validação: Zod.
- Testes: Vitest.
- Datas e fusos: `date-fns-tz` (compatibilidade a validar).
- IDs: UUID v7 (suporte a validar).
- Gerenciador de pacotes: npm (workspaces).
