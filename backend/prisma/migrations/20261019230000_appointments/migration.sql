-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('PANEL', 'PUBLIC');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "service_name_snapshot" TEXT NOT NULL,
    "duration_minutes_snapshot" INTEGER NOT NULL,
    "buffer_minutes_snapshot" INTEGER NOT NULL,
    "price_cents_snapshot" INTEGER,
    "source" "AppointmentSource" NOT NULL,
    "created_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "appointment_id" UUID,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_phone_e164_key" ON "customers"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "appointments_organization_id_professional_id_starts_at_idx" ON "appointments"("organization_id", "professional_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_organization_id_customer_id_starts_at_idx" ON "appointments"("organization_id", "customer_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_organization_id_starts_at_idx" ON "appointments"("organization_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_organization_id_id_key" ON "appointments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organization_id_scope_key_key" ON "idempotency_records"("organization_id", "scope", "key");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_professional_id_fkey" FOREIGN KEY ("organization_id", "professional_id") REFERENCES "professionals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- SQL manual (Etapa 10; decisões V4/V5/V8 da Etapa 3): nada disto é modelável no schema.prisma.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Telefone sempre em E.164 (a aplicação normaliza; o banco recusa o que não tiver o formato).
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_phone_e164_format"
  CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_range_valid"
  CHECK ("ends_at" > "starts_at" AND "blocked_until" >= "ends_at");

-- V8, opção 1 aprovada: a aplicação calcula (`computeAppointmentRange`); o banco rejeita valores incoerentes.
-- Toda remarcação precisa recalcular starts_at, ends_at e blocked_until juntos.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_range_coherent"
  CHECK (
    "ends_at" = "starts_at" + make_interval(mins => "duration_minutes_snapshot")
    AND "blocked_until" = "ends_at" + make_interval(mins => "buffer_minutes_snapshot")
  );

-- Somente agendamentos ativos bloqueiam; faixa = atendimento + buffer; [) permite encostar. Violação => 23P01.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "professional_id" WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  ) WHERE ("status" IN ('SCHEDULED', 'CONFIRMED'));

-- Índice parcial dos ativos (V4): consultas de disponibilidade e de conflito com folgas/expediente.
CREATE INDEX "appointments_active_idx"
  ON "appointments" ("organization_id", "professional_id", "starts_at")
  WHERE "status" IN ('SCHEDULED', 'CONFIRMED');
