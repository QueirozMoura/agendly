import { KEY_BYTES } from "../crypto.ts";

/** Chaves de cifragem do payload da outbox, por key_id (3.6). Nunca no banco, no Git nem nos logs. */
export interface Keyring {
  readonly currentId: string;
  get(id: string): Buffer | undefined;
  /** Valores sensíveis (para mascarar em mensagens de erro). */
  secrets(): string[];
}

export class KeyringError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,32}$/;

/** `keys` no formato `id:base64,id2:base64` (cada chave com exatamente 32 bytes); `currentId` deve existir. */
export function parseKeyring(keys: string, currentId: string): Keyring {
  const map = new Map<string, Buffer>();
  for (const part of keys.split(",")) {
    const [id, b64, ...rest] = part.trim().split(":");
    const key = b64 === undefined ? undefined : Buffer.from(b64, "base64");
    if (
      !id ||
      !ID.test(id) ||
      rest.length > 0 ||
      !key ||
      key.length !== KEY_BYTES
    ) {
      throw new KeyringError("chave de cifragem malformada");
    }
    if (map.has(id)) throw new KeyringError("key_id duplicado");
    map.set(id, key);
  }
  if (!map.has(currentId)) throw new KeyringError("chave corrente ausente");
  return makeKeyring(map, currentId);
}

export function makeKeyring(
  map: ReadonlyMap<string, Buffer>,
  currentId: string,
): Keyring {
  return {
    currentId,
    get: (id) => map.get(id),
    secrets: () =>
      [...map.values()].flatMap((k) => [
        k.toString("base64"),
        k.toString("hex"),
      ]),
  };
}
