// Outbox transacional de e-mail (3.6): critérios O1–O15 e comportamento por cenário de falha.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OUTBOX_CONFIG,
  backoffMs,
  runOutboxCycle,
} from "../../src/jobs/outbox-worker.ts";
import { encryptPayload } from "../../src/lib/crypto.ts";
import { claimEmailBatch } from "../../src/lib/db/locks/outbox.ts";
import { makeKeyring } from "../../src/lib/email/keyring.ts";
import { EmailSendError } from "../../src/lib/email/sender.ts";
import { newId } from "../../src/lib/ids.ts";
import { rawClient } from "../support/databases.ts";
import { TEST_DB } from "../support/databases.ts";
import { TEST_KEYRING } from "../support/auth-app.ts";
import {
  TOKEN,
  makeOutboxHarness,
  type OutboxHarness,
} from "../support/outbox.ts";

let h: OutboxHarness;
beforeEach(async () => {
  h = await makeOutboxHarness();
});
afterEach(() => h.close());

const row = (id: string) =>
  h.prisma.emailOutbox.findUniqueOrThrow({ where: { id } });
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("envio e retentativas", () => {
  it("envia, marca SENT e APAGA o payload (O8); o link usa fragmento e o corpo não tem o token em query", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    expect(await runOutboxCycle(h.deps)).toBe(1);
    expect(h.sender.calls).toHaveLength(1);
    const msg = h.sender.calls[0]!;
    expect(msg.to).toBe("dest@example.com");
    expect(msg.text).toContain(
      `https://app.exemplo.com/redefinir-senha#token=${TOKEN}`,
    );
    expect(msg.text).not.toContain(`?token=`);
    const r = await row(id);
    expect(r).toMatchObject({
      status: "SENT",
      payloadEncrypted: null,
      lockToken: null,
      lockedUntil: null,
      attempts: 1,
    });
    expect(r.sentAt).not.toBeNull();
  });

  it("O1: falha 3 vezes e depois funciona => backoff crescente e termina SENT", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    h.sender.behavior = async (n) => {
      if (n <= 3) throw new Error("provedor indisponível (5xx)");
    };
    const nextAttempts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await runOutboxCycle(h.deps);
      const r = await row(id);
      if (r.status === "PENDING") {
        nextAttempts.push(r.nextAttemptAt.getTime() - h.clock.now().getTime());
        h.clock.advance(
          r.nextAttemptAt.getTime() - h.clock.now().getTime() + 1,
        );
      }
    }
    expect(nextAttempts).toEqual([30_000, 60_000, 120_000]); // base 30 s dobrando; jitter neutro
    const r = await row(id);
    expect(r).toMatchObject({
      status: "SENT",
      attempts: 4,
      payloadEncrypted: null,
    });
    expect(h.sender.calls).toHaveLength(4);
  });

  it("não reenvia antes de next_attempt_at", async () => {
    await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    h.sender.behavior = async () => {
      throw new Error("falha");
    };
    await runOutboxCycle(h.deps);
    expect(await runOutboxCycle(h.deps)).toBe(0); // ainda no backoff
    expect(h.sender.calls).toHaveLength(1);
  });

  it("O2: provedor sempre falhando => DEAD (MAX_ATTEMPTS) sem laço infinito e sem token em last_error nem nos logs", async () => {
    const id = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { ttlMs: DAY },
    );
    h.sender.behavior = async () => {
      throw new Error(
        `smtp recusou o conteúdo com o link ...#token=${TOKEN} (senha da chave: ${TEST_KEYRING.secrets()[0]})`,
      );
    };
    for (let i = 0; i < DEFAULT_OUTBOX_CONFIG.maxAttempts + 3; i++) {
      await runOutboxCycle(h.deps);
      h.clock.advance(20 * MIN);
    }
    const r = await row(id);
    expect(r).toMatchObject({
      status: "DEAD",
      deadReason: "MAX_ATTEMPTS",
      payloadEncrypted: null,
    });
    expect(r.attempts).toBe(DEFAULT_OUTBOX_CONFIG.maxAttempts);
    expect(h.sender.calls).toHaveLength(DEFAULT_OUTBOX_CONFIG.maxAttempts);
    expect(r.lastError).toContain("[REDACTED]");
    expect(r.lastError).not.toContain(TOKEN);
    expect(h.logger.text()).not.toContain(TOKEN);
    expect(h.logger.text()).toContain("email outbox message is dead"); // alerta operacional
  });

  it("falha permanente => DEAD (PERMANENT_ERROR) na 1ª tentativa, sem novas tentativas", async () => {
    const id = await h.enqueue("VERIFY_EMAIL", { name: "Ana", token: TOKEN });
    h.sender.behavior = async () => {
      throw new EmailSendError("destinatário rejeitado em definitivo", true);
    };
    await runOutboxCycle(h.deps);
    h.clock.advance(60 * MIN);
    await runOutboxCycle(h.deps);
    expect(await row(id)).toMatchObject({
      status: "DEAD",
      deadReason: "PERMANENT_ERROR",
      attempts: 1,
      payloadEncrypted: null,
    });
    expect(h.sender.calls).toHaveLength(1);
  });

  it("timeout do provedor => falha transitória (o sinal de abortar é acionado)", async () => {
    const h2 = await makeOutboxHarness({ config: { sendTimeoutMs: 40 } });
    try {
      const id = await h2.enqueue("RESET_PASSWORD", { token: TOKEN });
      h2.sender.behavior = () => new Promise(() => {}); // nunca responde
      await runOutboxCycle(h2.deps);
      const r = await h2.prisma.emailOutbox.findUniqueOrThrow({
        where: { id },
      });
      expect(r.status).toBe("PENDING");
      expect(r.lastError).toContain("timeout");
      expect(h2.sender.signals[0]?.aborted).toBe(true);
    } finally {
      await h2.close();
    }
  });

  it("backoff: exponencial, com teto e jitter de ±20%", () => {
    const cfg = DEFAULT_OUTBOX_CONFIG;
    expect(backoffMs(1, cfg, () => 0.5)).toBe(30_000);
    expect(backoffMs(2, cfg, () => 0.5)).toBe(60_000);
    expect(backoffMs(20, cfg, () => 0.5)).toBe(cfg.backoffMaxMs);
    expect(backoffMs(3, cfg, () => 0)).toBe(96_000);
    expect(backoffMs(3, cfg, () => 1)).toBe(144_000);
  });
});

