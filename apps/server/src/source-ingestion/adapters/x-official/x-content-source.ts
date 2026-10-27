import {
  requestSourceJson,
  SourceResponseError,
} from "../../source-response.js";
import type { FirstSyncMode } from "../../../generated/prisma/client.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
  SourceAccountIdentity,
  SourceAccountProfile,
  SourceCursor,
  SourcePage,
} from "../../content-source.js";

interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  width?: number;
  height?: number;
}

interface XTweet extends Record<string, unknown> {
  id: string;
  text?: string;
  created_at?: string;
  attachments?: { media_keys?: string[] };
  referenced_tweets?: {
    type: "replied_to" | "quoted" | "retweeted";
    id: string;
  }[];
  entities?: { hashtags?: { tag?: string }[] };
}

interface XTimelineResponse {
  data?: XTweet[];
  includes?: { media?: XMedia[] };
  meta?: { next_token?: string; result_count?: number };
}

interface XUserResponse {
  data?: {
    id: string;
    username?: string;
    name?: string;
    profile_image_url?: string;
  };
}

function cursorString(cursor: SourceCursor, key: string): string | undefined {
  return typeof cursor[key] === "string" ? cursor[key] : undefined;
}

function greatestId(ids: string[]): string | undefined {
  return ids.reduce<string | undefined>((greatest, id) => {
    if (!/^\d+$/.test(id)) return greatest;
    return greatest === undefined || BigInt(id) > BigInt(greatest)
      ? id
      : greatest;
  }, undefined);
}

export class XContentSourceClient implements ContentSourceClient {
  readonly platform = "x";
  readonly adapterKey = "x_official_v2";
  readonly priority = 20;
  readonly metered = true;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none", "last_24_hours"] as const;
  readonly allowedMediaHosts = ["pbs.twimg.com"] as const;

  constructor(
    private readonly bearerToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = "https://api.x.com/2",
  ) {}

  initialCursor(mode: FirstSyncMode, now: Date): SourceCursor {
    return {
      startTime: new Date(
        mode === "last_24_hours"
          ? now.getTime() - 24 * 60 * 60 * 1000
          : now.getTime(),
      ).toISOString(),
    };
  }

