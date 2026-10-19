// V16 — memberships.role: enum nativo vs texto com CHECK, pensando em ADMIN no futuro.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cwd = new URL("../..", import.meta.url);
const diffScript = (schemaFile: string, from: string) =>
  execFileSync(
    "npx",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-schema",
      from,
      "--to-schema",
      schemaFile,
      "--script",
    ],
    { cwd, encoding: "utf8" },
  );

describe("V16 mecanismo extensível de role", () => {
  it("adicionar ADMIN ao enum gera um único ALTER TYPE ... ADD VALUE (migration pequena, sem reescrever a tabela)", () => {
    const current = readFileSync(
      new URL("../../prisma/schema.prisma", import.meta.url),
      "utf8",
    );
    const dir = mkdtempSync(join(tmpdir(), "agendly-v16-"));
    const next = join(dir, "schema.prisma");
    writeFileSync(next, current.replace(/OWNER \/\/[^\n]*/, "OWNER\n  ADMIN"));
    const script = diffScript(next, "prisma/schema.prisma");
    expect(script.trim()).toBe(
      `-- AlterEnum\nALTER TYPE "MembershipRole" ADD VALUE 'ADMIN';`,
    );
  });
});
