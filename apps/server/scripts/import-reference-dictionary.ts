import "reflect-metadata";
import { readDictionaryImport } from "../src/reference-dictionary/import.js";
import { runDictionaryImportCli } from "../src/reference-dictionary/import-cli.js";
import { DictionaryImportError } from "../src/reference-dictionary/import-validation.js";

// Do not bootstrap AppModule: importing a dictionary must not start jobs or adapters.
process.exitCode = await runDictionaryImportCli(process.argv.slice(2), {
  read: readDictionaryImport,
  out: (value) => console.log(value),
  err: (value) => console.error(value),
  connect: async () => {
    const { loadRootEnvironment } =
      await import("../src/config/environment.js");
    loadRootEnvironment();
    // This CLI only needs a database URL, not unrelated application's production secrets.
    const { PrismaClient } = await import("../src/generated/prisma/client.js");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl)
      throw new DictionaryImportError("DATABASE_URL is required for --apply");
    return new PrismaClient({
      adapter: new PrismaPg({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
        query_timeout: 30000,
      }),
    });
  },
});
