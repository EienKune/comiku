import { Injectable } from "@nestjs/common";
import type { ContentSourceClient } from "./content-source.js";

@Injectable()
export class ContentSourceRegistry {
  private readonly clients = new Map<string, ContentSourceClient>();

  register(client: ContentSourceClient): this {
    normalizePlatform(client.platform);
    const key = normalizeAdapterKey(client.adapterKey);
    if (this.clients.has(key))
      throw new Error(`Duplicate content source adapter: ${key}`);
    this.clients.set(key, client);
    return this;
  }

  get(adapterKey: string): ContentSourceClient | undefined {
    return this.clients.get(normalizeAdapterKey(adapterKey));
  }

  require(adapterKey: string): ContentSourceClient {
    const normalized = normalizeAdapterKey(adapterKey);
    const direct = this.clients.get(normalized);
    const platformClients = direct ? [] : this.forPlatform(normalized);
    const client =
      direct ?? (platformClients.length === 1 ? platformClients[0] : undefined);
    if (!client)
      throw new Error(`Unsupported content source adapter: ${normalized}`);
    return client;
  }

  forPlatform(platform: string): ContentSourceClient[] {
    const normalized = normalizePlatform(platform);
    return [...this.clients.values()]
      .filter((client) => client.platform === normalized)
      .sort((left, right) => left.priority - right.priority);
  }

  list() {
    return [...this.clients.values()].map((client) => ({
      platform: client.platform,
      adapterKey: client.adapterKey,
      priority: client.priority,
      metered: client.metered,
      available: client.available,
      supportedFirstSyncModes: [...client.supportedFirstSyncModes],
    }));
  }
}

export function normalizeAdapterKey(adapterKey: string): string {
  const normalized = adapterKey.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("Invalid source adapter key");
  }
  return normalized;
}

export function normalizePlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error("Invalid content source platform");
  }
  return normalized;
}
