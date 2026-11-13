/** Physical worker stop attestation; never infers process death from a lease. */
import "reflect-metadata";
const [ownerId, administratorId, confirmation, ...extra] =
  process.argv.slice(2);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if (
  !ownerId ||
  !uuid.test(ownerId) ||
  !administratorId ||
  !uuid.test(administratorId) ||
  confirmation !== "owner_process_stopped" ||
  extra.length
) {
  console.error(
    "Usage: node dist/ops/archive-exports.js <owner-uuid> <administrator-uuid> owner_process_stopped; independently stop the physical worker first.",
  );
  process.exitCode = 1;
} else {
  let db: import("../database/prisma.service.js").PrismaService | undefined;
  try {
    const [
      { loadEnvironment },
      { PrismaService },
      { JobsService },
      { ArchiveRuntimeService },
    ] = await Promise.all([
      import("../config/environment.js"),
      import("../database/prisma.service.js"),
      import("../jobs/jobs.service.js"),
      import("../archive-exports/archive-runtime.service.js"),
    ]);
    const environment = loadEnvironment();
    db = new PrismaService(environment);
    await new ArchiveRuntimeService(
      db,
      new JobsService(db),
      environment,
      null,
    ).attestStoppedOwner(ownerId, administratorId, confirmation);
    console.info(
      "Stopped archive owner attestation recorded; complete receipts remain available for recovery.",
    );
  } catch {
    console.error(
      "Archive owner attestation refused. Verify physical process shutdown, expired leases, owner identity and administrator permission.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
export {};
