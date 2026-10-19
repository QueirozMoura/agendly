import { defineConfig } from "prisma/config";
import { databaseUrl } from "./tools/database-url.ts";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl(process.env.AGENDLY_DB_NAME) },
});
