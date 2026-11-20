import type { Prisma } from "../generated/prisma/client.js";

export function publishedCreditNames(
  value: Prisma.JsonValue | undefined,
): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}
