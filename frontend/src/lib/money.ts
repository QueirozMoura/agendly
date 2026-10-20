/** Preço digitado em reais ("50", "50,5", "1.234,56") ⇒ centavos inteiros; `null` se vazio; `undefined` se inválido. */
export function parseReaisToCents(input: string): number | null | undefined {
  const raw = input.trim();
  if (raw === "") return null;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(raw))
    return undefined;
  const [int = "", frac = ""] = raw.replaceAll(".", "").split(",");
  return Number(int) * 100 + Number(frac.padEnd(2, "0"));
}

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
export const formatCents = (cents: number): string => BRL.format(cents / 100);

/** Centavos ⇒ texto editável ("50,00"). */
export const centsToInput = (cents: number | null): string =>
  cents === null ? "" : (cents / 100).toFixed(2).replace(".", ",");
