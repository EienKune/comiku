/** Administrator process access only: bounded read-only safe gap projection. */
if (process.argv.length !== 3 || process.argv[2] !== "needs-attention") {
  console.error("Usage: node dist/ops/source-discovery.js needs-attention");
  process.exitCode = 1;
} else {
  let db: import("../database/prisma.service.js").PrismaService | undefined;
  try {
    const [{ loadEnvironment }, { PrismaService }, { SourceDiscoveryService }] =
      await Promise.all([
        import("../config/environment.js"),
        import("../database/prisma.service.js"),
        import("../source-ingestion/source-discovery.service.js"),
      ]);
    db = new PrismaService(loadEnvironment());
    console.info(
      JSON.stringify(await new SourceDiscoveryService(db).attention()),
    );
  } catch {
    console.error(
      "Unable to inspect source discovery gaps. Check administrator database configuration.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
export {};
