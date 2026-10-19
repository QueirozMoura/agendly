-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "working_hours_organization_id_professional_id_weekday_start_idx" ON "working_hours"("organization_id", "professional_id", "weekday", "start_minute");

-- CreateIndex
CREATE INDEX "time_off_organization_id_professional_id_starts_at_idx" ON "time_off"("organization_id", "professional_id", "starts_at");

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_organization_id_professional_id_fkey" FOREIGN KEY ("organization_id", "professional_id") REFERENCES "professionals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_professional_id_fkey" FOREIGN KEY ("organization_id", "professional_id") REFERENCES "professionals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- SQL manual (Etapa 9): nada disto é modelável no schema.prisma.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- working_hours: dia da semana (0 = domingo), faixa em minutos locais, múltiplos de 15 (grade de 6.2).
ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_range_valid"
  CHECK (
    "weekday" BETWEEN 0 AND 6
    AND "start_minute" >= 0
    AND "end_minute" <= 1440
    AND "start_minute" < "end_minute"
    AND "start_minute" % 15 = 0
    AND "end_minute" % 15 = 0
  );

-- Rede de segurança: intervalos do mesmo profissional e dia não se sobrepõem ([) permite encostar).
-- A aplicação já valida sob a trava N2; a exclusão vale mesmo para SQL manual.
ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_no_overlap"
  EXCLUDE USING gist (
    "professional_id" WITH =,
    "weekday" WITH =,
    int4range("start_minute", "end_minute", '[)') WITH &&
  );

ALTER TABLE "time_off"
  ADD CONSTRAINT "time_off_range_valid"
  CHECK ("ends_at" > "starts_at");
