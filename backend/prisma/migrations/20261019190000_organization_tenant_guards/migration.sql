-- Etapa 6: invariantes de empresa que o Prisma não modela (SQL manual; ver docs/STAGE-6-VALIDATIONS.md).

-- Exatamente 1 OWNER por empresa (3.2, seção 5). Continua válido quando o papel ADMIN existir.
CREATE UNIQUE INDEX "memberships_one_owner_per_organization"
  ON "memberships" ("organization_id")
  WHERE "role" = 'OWNER';

-- Slug: minúsculas, números e hífens (sem hífen no início, no fim ou repetido), 3 a 40 caracteres.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_slug_format" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 40
  );

-- O fuso horário é imutável após a criação no MVP (R9): o banco recusa qualquer alteração.
CREATE FUNCTION "organizations_timezone_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."timezone" IS DISTINCT FROM OLD."timezone" THEN
    RAISE EXCEPTION 'organizations.timezone é imutável' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "organizations_timezone_immutable"
  BEFORE UPDATE OF "timezone" ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION "organizations_timezone_immutable"();
