export type SourceSelection =
  | "all"
  | "platform:x"
  | "platform:pixiv"
  | "manual"
  | "unbound"
  | `account:${string}`;

export function parseSourceSelection(value: string | null): SourceSelection {
  if (
    value === "platform:x" ||
    value === "platform:pixiv" ||
    value === "manual" ||
    value === "unbound"
  )
    return value;
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
  sourcePlatform?: "x" | "pixiv" | "manual";
  sourceAccountId?: string;
  sourceUnbound?: true;
} {
  const value = parseSourceSelection(selection);
  if (value === "manual") return { sourcePlatform: "manual" };
  if (value === "unbound") return { sourceUnbound: true };
  if (value === "platform:x") return { sourcePlatform: "x" };
  if (value === "platform:pixiv") return { sourcePlatform: "pixiv" };
  if (value.startsWith("account:")) return { sourceAccountId: value.slice(8) };
  return {};
}
