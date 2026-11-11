/** No defaults: the operator must identify exactly one platform, owner and generation. */
export function parseSourceExecutionOperation(args: readonly string[]) {
  const [operation, platform, ownerId, expectedGeneration, confirmation] = args;
  if (
    args.length !== 5 ||
    operation !== "confirm-owner-stopped" ||
    !["x", "pixiv"].includes(platform ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      ownerId ?? "",
    ) ||
    !/^[0-9a-f]{64}$/.test(expectedGeneration ?? "") ||
    confirmation !== "--confirm-source-processes-stopped"
  )
    return null;
  return {
    platform: platform!,
    ownerId: ownerId!,
    expectedGeneration: expectedGeneration!,
  };
}
