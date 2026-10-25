import { isIP } from "node:net";

// Trust addresses, never hop counts: paths through a CDN and direct paths differ.
export function parseTrustedProxies(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < (family === 4 ? 8 : 32) ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        "TRUSTED_PROXY_CIDRS must contain explicit IP addresses or narrow CIDRs.",
      );
  }
  return [...new Set(entries)];
}
