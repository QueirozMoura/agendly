import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { randomToken } from "../../lib/crypto.ts";

// Argon2id (RFC 9106) via crypto.argon2 nativo do Node >= 24.7. Parâmetros explícitos:
// 64 MiB, 3 passes, 1 lane — acima do mínimo do OWASP (19 MiB, t=2, p=1) e igual à memória/passes da
// 2ª opção do RFC 9106 §4, com p=1 para limitar o uso do threadpool do libuv (~170 ms/hash medidos).
// Os parâmetros vão dentro do hash (formato PHC), então podem ser aumentados sem invalidar hashes antigos.
export const ARGON2_PARAMS = {
  memoryKiB: 65_536,
  passes: 3,
  parallelism: 1,
  saltBytes: 16,
  tagBytes: 32,
} as const;

// Limites aceitos ao LER um hash do banco (defesa contra um registro adulterado consumir memória/CPU).
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

interface Argon2Settings {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

function derive(
  password: string,
  salt: Buffer,
  settings: Argon2Settings,
  tagBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        // NFKC: o mesmo texto digitado de formas Unicode equivalentes gera a mesma senha.
        message: password.normalize("NFKC"),
        nonce: salt,
        parallelism: settings.parallelism,
        tagLength: tagBytes,
        memory: settings.memoryKiB,
        passes: settings.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  const p = ARGON2_PARAMS;
  const salt = randomBytes(p.saltBytes);
  const key = await derive(password, salt, p, p.tagBytes);
  return `$argon2id$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Verifica em tempo constante. Hash malformado ou fora dos limites => false (nunca lança). */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const m = PHC.exec(encoded);
  if (!m) return false;
  const settings = {
    memoryKiB: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
  };
  if (
    settings.memoryKiB > MAX_MEMORY_KIB ||
    settings.passes > MAX_PASSES ||
    settings.parallelism > MAX_PARALLELISM ||
    settings.memoryKiB < 8 * settings.parallelism ||
    settings.passes < 1 ||
    settings.parallelism < 1
  ) {
    return false;
  }
  const salt = Buffer.from(m[4] as string, "base64");
  const expected = Buffer.from(m[5] as string, "base64");
  if (salt.length < 8 || expected.length < 4) return false;
  const actual = await derive(password, salt, settings, expected.length);
  return timingSafeEqual(actual, expected);
}

// Hash de uma senha aleatória descartada: usado quando o usuário não existe, para que "usuário
// inexistente" e "senha errada" gastem o mesmo tempo de CPU/memória (sem enumeração por tempo).
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(password, await dummyHash);
  return false;
}

// Lista de senhas comuns (>= 10 caracteres; ver cabeçalho do arquivo para fonte e licença).
let common: Set<string> | undefined;
export function isCommonPassword(password: string): boolean {
  common ??= new Set(
    readFileSync(new URL("./common-passwords.txt", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  return common.has(password.normalize("NFKC").toLowerCase());
}
