// Aceite da etapa 11: nenhum token (nem qualquer dado) em armazenamento do navegador. A regra dinâmica vale para TODOS os
// testes (afterEach de setup.ts); esta é a regra ESTÁTICA: o código de produção nem referencia essas APIs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const production = walk(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !relative(SRC, f).startsWith("test"))
  .map((f) => ({
    path: relative(SRC, f),
    code: readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  }));

const FORBIDDEN =
  /\b(localStorage|sessionStorage|indexedDB|cookieStore|document\.cookie|caches\.|openDatabase)\b/;

// ÚNICA exceção: lib/theme.ts guarda a preferência visual sob `agendly-theme`. Só estas três chamadas, sempre com a
// constante THEME_KEY, são toleradas ali; qualquer outro uso de armazenamento (outra chave, alias, sessionStorage...) falha.
const THEME_FILE = "lib/theme.ts";
const THEME_CALLS =
  /localStorage\.(getItem|removeItem)\(THEME_KEY\)|localStorage\.setItem\(THEME_KEY,/g;
const withoutThemeCalls = (code: string) => code.replace(THEME_CALLS, "");

describe("armazenamento do navegador", () => {
  it("o código de produção não usa localStorage, sessionStorage, IndexedDB, cookies via JS nem Cache API (exceto a preferência de tema)", () => {
    expect(production.length).toBeGreaterThan(10); // sanidade: o scanner leu os arquivos
    expect(
      production
        .filter((f) => f.path !== THEME_FILE)
        .filter((f) => FORBIDDEN.test(f.code))
        .map((f) => f.path),
    ).toEqual([]);
  });

  it("lib/theme.ts usa o armazenamento só para a chave agendly-theme", () => {
    const theme = production.find((f) => f.path === THEME_FILE);
    expect(theme).toBeDefined();
    const code = theme?.code ?? "";
    expect(code).toContain('export const THEME_KEY = "agendly-theme";');
    expect(code.match(THEME_CALLS)?.length).toBe(3);
    expect(FORBIDDEN.test(withoutThemeCalls(code))).toBe(false);
  });

  it("o detector da exceção acusa uso fora da chave de tema (teste do teste)", () => {
    for (const bad of [
      'localStorage.setItem("token", t)',
      "localStorage.getItem(OUTRA_CHAVE)",
      "const s = localStorage; s.setItem(THEME_KEY, v)",
      "sessionStorage.setItem(THEME_KEY, v)",
      "document.cookie = THEME_KEY",
    ])
      expect(FORBIDDEN.test(withoutThemeCalls(bad)), bad).toBe(true);
    expect(
      FORBIDDEN.test(
        withoutThemeCalls(
          "localStorage.setItem(THEME_KEY, p); localStorage.getItem(THEME_KEY); localStorage.removeItem(THEME_KEY)",
        ),
      ),
    ).toBe(false);
  });

  it("o detector acusa o uso proibido (teste do teste)", () => {
    for (const bad of [
      "localStorage.setItem('t','x')",
      "window.sessionStorage",
      "document.cookie = 'a=b'",
      "indexedDB.open('x')",
    ])
      expect(FORBIDDEN.test(bad), bad).toBe(true);
    expect(FORBIDDEN.test("const storage = createStore()")).toBe(false);
  });

  it("o frontend não importa código do backend (contrato fica em src/api)", () => {
    expect(
      production
        .filter((f) => /from\s+["'][^"']*backend/.test(f.code))
        .map((f) => f.path),
    ).toEqual([]);
  });

  it("nenhum segredo/URL de API fixa no código: o cliente usa só caminhos relativos /api", () => {
    const hardcoded = production
      .filter((f) => /https?:\/\/(localhost|127\.0\.0\.1)/.test(f.code))
      .map((f) => f.path);
    expect(hardcoded).toEqual([]);
  });
});
