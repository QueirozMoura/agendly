import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  hashPassword,
  isCommonPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "../../src/modules/auth/password.ts";

describe("hash de senha (Argon2id)", () => {
  it("usa o formato PHC com os parâmetros explícitos e sal único", async () => {
    const [a, b] = await Promise.all([
      hashPassword("senha-segura-123"),
      hashPassword("senha-segura-123"),
    ]);
    expect(a).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(a).not.toBe(b);
    expect(a).not.toContain("senha-segura-123");
  });

  it("parâmetros não ficam abaixo do mínimo do OWASP (19 MiB, 2 passes, 1 lane)", () => {
    expect(ARGON2_PARAMS.memoryKiB).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2_PARAMS.passes).toBeGreaterThanOrEqual(2);
    expect(ARGON2_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
    expect(ARGON2_PARAMS.saltBytes).toBeGreaterThanOrEqual(16);
  });

  it("verifica a senha correta e rejeita a errada", async () => {
    const hash = await hashPassword("senha-segura-123");
    expect(await verifyPassword("senha-segura-123", hash)).toBe(true);
    expect(await verifyPassword("senha-segura-124", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("formas Unicode equivalentes (NFC/NFD) valem como a mesma senha", async () => {
    const hash = await hashPassword("açaí-com-banana-1");
    expect(
      await verifyPassword("açaí-com-banana-1".normalize("NFD"), hash),
    ).toBe(true);
  });

  it("hash malformado, de outro algoritmo ou com parâmetros abusivos => false, sem lançar", async () => {
    for (const bad of [
      "",
      "texto-puro",
      "$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123456",
      "$argon2id$v=19$m=4294967295,t=1,p=1$c2FsdHNhbHRzYWx0$YWJjZGVmZ2g",
      "$argon2id$v=19$m=65536,t=999,p=1$c2FsdHNhbHRzYWx0$YWJjZGVmZ2g",
      "$argon2id$v=19$m=65536,t=3,p=1$YQ$YWJjZGVmZ2g",
    ]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("verifyAgainstDummy sempre falha (usuário inexistente)", async () => {
    expect(await verifyAgainstDummy("qualquer-coisa-123")).toBe(false);
  });
});

describe("lista de senhas comuns", () => {
  it("reconhece senhas comuns (sem diferenciar maiúsculas) e aceita as demais", () => {
    expect(isCommonPassword("password123")).toBe(true);
    expect(isCommonPassword("PassWord123")).toBe(true);
    expect(isCommonPassword("1234567890")).toBe(true);
    expect(isCommonPassword("uma-senha-bem-longa-9X")).toBe(false);
  });
});
