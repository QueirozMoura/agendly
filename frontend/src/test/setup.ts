import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
// ÚNICA exceção: a preferência visual de tema, sob a chave `agendly-theme` (literal de propósito: se a chave do código
// mudar, o teste de lib/theme acusa) e só com valor "light" ou "dark".
const THEME_STORAGE_KEY = "agendly-theme";
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  // Regra global (aceite da etapa 11): NENHUM teste pode deixar dado no armazenamento do navegador (token, e-mail,
  // senha, usuário...), exceto a preferência de tema. A sessão vive só no cookie HttpOnly.
  const { [THEME_STORAGE_KEY]: theme, ...otherLocal } = { ...localStorage };
  expect({ local: otherLocal, session: { ...sessionStorage } }).toEqual({
    local: {},
    session: {},
  });
  if (theme !== undefined) expect(["light", "dark"]).toContain(theme);
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
