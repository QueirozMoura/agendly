-- CreateEnum
CREATE TYPE "EmailTemplate" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD', 'PASSWORD_CHANGED', 'ACCOUNT_EXISTS');

-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DEAD');

-- CreateEnum
CREATE TYPE "EmailDeadReason" AS ENUM ('MAX_ATTEMPTS', 'EXPIRED', 'PERMANENT_ERROR', 'KEY_UNAVAILABLE', 'DECRYPT_FAILED');

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "to_email" TEXT NOT NULL,
    "template" "EmailTemplate" NOT NULL,
    "payload_encrypted" BYTEA,
    "key_id" TEXT,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dead_reason" "EmailDeadReason",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "lock_token" UUID,
    "not_after" TIMESTAMPTZ(3) NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_status_next_attempt_at_idx" ON "email_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "email_outbox_status_locked_until_idx" ON "email_outbox"("status", "locked_until");

-- SQL manual (não modelado pelo Prisma): ciclo de vida do payload e do motivo de morte (3.6, O8).
-- Mensagens em andamento TÊM payload cifrado e key_id; finalizadas (SENT/DEAD) NÃO têm payload.
ALTER TABLE "email_outbox"
  ADD CONSTRAINT "email_outbox_payload_lifecycle" CHECK (
    ("status" IN ('PENDING', 'SENDING') AND "payload_encrypted" IS NOT NULL AND "key_id" IS NOT NULL)
    OR ("status" IN ('SENT', 'DEAD') AND "payload_encrypted" IS NULL)
  );

-- dead_reason preenchido se, e somente se, a mensagem está DEAD.
ALTER TABLE "email_outbox"
  ADD CONSTRAINT "email_outbox_dead_reason_consistent" CHECK (("status" = 'DEAD') = ("dead_reason" IS NOT NULL));
