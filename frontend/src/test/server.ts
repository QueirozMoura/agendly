import { setupServer } from "msw/node";

/** Servidor MSW compartilhado: cada teste instala o backend falso que precisa com `server.use(...)`. */
export const server = setupServer();
