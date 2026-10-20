// Normalização de telefone para E.164 (`customers.phone_e164`, 5). Função pura, sem dependências externas.
// Regras (decisão da Etapa 10, sujeita a aprovação):
// - com `+` (ou prefixo `00`): número internacional, 8 a 15 dígitos, sem zero à esquerda do código do país;
// - sem `+`: número nacional do Brasil (DDD + número, 10 ou 11 dígitos; o celular de 11 dígitos começa com 9 depois do DDD)
//   ou o mesmo com o código `55` na frente;
// - números do Brasil (+55) são validados como a libphonenumber os valida: DDD de dois dígitos sem zero (11–99), FIXO de 10
//   dígitos cujo número começa em 2–5, CELULAR de 11 dígitos com 9 depois do DDD. Não valida se o DDD existe;
// - o prefixo nacional "0" (ex.: "011 98765-4321") é aceito e removido no formato nacional;
// - fora do Brasil só há validação SINTÁTICA (8–15 dígitos): país e faixa de numeração não são conferidos.
// Aceita espaços, parênteses, hífens e pontos como separadores; qualquer outro caractere invalida.

const SEPARATORS = /[\s().-]/g;

function validBrazilian(national: string): boolean {
  if (!/^[1-9][1-9]\d{8,9}$/.test(national)) return false; // DDD 11–99 (sem 0 em nenhum dígito do DDD)
  if (national.length === 11) return national[2] === "9"; // celular
  return /[2-5]/.test(national[2] as string); // fixo
}

/** E.164 ("+5511987654321") ou `undefined` se a entrada não for um telefone aceito. */
export function normalizePhone(input: string): string | undefined {
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
  // Nacional (Brasil): remove UM prefixo "0" (tronco), depois aceita com ou sem o 55.
  if (body.startsWith("0")) body = body.slice(1);
  if (body.length >= 12 && body.startsWith("55")) {
    const national = body.slice(2);
    return validBrazilian(national) ? `+55${national}` : undefined;
  }
  return validBrazilian(body) ? `+55${body}` : undefined;
}
