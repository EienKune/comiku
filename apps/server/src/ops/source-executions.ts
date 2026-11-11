import { parseSourceExecutionOperation } from "./source-executions-arguments.js";

/**
 * Ops-only acknowledgement. Maintainers must first stop every API/worker and
 * verify all associated child/cgroup processes exited, outside this command.
 * This program checks database refusal conditions, never proves process exit.
 * It deliberately loads no AppModule, adapter or external network client.
 */
const operation = parseSourceExecutionOperation(process.argv.slice(2));
if (!operation) {
  console.error(
    "Usage: node dist/ops/source-executions.js confirm-owner-stopped <x|pixiv> <owner-uuid> <expected-generation> --confirm-source-processes-stopped",
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
    const result = await states.confirmStoppedOwner(
      operation.platform,
      operation.ownerId,
      operation.expectedGeneration,
      true,
    );
    console.info(JSON.stringify(result));
  } catch {
    console.error(
      "Owner settlement refused. Verify the fixed owner/generation, paused maintenance and drained source leases. Independently confirm every API/worker and child process stopped; this command cannot establish process exit.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
