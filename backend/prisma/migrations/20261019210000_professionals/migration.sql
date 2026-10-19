-- CreateTable
CREATE TABLE "professionals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "organization_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("professional_id","service_id")
);

-- CreateIndex
CREATE INDEX "professionals_organization_id_active_name_idx" ON "professionals"("organization_id", "active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "professionals_organization_id_id_key" ON "professionals"("organization_id", "id");

-- CreateIndex
CREATE INDEX "professional_services_organization_id_service_id_idx" ON "professional_services"("organization_id", "service_id");

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_organization_id_professional_id_fkey" FOREIGN KEY ("organization_id", "professional_id") REFERENCES "professionals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
