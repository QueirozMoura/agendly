import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  // Regra global (aceite da etapa 11): NENHUM teste pode deixar dado no armazenamento do navegador (token, e-mail,
  // senha, usuário...). A sessão vive só no cookie HttpOnly.
  const stored = { local: { ...localStorage }, session: { ...sessionStorage } };
  expect(stored).toEqual({ local: {}, session: {} });
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
