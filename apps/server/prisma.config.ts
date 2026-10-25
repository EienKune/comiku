import { defineConfig } from "prisma/config";
import { loadRootEnvironment } from "./src/config/environment.js";

loadRootEnvironment();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // generate/validate are offline; commands that connect require DATABASE_URL.
  datasource: { url: process.env.DATABASE_URL },
});
