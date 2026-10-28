export type SourceCursor = Record<string, unknown>;

export interface SourceAccountIdentity {
  externalUserId: string;
  handle?: string;
}

export interface SourceAccountProfile {
  externalUserId: string;
  handle?: string;
  profileUrl?: string;
  displayName?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedSourceMedia {
  externalMediaId: string;
  type: "photo";
  url: string;
  width?: number;
  height?: number;
}

export interface NormalizedSourceContent {
  externalContentId: string;
  type: "post" | "reply" | "quote" | "repost";
  text?: string;
  title?: string;
  description?: string;
  permalink: string;
  publishedAt: string;
  ownMedia: NormalizedSourceMedia[];
  referencedContentId?: string;
  hashtags?: string[];
  rawJson: Record<string, unknown>;
}

export interface SourcePage {
  items: NormalizedSourceContent[];
  nextCursor?: SourceCursor;
  complete: boolean;
  /** When supplied, adapter coverage replaces the generic per-page date heuristic. */
  boundaryReached?: boolean;
  /** Adapter-owned discovery baseline, committed only after complete coverage. */
  checkpoint?: Record<string, unknown>;
}

export interface SourceScanContext {
  /** Last successful adapter-owned baseline. Never contains credentials. */
  checkpoint?: Record<string, unknown>;
}

export interface ContentSourceClient {
  readonly platform: string;
  readonly adapterKey: string;
  readonly priority: number;
  readonly metered: boolean;
  readonly supportedFirstSyncModes: readonly FirstSyncMode[];
  readonly available: boolean;
  readonly allowedMediaHosts: readonly string[];
  initialCursor(mode: FirstSyncMode, now: Date): SourceCursor;
  prepareCursor?(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): SourceCursor;
  checkAccount(account: SourceAccountIdentity): Promise<SourceAccountProfile>;
  resolveProfileByHandle?(handle: string): Promise<SourceAccountProfile>;
  fetchPage(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
    context?: SourceScanContext,
  ): Promise<SourcePage>;
}

export class ContentSourceUnavailableError extends Error {
  constructor(platform: string) {
    super(`Content source '${platform}' is not configured`);
  }
}

export class UnavailableContentSourceClient implements ContentSourceClient {
  readonly available = false;
  readonly allowedMediaHosts: readonly string[] = [];
  constructor(
    readonly platform: string,
    readonly adapterKey: string,
    readonly priority: number,
    readonly supportedFirstSyncModes: readonly FirstSyncMode[],
    readonly metered = false,
  ) {}
  initialCursor(): SourceCursor {
    return {};
  }
  private unavailable(): never {
    throw new ContentSourceUnavailableError(this.platform);
  }
  checkAccount(): Promise<SourceAccountProfile> {
    return this.unavailable();
  }
  resolveProfileByHandle(): Promise<SourceAccountProfile> {
    return this.unavailable();
  }
  fetchPage(): Promise<SourcePage> {
    return this.unavailable();
  }
}
import type { FirstSyncMode } from "../generated/prisma/client.js";
