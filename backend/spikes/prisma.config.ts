import { defineConfig } from "prisma/config";
import { databaseUrl } from "../tools/database-url.ts";

export const SPIKE_DB = "agendly_spike";

export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: { url: databaseUrl(SPIKE_DB) },
});