describe("O7 — not_after", () => {
  it("vencido => DEAD (EXPIRED) sem chamar o provedor, mesmo nunca tentada", async () => {
    const id = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { ttlMs: 30 * MIN },
    );
    h.clock.advance(31 * MIN);
    await runOutboxCycle(h.deps);
    expect(h.sender.calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      status: "DEAD",
      deadReason: "EXPIRED",
      payloadEncrypted: null,
    });
  });

  it("é verificado antes de CADA tentativa (venceu durante os retries)", async () => {
    const id = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { ttlMs: 45 * MIN },
    );
    h.sender.behavior = async () => {
      throw new Error("falha");
    };
    await runOutboxCycle(h.deps); // 1ª tentativa falha
    h.clock.advance(46 * MIN);
    await runOutboxCycle(h.deps);
    expect((await row(id)).deadReason).toBe("EXPIRED");
    expect(h.sender.calls).toHaveLength(1);
  });
});

describe("concorrência: lease, SKIP LOCKED e reinício", () => {
  it("O3: lease vencido => outra tentativa reenvia (duplicata aceita) e o processo atrasado NÃO sobrescreve o estado", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    let releaseA!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      h.sender.behavior = (n) => {
        if (n === 1) {
          resolve();
          return new Promise<void>((_, reject) => {
            releaseA = () => reject(new Error("falha tardia do processo A"));
          });
        }
        return Promise.resolve();
      };
    });
    const cycleA = runOutboxCycle({
      ...h.deps,
      config: { sendTimeoutMs: 10 * 60_000 },
    });
    await aStarted;

    h.clock.advance(DEFAULT_OUTBOX_CONFIG.leaseMs + 1000); // o lease de A venceu
    expect(await runOutboxCycle(h.deps)).toBe(1); // B reivindica e envia
    expect(await row(id)).toMatchObject({ status: "SENT", attempts: 2 });
    expect(h.sender.calls).toHaveLength(2); // duplicata: registrada e aceita

    releaseA(); // A falha só agora; sua atualização final usa o lock_token antigo
    await cycleA;
    const r = await row(id);
    expect(r).toMatchObject({ status: "SENT", payloadEncrypted: null }); // não voltou para PENDING
    expect(h.logger.text()).toContain("lock lost");
  });

  it("O4: dois ciclos concorrentes nunca processam a mesma linha ao mesmo tempo", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.enqueue(
          "RESET_PASSWORD",
          { token: `${TOKEN}-${i}` },
          { to: `u${i}@example.com` },
        ),
      ),
    );
    h.sender.behavior = async () => {
      await new Promise((r) => setTimeout(r, 20));
    };
    const counts = await Promise.all([
      runOutboxCycle({ ...h.deps, config: { batchSize: 7 } }),
      runOutboxCycle({ ...h.deps, config: { batchSize: 7 } }),
    ]);
    expect(counts[0]! + counts[1]!).toBe(12);
    const recipients = h.sender.calls.map((c) => c.to);
    expect(new Set(recipients).size).toBe(12); // cada destinatário exatamente uma vez
    for (const id of ids) expect((await row(id)).status).toBe("SENT");
  });

  it("linha travada por outra transação é PULADA (SKIP LOCKED), sem esperar", async () => {
    const locked = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "travada@example.com" },
    );
    await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN + "x" },
      { to: "livre@example.com" },
    );
    const c = await rawClient(TEST_DB);
    await c.query("BEGIN");
    await c.query("SELECT id FROM email_outbox WHERE id = $1 FOR UPDATE", [
      locked,
    ]);
    const started = Date.now();
    expect(await runOutboxCycle(h.deps)).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
    await c.query("ROLLBACK");
    await c.end();
    expect(h.sender.calls.map((m) => m.to)).toEqual(["livre@example.com"]);
    expect((await row(locked)).status).toBe("PENDING");
  });

  it("O9: processo morto durante SENDING => nada se perde; reenvio só depois do lease (duplicata no limite documentado)", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    // "Processo" que reivindica e morre antes de enviar/finalizar.
    const claimed = await claimEmailBatch(h.prisma, {
      now: h.clock.now(),
      limit: 10,
      leaseMs: DEFAULT_OUTBOX_CONFIG.leaseMs,
    });
    expect(claimed).toHaveLength(1);
    expect((await row(id)).status).toBe("SENDING");

    expect(await runOutboxCycle(h.deps)).toBe(0); // reinício imediato: lease ainda vale
    h.clock.advance(DEFAULT_OUTBOX_CONFIG.leaseMs + 1);
    expect(await runOutboxCycle(h.deps)).toBe(1); // lease venceu: reivindicada de novo
    expect(await row(id)).toMatchObject({ status: "SENT", attempts: 2 });
    expect(h.sender.calls).toHaveLength(1);
  });

  it("processo que morre repetidamente esgota as tentativas (attempts conta já na reivindicação)", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    for (let i = 0; i <= DEFAULT_OUTBOX_CONFIG.maxAttempts; i++) {
      await claimEmailBatch(h.prisma, {
        now: h.clock.now(),
        limit: 1,
        leaseMs: 1000,
      });
      h.clock.advance(5000);
    }
    await runOutboxCycle(h.deps);
    expect(await row(id)).toMatchObject({
      status: "DEAD",
      deadReason: "MAX_ATTEMPTS",
    });
    expect(h.sender.calls).toHaveLength(0);
  });
});

