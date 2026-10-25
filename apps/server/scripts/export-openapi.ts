import { readFile, mkdir, writeFile } from "node:fs/promises";
import {
  createApplication,
  createOpenApiDocument,
} from "../src/application.js";

// Creating metadata does not call app.init/listen or Prisma's connection hook.
// Intentionally ignore real environment files and credentials for this command.
const app = await createApplication({
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgresql://offline:offline@127.0.0.1:1/offline",
  appOrigin: "http://localhost:5173",
  xOfficialDailyBudget: 0,
  xOfficialMonthlyBudget: 0,
  sourceOverlapMinutes: 10,
  sourceScheduleEnabled: false,
  sourceScheduleMinutes: 60,
  sourceFailureThreshold: 3,
  sourceCooldownMinutes: 360,
  typesetBatchMaxBytes: 512 * 1024 * 1024,
  typesetBatchMaxWorks: 20,
  objectStorageDriver: "memory",
});
try {
  const document = createOpenApiDocument(app);
  const operationIds = Object.values(document.paths).flatMap((path) =>
    Object.values(path ?? {}).flatMap((operation) =>
      typeof operation === "object" && operation && "operationId" in operation
        ? [operation.operationId]
        : [],
    ),
  );
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error("OpenAPI operationIds must be globally unique.");
  }
  const output = JSON.stringify(document, null, 2) + "\n";
  const directory = new URL("../../../docs/api/", import.meta.url);
  const target = new URL("openapi.json", directory);
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== output) {
      throw new Error(
        "OpenAPI is stale. Run pnpm openapi:export and review the diff.",
      );
    }
  } else {
    await mkdir(directory, { recursive: true });
    await writeFile(target, output);
  }
} finally {
  await app.close();
}
