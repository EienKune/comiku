import type { Prisma } from "../generated/prisma/client.js";

/** Acquire before work locks when adding or restoring participation. Account administration
 * takes the exclusive barrier, so a qualification check cannot outlive a role change. */
export async function lockAccountMembership(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(20260905, 2)`;
}
