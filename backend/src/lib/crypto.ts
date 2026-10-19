import { createHash, randomBytes } from "node:crypto";

/** Token opaco de 32 bytes (256 bits) de um CSPRNG, em base64url (43 caracteres). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
