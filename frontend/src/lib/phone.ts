// Espelha backend/src/lib/phone.ts. A arquitetura não permite importar o backend no bundle.
// O teste de compatibilidade compara ambas as implementações; não altera dados persistidos.
const SEPARATORS = /[\s().-]/g;

function validBrazilian(national: string): boolean {
  if (!/^[1-9][1-9]\d{8,9}$/.test(national)) return false;
  if (national.length === 11) return national[2] === "9";
  return /[2-5]/.test(national[2] as string);
}

/** E.164 ou undefined. País explícito (+/00) é preservado; sem país, usa as regras brasileiras existentes. */
export function normalizePhone(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const raw = input.trim();
  if (raw === "" || raw.length > 40) return undefined;
  let international = false;
  let body = raw;
  if (body.startsWith("+")) {
    international = true;
    body = body.slice(1);
  }
  body = body.replace(SEPARATORS, "");
  if (!/^\d+$/.test(body)) return undefined;
  if (!international && body.startsWith("00")) {
    international = true;
    body = body.slice(2);
  }
  if (international) {
    if (!/^[1-9]\d{7,14}$/.test(body)) return undefined;
    if (body.startsWith("55") && !validBrazilian(body.slice(2)))
      return undefined;
    return `+${body}`;
  }
  if (body.startsWith("0")) body = body.slice(1);
  if (body.length >= 12 && body.startsWith("55")) {
    const national = body.slice(2);
    return validBrazilian(national) ? `+55${national}` : undefined;
  }
  return validBrazilian(body) ? `+55${body}` : undefined;
}