  private async request<T>(path: string): Promise<T> {
    return (await requestSourceJson(() =>
      this.fetchImplementation(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
        signal: AbortSignal.timeout(20_000),
      }),
    )) as T;
  }

  async checkAccount(
    account: SourceAccountIdentity,
  ): Promise<SourceAccountProfile> {
    const result = await this.request<XUserResponse>(
      `/users/${encodeURIComponent(account.externalUserId)}?user.fields=profile_image_url`,
    );
    if (
      !result.data ||
      typeof result.data.id !== "string" ||
      !/^\d+$/.test(result.data.id) ||
      typeof result.data.username !== "string"
    )
      throw new SourceResponseError("invalid_response");
    return {
      externalUserId: result.data.id,
      handle: result.data.username,
      displayName: result.data.name,
      profileUrl: result.data.username
        ? `https://x.com/${result.data.username}`
        : undefined,
      avatarUrl: result.data.profile_image_url,
    };
  }

  async resolveProfileByHandle(handle: string): Promise<SourceAccountProfile> {
    const result = await this.request<XUserResponse>(
      `/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`,
    );
    if (
      !result.data ||
      typeof result.data.id !== "string" ||
      !/^\d+$/.test(result.data.id) ||
      typeof result.data.username !== "string"
    )
      throw new SourceResponseError("invalid_response");
    return {
      externalUserId: result.data.id,
      handle: result.data.username,
      displayName: result.data.name,
      profileUrl: result.data.username
        ? `https://x.com/${result.data.username}`
        : undefined,
      avatarUrl: result.data.profile_image_url,
    };
  }

  async fetchPage(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): Promise<SourcePage> {
    const query = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,referenced_tweets,attachments,entities",
      expansions: "attachments.media_keys",
      "media.fields": "media_key,type,url,width,height",
    });
    const sinceId = cursorString(cursor, "sinceId");
    const startTime = cursorString(cursor, "startTime");
    const paginationToken = cursorString(cursor, "paginationToken");
    if (sinceId) query.set("since_id", sinceId);
    else if (startTime) query.set("start_time", startTime);
    if (paginationToken) query.set("pagination_token", paginationToken);

    const result = await this.request<XTimelineResponse>(
      `/users/${encodeURIComponent(account.externalUserId)}/tweets?${query}`,
    );
    if (
      !result.meta ||
      typeof result.meta !== "object" ||
      (result.data !== undefined && !Array.isArray(result.data)) ||
      (result.data === undefined && result.meta.result_count !== 0) ||
      (result.meta.next_token !== undefined &&
        (typeof result.meta.next_token !== "string" ||
          !result.meta.next_token ||
          result.meta.next_token === paginationToken)) ||
      (result.includes?.media !== undefined &&
        !Array.isArray(result.includes.media))
    ) {
      throw new SourceResponseError("invalid_response");
    }
    const tweets = result.data ?? [];
    const media = new Map(
      (result.includes?.media ?? []).map((item) => [item.media_key, item]),
    );
    const previousHighest = cursorString(cursor, "highestSeenId") ?? sinceId;
    const highestSeenId = greatestId([
      ...(previousHighest ? [previousHighest] : []),
      ...tweets.map((tweet) => tweet.id),
    ]);
    const items: NormalizedSourceContent[] = tweets.map((tweet) => {
      if (
        !tweet ||
        typeof tweet.id !== "string" ||
        !/^\d+$/.test(tweet.id) ||
        !tweet.created_at ||
        !Number.isFinite(Date.parse(tweet.created_at)) ||
        (tweet.attachments?.media_keys !== undefined &&
          !Array.isArray(tweet.attachments.media_keys)) ||
        (tweet.referenced_tweets !== undefined &&
          !Array.isArray(tweet.referenced_tweets)) ||
        (tweet.entities?.hashtags !== undefined &&
          !Array.isArray(tweet.entities.hashtags))
      ) {
        throw new SourceResponseError("invalid_response");
      }
      for (const key of tweet.attachments?.media_keys ?? []) {
        const item = media.get(key);
        if (
          !item ||
          (item.type === "photo" &&
            (typeof item.url !== "string" ||
              !item.url.startsWith("https://pbs.twimg.com/")))
        )
          throw new SourceResponseError("invalid_response");
      }
      const reference = tweet.referenced_tweets?.find((item) =>
        ["retweeted", "replied_to", "quoted"].includes(item.type),
      );
      const type =
        reference?.type === "retweeted"
          ? "repost"
          : reference?.type === "replied_to"
            ? "reply"
            : reference?.type === "quoted"
              ? "quote"
              : "post";
      return {
        externalContentId: tweet.id,
        type,
        text: tweet.text,
        permalink: account.handle
          ? `https://x.com/${account.handle}/status/${tweet.id}`
          : `https://x.com/i/web/status/${tweet.id}`,
        publishedAt: tweet.created_at,
        ownMedia: (tweet.attachments?.media_keys ?? [])
          .map((key) => media.get(key))
          .filter(
            (item): item is XMedia =>
              item?.type === "photo" && Boolean(item.url),
          )
          .map((item) => ({
            externalMediaId: item.media_key,
            type: "photo" as const,
            url: item.url!,
            width: item.width,
            height: item.height,
          })),
        referencedContentId: reference?.id,
        hashtags: (tweet.entities?.hashtags ?? [])
          .map((item) => item.tag?.trim())
          .filter((tag): tag is string => Boolean(tag)),
        rawJson: tweet,
      };
    });
    const nextToken = result.meta?.next_token;
    return {
      items,
      complete: !nextToken,
      nextCursor: nextToken
        ? {
            ...(sinceId ? { sinceId } : { startTime }),
            paginationToken: nextToken,
            ...(highestSeenId ? { highestSeenId } : {}),
          }
        : highestSeenId
          ? { sinceId: highestSeenId }
          : sinceId
            ? { sinceId }
            : { startTime },
    };
  }
}