describe("chave de cifragem (O11–O14)", () => {
  it("O11: key_id desconhecido => DEAD (KEY_UNAVAILABLE), provedor NÃO chamado, as demais linhas seguem", async () => {
    const other = makeKeyring(
      new Map([["antiga", Buffer.alloc(32, 1)]]),
      "antiga",
    );
    const orphan = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "orfa@example.com", keyring: other },
    );
    const good = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN + "b" },
      { to: "boa@example.com" },
    );
    await runOutboxCycle(h.deps);
    expect(await row(orphan)).toMatchObject({
      status: "DEAD",
      deadReason: "KEY_UNAVAILABLE",
      payloadEncrypted: null,
    });
    expect((await row(good)).status).toBe("SENT");
    expect(h.sender.calls.map((m) => m.to)).toEqual(["boa@example.com"]);
    expect(h.logger.text()).not.toContain(TOKEN);
  });

  it("O12: chave errada para um key_id conhecido (ou payload adulterado) => DEAD (DECRYPT_FAILED)", async () => {
    const wrong = makeKeyring(new Map([["t1", Buffer.alloc(32, 77)]]), "t1"); // mesmo id, bytes diferentes
    const a = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { keyring: wrong },
    );
    const b = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    const stored = await row(b);
    const tampered = Buffer.from(stored.payloadEncrypted!);
    tampered[tampered.length - 1]! ^= 0xff;
    await h.prisma.emailOutbox.update({
      where: { id: b },
      data: { payloadEncrypted: Uint8Array.from(tampered) },
    });
    await runOutboxCycle(h.deps);
    expect((await row(a)).deadReason).toBe("DECRYPT_FAILED");
    expect((await row(b)).deadReason).toBe("DECRYPT_FAILED");
    expect(h.sender.calls).toHaveLength(0);
  });

  it("payload copiado para outra linha não decifra (o id da linha é o AAD)", async () => {
    const a = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "a@example.com" },
    );
    const b = await h.enqueue(
      "RESET_PASSWORD",
      { token: "outro" },
      { to: "b@example.com" },
    );
    const ra = await row(a);
    await h.prisma.emailOutbox.update({
      where: { id: b },
      data: { payloadEncrypted: ra.payloadEncrypted! },
    });
    await runOutboxCycle(h.deps);
    expect((await row(b)).deadReason).toBe("DECRYPT_FAILED");
    expect((await row(a)).status).toBe("SENT");
  });

  it("payload decifrado mas fora do formato do template => DEAD (DECRYPT_FAILED)", async () => {
    const id = newId();
    await h.prisma.emailOutbox.create({
      data: {
        id,
        toEmail: "x@example.com",
        template: "RESET_PASSWORD",
        payloadEncrypted: Uint8Array.from(
          encryptPayload(
            TEST_KEYRING.get("t1")!,
            JSON.stringify({ lixo: 1 }),
            id,
          ),
        ),
        keyId: "t1",
        nextAttemptAt: h.clock.now(),
        notAfter: new Date(h.clock.now().getTime() + 60 * MIN),
      },
    });
    await runOutboxCycle(h.deps);
    expect((await row(id)).deadReason).toBe("DECRYPT_FAILED");
  });

  it("O13: rotação — linha cifrada com a chave antiga decifra enquanto ela estiver configurada", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const before = makeKeyring(new Map([["k1", oldKey]]), "k1");
    const afterRotation = makeKeyring(
      new Map([
        ["k1", oldKey],
        ["k2", newKey],
      ]),
      "k2",
    );
    const oldRow = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "velha@example.com", keyring: before },
    );
    const newRow = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN + "n" },
      { to: "nova@example.com", keyring: afterRotation },
    );
    expect((await row(oldRow)).keyId).toBe("k1");
    expect((await row(newRow)).keyId).toBe("k2"); // linhas novas usam a corrente
    await runOutboxCycle({ ...h.deps, keyring: afterRotation });
    expect((await row(oldRow)).status).toBe("SENT");
    expect((await row(newRow)).status).toBe("SENT");
  });

  it("O13b: remover a chave antiga antes da hora torna as linhas remanescentes KEY_UNAVAILABLE", async () => {
    const before = makeKeyring(new Map([["k1", Buffer.alloc(32, 1)]]), "k1");
    const only2 = makeKeyring(new Map([["k2", Buffer.alloc(32, 2)]]), "k2");
    const id = await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { keyring: before },
    );
    await runOutboxCycle({ ...h.deps, keyring: only2 });
    expect((await row(id)).deadReason).toBe("KEY_UNAVAILABLE");
  });
});

