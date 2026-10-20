/** Token do link do e-mail: vem no FRAGMENTO (`#token=…`), que o navegador não envia ao servidor (3.4). */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && token.length > 0 ? token : null;
}
