/**
 * Destino interno seguro para depois do login. Só aceita caminho da própria SPA: começa com UMA barra, sem `//`
 * (protocol-relative), sem `\`, sem caracteres de controle e que, resolvido contra a origem atual, continue nela.
 * Qualquer outra coisa (URL externa, `javascript:`, valor que não é texto) vira "/".
 */
export function safeInternalPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000)
    return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const base = "http://agendly.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
