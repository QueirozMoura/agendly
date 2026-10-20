// Hash canônico do pedido para idempotência (6.4): SHA-256 do JSON com chaves ORDENADAS do corpo já validado e
// normalizado (telefone E.164, datas UTC) + método + rota. Mesma intenção => mesmo hash, qualquer que seja a ordem das chaves.
import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): Json => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const key of Object.keys(v as object).sort())
        out[key] = walk((v as Record<string, unknown>)[key]);
      return out;
    }
    if (
      typeof v === "number" ||
      typeof v === "boolean" ||
      typeof v === "string"
    )
      return v;
    throw new TypeError(`valor não serializável no hash: ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

export function requestHash(input: {
  method: string;
  route: string;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        method: input.method,
        route: input.route,
        body: input.body,
      }),
    )
    .digest("hex");
}
