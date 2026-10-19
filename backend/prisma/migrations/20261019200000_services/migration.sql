-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    "price_cents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "services_organization_id_active_name_idx" ON "services"("organization_id", "active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "services_organization_id_id_key" ON "services"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- SQL manual (não modelado pelo Prisma): pisos de 5/6.3. Os tetos de sanidade ficam na validação da API.
ALTER TABLE "services"
  ADD CONSTRAINT "services_duration_positive" CHECK ("duration_minutes" >= 1),
  ADD CONSTRAINT "services_buffer_non_negative" CHECK ("buffer_minutes" >= 0),
  ADD CONSTRAINT "services_price_non_negative" CHECK ("price_cents" IS NULL OR "price_cents" >= 0);