describe("integridade e vazamento", () => {
  it("O8 no banco: o CHECK impede SENT/DEAD com payload e DEAD sem motivo", async () => {
    const id = await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    const c = await rawClient(TEST_DB);
    const sql = (q: string) =>
      c.query(q, [id]).catch((e) => e as { code: string; constraint: string });
    const a = await sql(
      "UPDATE email_outbox SET status = 'SENT' WHERE id = $1",
    );
    const b = await sql(
      "UPDATE email_outbox SET status = 'DEAD', payload_encrypted = NULL WHERE id = $1",
    );
    const d = await sql(
      "UPDATE email_outbox SET payload_encrypted = NULL WHERE id = $1",
    ); // PENDING sem payload
    const e = await sql(
      "UPDATE email_outbox SET dead_reason = 'EXPIRED' WHERE id = $1",
    );
    await c.end();
    expect([a, b, d, e].map((r) => (r as { code: string }).code)).toEqual([
      "23514",
      "23514",
      "23514",
      "23514",
    ]);
    expect((a as { constraint: string }).constraint).toBe(
      "email_outbox_payload_lifecycle",
    );
  });

  it("o banco nunca guarda o token em claro (nem em payload_encrypted, nem em last_error)", async () => {
    await h.enqueue("RESET_PASSWORD", { token: TOKEN });
    const c = await rawClient(TEST_DB);
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM email_outbox WHERE position($1::bytea IN payload_encrypted) > 0",
      [Buffer.from(TOKEN)],
    );
    await c.end();
    expect(rows[0].n).toBe(0);
  });

  it("O15: nenhum log nem last_error contém payload, token ou chave, em nenhum cenário de falha", async () => {
    const wrong = makeKeyring(new Map([["t1", Buffer.alloc(32, 77)]]), "t1");
    await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { keyring: wrong, to: "a@example.com" },
    ); // DECRYPT_FAILED
    await h.enqueue(
      "RESET_PASSWORD",
      { token: TOKEN },
      { to: "b@example.com", ttlMs: 1 },
    ); // EXPIRED
    await h.enqueue(
      "VERIFY_EMAIL",
      { name: "Nome Secreto", token: TOKEN },
      { to: "c@example.com", ttlMs: DAY },
    ); // MAX_ATTEMPTS
    h.clock.advance(5);
    h.sender.behavior = async () => {
      throw new Error(`erro com ${TOKEN} e Nome Secreto`);
    };
    for (let i = 0; i < 12; i++) {
      await runOutboxCycle(h.deps);
      h.clock.advance(20 * MIN);
    }
    const rows = await h.prisma.emailOutbox.findMany();
    const everything = `${h.logger.text()}\n${JSON.stringify(rows)}`;
    for (const secret of [TOKEN, "Nome Secreto", ...TEST_KEYRING.secrets()]) {
      expect(everything).not.toContain(secret);
    }
    expect(
      rows.every((r) => r.status === "DEAD" && r.payloadEncrypted === null),
    ).toBe(true);
  });
});
