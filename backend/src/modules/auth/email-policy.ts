// Quando o e-mail verificado é exigido. Duas camadas:
//  - criar empresa: exigido por REQUIRE_EMAIL_VERIFICATION (config do servidor; padrão ligado; `false` só fora de produção);
//  - ações em ALWAYS_VERIFIED: exigidas SEMPRE, no servidor, independentemente dessa variável e do frontend.
// Despublicar NUNCA exige verificação: o responsável deve poder tirar a página do ar mesmo sem e-mail confirmado.
//
// Contas antigas (empresa criada enquanto a verificação estava dispensada, e-mail ainda não verificado): continuam donas e
// usam a empresa normalmente (nada é apagado nem alterado), mas não criam outra empresa e NÃO publicam a página pública
// até confirmar o e-mail. As rotas de publicação (Etapa 14) devem chamar `emailPolicyAllows`.

export const ALWAYS_VERIFIED_ACTIONS: ReadonlySet<string> = new Set([
  "org.public_page.publish",
]);

export function emailPolicyAllows(
  action: string,
  user: { emailVerifiedAt: Date | null },
): boolean {
  return !ALWAYS_VERIFIED_ACTIONS.has(action) || user.emailVerifiedAt !== null;
}
