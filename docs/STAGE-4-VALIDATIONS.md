# Etapa 4 — Decisões, validação de V9 e desvios

> Status: **para revisão humana.** O `docs/ARCHITECTURE.md` **não** foi alterado nesta etapa. A marcação
> de V9 como resolvido na seção 13 aguarda aprovação.

## 1. V9 — Argon2id e lista de senhas comuns (resolvido)

**Fontes consultadas nesta etapa**
- OWASP Password Storage Cheat Sheet: mínimo para Argon2id de 19 MiB / 2 iterações / 1 lane (ou 46 MiB / 1 / 1,
  12 MiB / 3 / 1 etc., "nível equivalente de defesa"). Não define tamanho mínimo de senha; só cita máximo de
  72 bytes para bcrypt (não se aplica ao Argon2).
- RFC 9106 §4: 2ª opção recomendada — Argon2id, t=3, p=4, m=64 MiB, sal de 128 bits, tag de 256 bits.
- Documentação do Node.js: `crypto.argon2()` / `argon2Sync()` adicionados na **v24.7.0**; exigem `nonce`
  (sal) ≥ 8 bytes (recomendado ≥ 16, aleatório), `memory` em KiB, `passes`, `parallelism`, `tagLength`. A seção
  não traz índice de estabilidade.

**Decisão:** `crypto.argon2` nativo (nenhuma dependência nova; `engines` já exige Node 24), formato PHC
`$argon2id$v=19$m=65536,t=3,p=1$<sal>$<tag>`, sal de 16 bytes, tag de 32 bytes, 64 MiB, 3 passes, 1 lane.
Medido nesta máquina: **~170 ms por hash** (8 hashes concorrentes: 447 ms, RSS ≈ 107 MB). Escolhi `p=1`
(em vez de `p=4` do RFC) para limitar o uso do threadpool do libuv; memória e passes são os do RFC e acima do
mínimo do OWASP. Os parâmetros ficam dentro do hash, então podem ser elevados no futuro sem invalidar
senhas existentes (não há *rehash* automático ainda). Sem *pepper* (exigiria um segredo novo fora do escopo).
Senhas são normalizadas em NFKC antes do hash.

**Política de senha (3.1):** 10 a 128 caracteres + lista de senhas comuns. A lista é o recorte (≥ 10
caracteres, minúsculas, 9 137 entradas) de `100k-most-used-passwords-NCSC.txt` do repositório SecLists
(licença MIT), em `backend/src/modules/auth/common-passwords.txt`. Só entradas ≥ 10 caracteres importam,
pois esse é o mínimo. Nenhuma regra de composição foi inventada além do documento.

## 2. Achados técnicos

- **`createRateLimit` do `@fastify/rate-limit` devolve `isAllowed: false` também para requisições dentro
  do limite** (`true` só para chaves em allowList). O bloqueio real é `isExceeded`/`isBanned`. Um teste cobre
  as duas pontas (8 tentativas passam, a 9ª recebe 429).
- **O Prisma 7 carrega relações em duas consultas por padrão** (`SELECT sessions…` e depois `SELECT users…`),
  o que contraria "na mesma consulta" (3.1). Habilitei `previewFeatures = ["relationJoins"]` no gerador e usei
  `relationLoadStrategy: "join"`; um teste verifica que cada validação de sessão emite **uma** consulta com JOIN.
  Isso altera só o bloco `generator` do `schema.prisma` (sem migration; `prisma migrate diff` ⇒ sem diferenças).
- Fastify rejeita corpo vazio com `Content-Type: application/json`; por isso o cliente deve enviar `{}` em
  POSTs sem dados (logout).

## 3. Desvios e interpretações em relação ao documento

1. **Cadastro sem e-mail.** 3.3 diz que o e-mail de verificação e o aviso "conta já existe" vão pela outbox
   (Etapa 5, que também cria a tabela). Na Etapa 4 o cadastro responde sempre `202` com a mesma mensagem, cria
   a conta (não verificada) se o e-mail for novo e, se já existir, **não faz nada**. Quando a outbox existir,
   o caminho "novo" enfileira a verificação e o "existente" enfileira `ACCOUNT_EXISTS`. Por não existir
   verificação ainda, nenhum usuário consegue ficar com `email_verified_at` preenchido nesta etapa.
2. **Cadastro não cria sessão** (necessário para não revelar se a conta existia); o usuário faz login depois.
3. **Content-Type exigido em todo método não seguro**, inclusive com corpo vazio (o cliente envia `{}`).
4. **Origin ausente é rejeitado** (403) nesses métodos. Origens permitidas vêm de `ALLOWED_ORIGINS`
   (padrão de desenvolvimento `http://localhost:5173`; **obrigatória em produção**, o processo não sobe sem ela).
5. **Variáveis novas:** `ALLOWED_ORIGINS` e `TRUST_PROXY` (padrão `false`; precisa ser `true` atrás de proxy
   reverso, senão o limite por IP enxerga o IP do proxy).
6. **`lib/db/ping.ts` removido:** o Prisma passa a servir o `/api/ready` (`lib/db/database.ts`), com uma única
   instância de `PrismaClient` por processo, como previsto na Etapa 2.
7. **Fora do escopo desta etapa e não implementado:** "sair de todos os dispositivos", troca/redefinição de
   senha, verificação de e-mail, limpeza periódica de sessões expiradas (laço de manutenção, Etapa 5),
   empresa ativa na sessão (`active_organization_id` fica nulo).

## 4. Limitações conhecidas

- Limitadores de taxa em memória (instância única; reiniciam com o processo; 3.1). O limite **por e-mail**
  permite que um atacante bloqueie temporariamente o login de uma vítima (8 tentativas/15 min); é a troca
  clássica contra força bruta e está documentada, não mitigada.
- A sanitização de logs é heurística (Etapa 2): mensagens de erro do Prisma podem conter trechos de
  consulta; propriedades extras e a senha do banco são removidas, mas um segredo de aplicação não conhecido
  que apareça numa mensagem não seria mascarado. Os testes verificam que senha, token, cookie e hashes não
  aparecem nos logs dos fluxos de autenticação.
- Rotas autenticadas futuras devem usar o mesmo `authenticate` (cobre `credentials_version`); ele ainda é
  local ao módulo `auth` e será extraído para um plugin na Etapa 6, quando houver mais de uma rota protegida.
- A corrida entre login e redefinição de senha (S3, S9 completo) só pode ser testada na Etapa 5, quando a
  redefinição existir; hoje foi verificado apenas que o login lê hash e versão numa única consulta.
