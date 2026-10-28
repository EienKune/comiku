/** Shipped maintenance CLI. No AppModule, adapter loading, model or network calls. */
const [operation, key, generation, history] = process.argv.slice(2);
const valid =
  (operation === "status" && process.argv.length === 3) ||
  (operation === "activate" &&
    process.argv.length === 6 &&
    (key === "disabled" || /^[a-f0-9]{64}$/.test(key ?? "")) &&
    /^\d+$/.test(generation ?? "") &&
    ["run", "pause"].includes(history ?? ""));
if (!valid) {
  console.error(
    "Usage: node dist/ops/image-analysis.js status | activate <model-key|disabled> <expected-generation> <run|pause>",
  );
  process.exitCode = 1;
} else {
  let db: import("../database/prisma.service.js").PrismaService | undefined;
  try {
    const [
      { loadEnvironment },
      { PrismaService },
      { JobsService },
      { AnalysisScheduling },
    ] = await Promise.all([
      import("../config/environment.js"),
      import("../database/prisma.service.js"),
      import("../jobs/jobs.service.js"),
      import("../image-analysis/analysis-scheduling.js"),
    ]);
    db = new PrismaService(loadEnvironment());
    const scheduling = new AnalysisScheduling(db, new JobsService(db));
    const result =
      operation === "status"
        ? await scheduling.status()
        : await scheduling.activate(
            key === "disabled" ? null : key!,
            Number(generation),
            history === "pause",
          );
    console.info(JSON.stringify(result));
  } catch {
    console.error(
      "Analysis activation refused. Check expected generation, database and drained workers.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
export {};
