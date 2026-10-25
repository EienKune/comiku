export function isDisplayableImageUrl(value?: string | null): value is string {
  return Boolean(
    value &&
    (value.startsWith("/api/") || /^(https?:|blob:|data:image)/.test(value)),
  );
}
