import "dotenv/config";
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation/build never connects; migrate and runtime still require a URL.
  datasource: { url: process.env.DATABASE_URL },
});
