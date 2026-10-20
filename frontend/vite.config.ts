import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Desenvolvimento: o Vite serve a SPA em http://localhost:5173 (a origem permitida por padrão pelo backend, 3.1) e faz
// proxy de /api para o backend local. Em produção a SPA e a API ficam na mesma origem (sem CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3000" } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
