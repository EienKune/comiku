export type SourceSelection = "all" | `account:${string}`;

export function parseSourceSelection(value: string | null): SourceSelection {
  if (
    value &&
    /^account:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return value.toLowerCase() as SourceSelection;
  return "all";
}

export function sourceQuery(selection: SourceSelection): {
  sourceAccountId?: string;
} {
  const value = parseSourceSelection(selection);
  if (value.startsWith("account:")) return { sourceAccountId: value.slice(8) };
  return {};
}
