// Slug da empresa: identifica a página pública (/api/public/:slug/...) e vai em X-Active-Org. Minúsculas,
// números e hífens, 3 a 40 caracteres (o banco repete a regra no CHECK organizations_slug_format).
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

// Lista de reservados (seção 5): nomes de rotas da SPA, da API e termos que induziriam confusão/phishing.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // API e infraestrutura
  "api",
  "health",
  "ready",
  "static",
  "assets",
  "public",
  "publico",
  "webhooks",
  "admin",
  "root",
  "system",
  "sistema",
  // Rotas da SPA (etapas 11–14)
  "app",
  "www",
  "entrar",
  "login",
  "logout",
  "sair",
  "cadastro",
  "cadastrar",
  "registrar",
  "registro",
  "signup",
  "painel",
  "dashboard",
  "agenda",
  "agendar",
  "agendamento",
  "agendamentos",
  "clientes",
  "servicos",
  "profissionais",
  "disponibilidade",
  "configuracoes",
  "conta",
  "perfil",
  "empresa",
  "empresas",
  "organizacao",
  "organizacoes",
  "verificar-email",
  "redefinir-senha",
  "recuperar-senha",
  "esqueci-senha",
  "sessao",
  "session",
  "me",
  // Marca e suporte
  "agendly",
  "suporte",
  "ajuda",
  "contato",
  "sobre",
  "termos",
  "privacidade",
  "planos",
  "precos",
  "blog",
  "status",
  "mail",
  "email",
  "ftp",
  "smtp",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
