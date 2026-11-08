/** Production maintenance entry: deliberately does not initialize AppModule or adapters. */
const [operation, platform, expectedGeneration] = process.argv.slice(2);
if (
  operation !== "activate" ||
  !["x", "pixiv"].includes(platform ?? "") ||
  !/^[a-f0-9]{64}$/.test(expectedGeneration ?? "") ||
  process.argv.length !== 5
) {
  console.error(
    "Usage: node dist/ops/source-credentials.js activate <x|pixiv> <expected-generation>",
  );
  process.exitCode = 1;
} else {
  let db: import("../database/prisma.service.js").PrismaService | undefined;
  try {
    const [
      { loadEnvironment },
      { PrismaService },
      { JobsService },
      { SourcePlatformStates },
    ] = await Promise.all([
      import("../config/environment.js"),
      import("../database/prisma.service.js"),
      import("../jobs/jobs.service.js"),
      import("../source-ingestion/source-platform-state.js"),
    ]);
    const environment = loadEnvironment();
    db = new PrismaService(environment);
    const states = new SourcePlatformStates(
      db,
      new JobsService(db),
      environment,
    );
    console.info(
      JSON.stringify(await states.activate(platform, expectedGeneration)),
    );
  } catch {
    console.error(
      "Credential activation refused. Check local configuration, expected generation and drained source/account leases.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
export {};
