import { requestSourceJson, SourceResponseError } from "./source-response.js";
import type { FirstSyncMode } from "../generated/prisma/client.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
  SourceAccountIdentity,
  SourceAccountProfile,
  SourceCursor,
  SourcePage,
} from "./content-source.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function walk(value: unknown, visit: (item: JsonObject) => void) {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const item = object(value);
  if (!item) return;
  visit(item);
  for (const child of Object.values(item)) walk(child, visit);
}

export class XWebSessionContentSourceClient implements ContentSourceClient {
  readonly platform = "x";
  readonly adapterKey = "x_web_session";
  readonly priority = 10;
  readonly metered = false;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none", "last_24_hours"] as const;
  readonly allowedMediaHosts = ["pbs.twimg.com"] as const;

  constructor(
    private readonly config: {
      bearerToken: string;
      authToken: string;
      csrfToken: string;
      userMediaQueryId: string;
      userByScreenNameQueryId?: string;
      features: Record<string, unknown>;
    },
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = "https://x.com/i/api/graphql",
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

  async checkAccount(
    account: SourceAccountIdentity,
  ): Promise<SourceAccountProfile> {
    return {
      externalUserId: account.externalUserId,
      handle: account.handle,
      profileUrl: account.handle
        ? `https://x.com/${account.handle}`
        : undefined,
    };
  }

  async resolveProfileByHandle(handle: string): Promise<SourceAccountProfile> {
    if (!this.config.userByScreenNameQueryId) {
      throw new SourceResponseError("configuration");
    }
    const variables = {
      screen_name: handle,
      withSafetyModeUserFields: true,
    };
    const url = new URL(
      `${this.baseUrl}/${encodeURIComponent(this.config.userByScreenNameQueryId)}/UserByScreenName`,
    );
    url.searchParams.set("variables", JSON.stringify(variables));
    url.searchParams.set("features", JSON.stringify(this.config.features));
    const raw = await requestSourceJson(() =>
      this.fetchImplementation(url, {
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          Cookie: `auth_token=${this.config.authToken}; ct0=${this.config.csrfToken}`,
          "X-Csrf-Token": this.config.csrfToken,
          "X-Twitter-Auth-Type": "OAuth2Session",
        },
        signal: AbortSignal.timeout(20_000),
      }),
    );
    let profile: SourceAccountProfile | undefined;
    walk(raw, (item) => {
      if (profile || typeof item.rest_id !== "string") return;
      const legacy = object(item.legacy);
      if (!legacy) return;
      const screenName = legacy?.screen_name;
      if (
        typeof screenName !== "string" ||
        screenName.toLowerCase() !== handle.toLowerCase()
      ) {
        return;
      }
      profile = {
        externalUserId: item.rest_id,
        handle: screenName,
        displayName: typeof legacy.name === "string" ? legacy.name : undefined,
        profileUrl: `https://x.com/${screenName}`,
        avatarUrl:
          typeof legacy.profile_image_url_https === "string"
            ? legacy.profile_image_url_https
            : undefined,
      };
    });
    if (!profile || !/^\d+$/.test(profile.externalUserId))
      throw new SourceResponseError("invalid_response");
    return profile;
  }

