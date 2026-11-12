import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { isIP } from "node:net";
import type {
  SafeNotificationConnection,
  ValidatedNotificationConnection,
} from "./notifications.contracts.js";

const invalid = () => new Error("notification_configuration_invalid");

export function normalizeNotificationIp(value: string): string {
  if (typeof value !== "string" || value.includes("%") || !isIP(value))
    throw invalid();
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16),
      low = parseInt(mapped[2]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return normalized;
}

export function isForbiddenNotificationIp(value: string): boolean {
  const ip = normalizeNotificationIp(value);
  if (ip === "100.100.100.200" || ip === "fd00:ec2::254") return true;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || (a === 169 && b === 254) || a! >= 224;
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (
    ip === "::" || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
  );
}

export function isPrivateNotificationIp(value: string): boolean {
  const ip = normalizeNotificationIp(value);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return ip === "::1" || (first & 0xfe00) === 0xfc00;
}

function readManifest(path: string): string {
  const fd = openSync(path, "r");
  try {
    const data = Buffer.alloc(65_537);
    let bytes = 0;
    while (bytes < data.length) {
      const count = readSync(fd, data, bytes, data.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 65_536) throw invalid();
    return data.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface NotificationConnectionRegistryOptions {
  env?: Record<string, string | undefined>;
  /** Same manifest shape as the private file, for embedded deployments and synthetic tests. */
  manifest?: unknown;
}

export class NotificationConnectionRegistry {
  readonly enabled: boolean;
  configurationError: string | null = null;
  private readonly connections = new Map<
    string,
    ValidatedNotificationConnection
  >();
  private readonly safe: SafeNotificationConnection[] = [];

  constructor(options: NotificationConnectionRegistryOptions = {}) {
    const env = options.env ?? process.env;
    this.enabled = env.NOTIFICATIONS_ENABLED === "true";
    let manifest: unknown;
    try {
      manifest =
        options.manifest ??
        (env.NOTIFICATION_CONNECTIONS_FILE
          ? JSON.parse(readManifest(env.NOTIFICATION_CONNECTIONS_FILE))
          : []);
      // Accept a versionable object wrapper as well as the minimal array form.
      const entries: unknown = Array.isArray(manifest)
        ? manifest
        : (manifest as { connections?: unknown } | null)?.connections;
      if (
        !Array.isArray(entries) ||
        entries.length > 8 ||
        Buffer.byteLength(JSON.stringify(manifest)) > 65_536
      )
        throw invalid();
      const seen = new Set<string>();
      for (const entry of entries) {
        const raw = entry as Record<string, unknown> | null;
        if (
          !raw ||
          typeof raw.key !== "string" ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.key) ||
          seen.has(raw.key) ||
          typeof raw.name !== "string" ||
          !raw.name.trim() ||
          raw.name.length > 100
        )
          throw invalid();
        seen.add(raw.key);
        const safe: SafeNotificationConnection = {
          key: raw.key,
          name: raw.name,
          adapter: "onebot-http",
          available: false,
        };
        this.safe.push(safe);
        try {
          const connection = this.validate(raw, env);
          this.connections.set(connection.key, Object.freeze(connection));
          safe.available = true;
        } catch {
          this.configurationError = "notification_configuration_invalid";
        }
      }
    } catch {
      this.connections.clear();
      this.safe.length = 0;
      this.configurationError = "notification_configuration_unavailable";
    }
  }

  safeConnections(): SafeNotificationConnection[] {
    return this.safe.map((entry) => ({ ...entry }));
  }
  get(key: string): ValidatedNotificationConnection | undefined {
    return this.connections.get(key);
  }

  private validate(
    raw: Record<string, unknown>,
    env: Record<string, string | undefined>,
  ): ValidatedNotificationConnection {
    if (
      (raw.adapter != null && raw.adapter !== "onebot-http") ||
      typeof raw.endpoint !== "string" ||
      raw.endpoint.length > 2048 ||
      typeof raw.tokenEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(raw.tokenEnv) ||
      !Array.isArray(raw.allowedIps) ||
      raw.allowedIps.length < 1 ||
      raw.allowedIps.length > 64
    )
      throw invalid();
    const endpoint = new URL(raw.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !["/", "/send_group_msg"].includes(endpoint.pathname)
    )
      throw invalid();
    const allowedIps = [
      ...new Set(raw.allowedIps.map((ip) => normalizeNotificationIp(ip))),
    ].sort();
    if (
      allowedIps.some(isForbiddenNotificationIp) ||
      (endpoint.protocol === "http:" &&
        allowedIps.some((ip) => !isPrivateNotificationIp(ip)))
    )
      throw invalid();
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    if (
      isIP(host) &&
      (!allowedIps.includes(normalizeNotificationIp(host)) ||
        isForbiddenNotificationIp(host))
    )
      throw invalid();
    const token = env[raw.tokenEnv];
    if (!token || token.length > 8192 || /[^\x21-\x7e]/.test(token))
      throw invalid();
    const canonical = endpoint.origin;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          adapter: "onebot-http",
          endpoint: canonical,
          token,
          allowedIps,
        }),
      )
      .digest("hex");
    return {
      key: raw.key as string,
      name: raw.name as string,
      adapter: "onebot-http",
      endpoint: canonical,
      token,
      allowedIps: Object.freeze(allowedIps),
      fingerprint,
    };
  }
}
