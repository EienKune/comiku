export function localDayBoundary(
  value: string,
  nextDay = false,
): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const boundary = new Date(year, month - 1, day);
  if (nextDay) boundary.setDate(boundary.getDate() + 1);
  return boundary.toISOString();
}