  async fetchPage(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): Promise<SourcePage> {
    const variables = {
      userId: account.externalUserId,
      count: 40,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      ...(typeof cursor.bottomCursor === "string"
        ? { cursor: cursor.bottomCursor }
        : {}),
    };
    const url = new URL(
      `${this.baseUrl}/${encodeURIComponent(this.config.userMediaQueryId)}/UserMedia`,
    );
    url.searchParams.set("variables", JSON.stringify(variables));
    url.searchParams.set("features", JSON.stringify(this.config.features));
    const raw = await requestSourceJson(() =>
      this.fetchImplementation(url, {
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          Cookie: `auth_token=${this.config.authToken}; ct0=${this.config.csrfToken}`,
          "X-Csrf-Token": this.config.csrfToken,
          "X-Twitter-Auth-Type": "OAuth2Session",
        },
        signal: AbortSignal.timeout(20_000),
      }),
    );
    const result = object(object(object(raw.data)?.user)?.result);
    const timeline =
      object(object(result?.timeline_v2)?.timeline) ??
      object(object(result?.timeline)?.timeline);
    if (!timeline || !Array.isArray(timeline.instructions))
      throw new SourceResponseError("invalid_response");
    const tweets = new Map<string, JsonObject>();
    let bottomCursor: string | undefined;
    walk(timeline.instructions, (item) => {
      const legacy = object(item.legacy);
      if (
        typeof item.rest_id === "string" &&
        legacy?.created_at &&
        String(legacy.user_id_str ?? "") === account.externalUserId
      ) {
        tweets.set(item.rest_id, item);
      }
      if (item.cursorType === "Bottom") {
        if (
          typeof item.value !== "string" ||
          !item.value ||
          item.value === cursor.bottomCursor
        )
          throw new SourceResponseError("invalid_response");
        bottomCursor = item.value;
      }
      if (
        item.__typename === "TweetUnavailable" ||
        item.__typename === "TweetTombstone"
      )
        throw new SourceResponseError("invalid_response");
    });
    const items: NormalizedSourceContent[] = [...tweets.entries()].map(
      ([id, tweet]) => {
        const legacy = object(tweet.legacy)!;
        if (
          !/^\d+$/.test(id) ||
          !Number.isFinite(Date.parse(String(legacy.created_at)))
        )
          throw new SourceResponseError("invalid_response");
        const extended = object(legacy.extended_entities);
        if (extended?.media !== undefined && !Array.isArray(extended.media))
          throw new SourceResponseError("invalid_response");
        const media = Array.isArray(extended?.media) ? extended.media : [];
        const entities = object(legacy.entities);
        const hashtags = Array.isArray(entities?.hashtags)
          ? entities.hashtags
              .map((entry) => object(entry)?.text)
              .filter((tag): tag is string => typeof tag === "string")
          : [];
        const replyId =
          typeof legacy.in_reply_to_status_id_str === "string"
            ? legacy.in_reply_to_status_id_str
            : undefined;
        const quoteId =
          typeof legacy.quoted_status_id_str === "string"
            ? legacy.quoted_status_id_str
            : undefined;
        const repost =
          object(tweet.retweeted_status_result) ??
          object(legacy.retweeted_status_result);
        return {
          externalContentId: id,
          type: repost
            ? "repost"
            : replyId
              ? "reply"
              : quoteId
                ? "quote"
                : "post",
          text:
            typeof legacy.full_text === "string" ? legacy.full_text : undefined,
          permalink: account.handle
            ? `https://x.com/${account.handle}/status/${id}`
            : `https://x.com/i/web/status/${id}`,
          publishedAt: new Date(String(legacy.created_at)).toISOString(),
          ownMedia: media
            .map(object)
            .filter((entry): entry is JsonObject => entry?.type === "photo")
            .map((entry) => {
              const mediaId = entry.media_key ?? entry.id_str;
              const url = entry.media_url_https ?? entry.media_url;
              if (
                typeof mediaId !== "string" ||
                typeof url !== "string" ||
                !url.startsWith("https://pbs.twimg.com/")
              )
                throw new SourceResponseError("invalid_response");
              return {
                externalMediaId: String(entry.media_key ?? entry.id_str),
                type: "photo" as const,
                url: String(entry.media_url_https ?? entry.media_url),
                width: Number(object(entry.original_info)?.width) || undefined,
                height:
                  Number(object(entry.original_info)?.height) || undefined,
              };
            }),
          referencedContentId: replyId ?? quoteId,
          hashtags,
          rawJson: tweet,
        };
      },
    );
    const terminated = timeline.instructions.some(
      (entry: unknown) => object(entry)?.type === "TimelineTerminateTimeline",
    );
    if (items.length && !bottomCursor && !terminated)
      throw new SourceResponseError("invalid_response");
    return {
      items,
      complete: !bottomCursor,
      nextCursor: bottomCursor
        ? {
            ...(typeof cursor.startTime === "string"
              ? { startTime: cursor.startTime }
              : {}),
            bottomCursor,
          }
        : typeof cursor.startTime === "string"
          ? { startTime: cursor.startTime }
          : {},
    };
  }
}
