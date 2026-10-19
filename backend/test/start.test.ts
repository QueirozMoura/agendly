import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Env } from "../src/config/env.ts";
import type { DatabaseCheck } from "../src/lib/db/ping.ts";
import { startServer, type RunningServer } from "../src/start.ts";

function env(port = 0): Env {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: port,
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  };
}

function fakeDb(overrides: Partial<DatabaseCheck> = {}) {
  const db = {
    check: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  return db;
}

let running: RunningServer | undefined;
const blockers: net.Server[] = [];
afterEach(async () => {
  await running?.shutdown().catch(() => {});
  running = undefined;
  await Promise.all(
    blockers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});

describe("shutdown", () => {
  it("é idempotente: chamadas concorrentes fecham app e pool uma única vez", async () => {
    const db = fakeDb();
    running = await startServer(env(), { createDatabase: () => db });
    const closeSpy = vi.spyOn(running.app, "close");

    await Promise.all([
      running.shutdown(),
      running.shutdown(),
      running.shutdown(),
    ]);
    await running.shutdown();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("tenta fechar o pool mesmo se app.close() falhar, e propaga o erro", async () => {
    const db = fakeDb();
    running = await startServer(env(), {
      createDatabase: () => db,
      buildApp: (options) => {
        const app = buildApp(options);
        app.addHook("onClose", async () => {
          throw new Error("falha ao fechar app");
        });
        return app;
      },
    });

    await expect(running.shutdown()).rejects.toThrow("falha ao fechar app");
    expect(db.close).toHaveBeenCalledTimes(1);
    // Segunda chamada devolve o mesmo resultado, sem refazer o fechamento.
    await expect(running.shutdown()).rejects.toThrow("falha ao fechar app");
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("agrega erros quando app e pool falham", async () => {
    const db = fakeDb({
      close: vi.fn(async () => Promise.reject(new Error("falha no pool"))),
    });
    running = await startServer(env(), {
      createDatabase: () => db,
      buildApp: (options) => {
        const app = buildApp(options);
        app.addHook("onClose", async () => {
          throw new Error("falha ao fechar app");
        });
        return app;
      },
    });
    const err = await running.shutdown().catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors).toHaveLength(2);
  });
});

describe("falhas de inicialização", () => {
  it("libera o pool se app.listen() falhar (porta ocupada)", async () => {
    const blocker = net.createServer();
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as net.AddressInfo;

    const db = fakeDb();
    await expect(
      startServer(env(port), { createDatabase: () => db }),
    ).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("libera o pool se buildApp() lançar, preservando o erro original", async () => {
    const db = fakeDb();
    await expect(
      startServer(env(), {
        createDatabase: () => db,
        buildApp: () => {
          throw new Error("falha ao montar app");
        },
      }),
    ).rejects.toThrow("falha ao montar app");
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("registra falha de limpeza sem mascarar o erro original", async () => {
    const db = fakeDb({
      close: vi.fn(async () => Promise.reject(new Error("pool não fechou"))),
    });
    const logError = vi.fn();
    await expect(
      startServer(env(), {
        createDatabase: () => db,
        logError,
        buildApp: () => {
          throw new Error("falha ao montar app");
        },
      }),
    ).rejects.toThrow("falha ao montar app");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toMatchObject({
      message: "pool não fechou",
    });
  });
});
