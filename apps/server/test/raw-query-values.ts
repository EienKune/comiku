/** Preserve bindings when instrumenting either Prisma $queryRaw calling convention. */
export function rawQueryValues(
  query: unknown,
  ...taggedValues: unknown[]
): unknown[] {
  if (Array.isArray(query)) return taggedValues;
  if (
    query &&
    typeof query === "object" &&
    "values" in query &&
    Array.isArray(query.values)
  )
    return query.values;
  throw new TypeError("Unsupported raw query instrumentation shape");
}
