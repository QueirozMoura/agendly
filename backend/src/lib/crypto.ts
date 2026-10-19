import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** Token opaco de 32 bytes (256 bits) de um CSPRNG, em base64url (43 caracteres). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// --- Cifragem do payload da outbox (3.6, V14): AES-256-GCM do módulo nativo do Node ---

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptError extends Error {}

/** Formato: iv(12) | tag(16) | texto cifrado. O `aad` (ex.: id da linha) é autenticado, não cifrado. */
export function encryptPayload(
  key: Buffer,
  plaintext: string,
  aad: string,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptPayload(key: Buffer, data: Buffer, aad: string): string {
  if (data.length < IV_BYTES + TAG_BYTES)
    throw new DecryptError("payload curto demais");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      data.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptError("falha na autenticação do payload");
  }
}
