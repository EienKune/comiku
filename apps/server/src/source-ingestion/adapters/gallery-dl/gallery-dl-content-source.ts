import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FirstSyncMode } from "../../../generated/prisma/client.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
  SourceAccountIdentity,
  SourceCursor,
  SourcePage,
} from "../../content-source.js";
import { jsonObject, SourceResponseError } from "../../source-response.js";

export interface GalleryDlConfig {
  python: string;
  configPath: string;
}
type PageRunner = (
  source: Record<string, unknown>,
  cursor: unknown,
) => Promise<Record<string, unknown>>;
const invalid = (): never => {
  throw new SourceResponseError("invalid_response");
};
function id(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return invalid();
}

/** gallery-dl owns platform protocols. Comiku owns coverage, identity and persistence. */
export class GalleryDlContentSource implements ContentSourceClient {
  readonly adapterKey: string;
  readonly priority = 5;
  readonly metered = false;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none", "last_24_hours"] as const;
  readonly allowedMediaHosts: readonly string[];
  private readonly runner: PageRunner;
  constructor(
    readonly platform: "x" | "pixiv",
    config: GalleryDlConfig,
    runner?: PageRunner,
  ) {
    this.adapterKey = `${platform}_gallery_dl`;
    this.allowedMediaHosts =
      platform === "x" ? ["pbs.twimg.com"] : ["i.pximg.net"];
    this.runner =
      runner ??
      (async (source, cursor) => {
        const directory = await mkdtemp(join(tmpdir(), "comiku-gallery-"));
        try {
          const request = join(directory, "request.json");
          await writeFile(
            request,
            JSON.stringify({
              config: config.configPath,
              cache: join(directory, "cache.sqlite3"),
              source,
              cursor,
            }),
            { mode: 0o600 },
          );
          const bridge = fileURLToPath(
            new URL("./python/adapter.py", import.meta.url),
          );
          return await new Promise<Record<string, unknown>>(
            (resolve, reject) => {
              execFile(
                config.python,
                [bridge, request],
                {
                  timeout: 120_000,
                  maxBuffer: 16 * 1024 * 1024,
                  windowsHide: true,
                  encoding: "utf8",
                },
                (error, stdout) => {
                  if (error) {
                    reject(new SourceResponseError("temporary_failure"));
                    return;
                  }
                  try {
                    const parsed = jsonObject(JSON.parse(stdout));
                    if (!parsed) invalid();
                    resolve(parsed!);
                  } catch {
                    reject(new SourceResponseError("invalid_response"));
                  }
                },
              );
            },
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
  }
  initialCursor(mode: FirstSyncMode, now: Date): SourceCursor {
    return {
      startTime: new Date(
        now.getTime() - (mode === "last_24_hours" ? 86_400_000 : 0),
      ).toISOString(),
    };
  }
  prepareCursor(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): SourceCursor {
    // X cursors are not snapshots. Restart/retry at the head without advancing the window.
    return { startTime: cursor.startTime, sourceId: account.externalUserId };
  }
  async checkAccount(account: SourceAccountIdentity) {
    if (!/^\d+$/.test(account.externalUserId)) invalid();
    await this.fetchPage(account, this.initialCursor("none", new Date()));
    return { externalUserId: account.externalUserId, handle: account.handle };
  }
  async fetchPage(
    account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): Promise<SourcePage> {
    if (
      !/^\d+$/.test(account.externalUserId) ||
      typeof cursor.startTime !== "string" ||
      !Number.isFinite(Date.parse(cursor.startTime)) ||
      (cursor.sourceId && cursor.sourceId !== account.externalUserId)
    )
      invalid();
    const page = await this.runner(
      {
        platform: this.platform,
        remote_id: account.externalUserId,
        handle: account.handle,
        cutoff: cursor.startTime,
      },
      cursor.providerCursor ?? null,
    );
    if (page.error) {
      throw new SourceResponseError(
        ["auth_failed", "source_forbidden", "challenge_required"].includes(
          String(page.error),
        )
          ? "authentication"
          : page.error === "rate_limited"
            ? "rate_limited"
            : page.error === "network_error"
              ? "temporary_failure"
              : "invalid_response",
      );
    }
    if (
      page.version !== 1 ||
      page.platform !== this.platform ||
      page.source_id !== account.externalUserId ||
      page.page_complete !== true ||
      !Array.isArray(page.failed_ids) ||
      page.failed_ids.length ||
      !Array.isArray(page.records) ||
      typeof page.terminal !== "boolean" ||
      typeof page.boundary !== "boolean" ||
      typeof page.neutral !== "boolean"
    )
      invalid();
    const records = page.records as unknown[];
    const coverage = jsonObject(page.coverage);
    let unsafe = cursor.orderUnsafe === true || page.order_anomaly === true;
    if (
      typeof page.first_date === "string" &&
      typeof cursor.lastDate === "string" &&
      Date.parse(page.first_date) > Date.parse(cursor.lastDate)
    )
      unsafe = true;
    const oldBatches = unsafe
      ? 0
      : page.boundary
        ? Number(cursor.oldBatches ?? 0) + 1
        : page.neutral
          ? Number(cursor.oldBatches ?? 0)
          : 0;
    if (page.empty_cursor_repeat) {
      const required = [
        "ordinary",
        "owned_context",
        "foreign",
        "ignored_pins",
        "recent",
        "unknown_date",
      ];
      if (
        !cursor.providerCursor ||
        Number(cursor.oldBatches ?? 0) < 1 ||
        unsafe ||
        !page.terminal ||
        page.next != null ||
        !page.neutral ||
        page.boundary ||
        records.length ||
        page.first_date ||
        page.last_date ||
        !coverage ||
        required.some((k) => coverage[k] !== 0) ||
        Object.values(coverage).some((v) => v !== 0)
      )
        invalid();
    }
    if (
      !page.terminal &&
      (page.next == null ||
        JSON.stringify(page.next) === JSON.stringify(cursor.providerCursor))
    )
      invalid();
    const grouped = new Map<string, NormalizedSourceContent>();
    const mediaCoverage = new Map<
      string,
      { count: number; positions: Set<number> }
    >();
    for (const record of records) {
      if (!Array.isArray(record) || ![2, 3].includes(record[0])) invalid();
      const fields = record as unknown[];
      const metadata = jsonObject(fields.at(-1));
      if (!metadata) invalid();
      const data = metadata!;
      const owner = jsonObject(data.author ?? data.user);
      if (!owner || id(owner.id) !== account.externalUserId) invalid();
      const postId = id(this.platform === "x" ? data.tweet_id : data.id);
      // In 1.32.11 quote_id marks expanded context; quoted_id is the
      // referenced target of an authored post and does not exclude its media.
      if (
        this.platform === "x" &&
        (id(data.retweet_id ?? "0") !== "0" || id(data.quote_id ?? "0") !== "0")
      )
        continue;
      if (this.platform === "pixiv" && data.type === "ugoira") continue;
      const count = Number(data.count);
      if (!Number.isSafeInteger(count) || count < 0 || count > 1000) invalid();
      if (
        this.platform === "pixiv" &&
        data.page_count !== undefined &&
        Number(data.page_count) !== count
      )
        invalid();
      let expected = mediaCoverage.get(postId);
      if (expected && expected.count !== count) invalid();
      if (!expected) {
        expected = { count, positions: new Set() };
        mediaCoverage.set(postId, expected);
      }
      if (fields[0] === 3) {
        const position = Number(data.num) - (this.platform === "x" ? 1 : 0);
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          position >= count ||
          expected.positions.has(position)
        )
          invalid();
        expected.positions.add(position);
      }
      const rawDate = String(data.date ?? "");
      const date = new Date(
        rawDate.includes("T") ? rawDate : rawDate.replace(" ", "T") + "Z",
      );
      if (!Number.isFinite(date.getTime())) invalid();
      let post = grouped.get(postId);
      if (!post) {
        const reply = id(data.reply_id ?? "0"),
          quote = id(data.quoted_id ?? "0");
        post = {
          externalContentId: postId,
          type: reply !== "0" ? "reply" : quote !== "0" ? "quote" : "post",
          text:
            typeof data.content === "string"
              ? data.content
              : typeof data.title === "string"
                ? data.title
                : undefined,
          permalink:
            this.platform === "x"
              ? `https://x.com/i/web/status/${postId}`
              : `https://www.pixiv.net/artworks/${postId}`,
          publishedAt: date.toISOString(),
          ownMedia: [],
          referencedContentId:
            reply !== "0" ? reply : quote !== "0" ? quote : undefined,
          hashtags: (Array.isArray(
            this.platform === "pixiv" ? data.tags : data.hashtags,
          )
            ? ((this.platform === "pixiv"
                ? data.tags
                : data.hashtags) as unknown[])
            : []
          )
            .map((tag) =>
              typeof tag === "string" ? tag : jsonObject(tag)?.name,
            )
            .filter((tag): tag is string => typeof tag === "string"),
          rawJson: { adapter: this.adapterKey, postId },
        };
        grouped.set(postId, post);
      }
      if (
        fields[0] !== 3 ||
        (this.platform === "x" && data.type !== "photo") ||
        !["jpg", "jpeg", "png", "webp", "gif"].includes(
          String(data.extension).toLowerCase(),
        )
      )
        continue;
      let url: URL;
      try {
        url = new URL(String(fields[1]));
      } catch {
        return invalid();
      }
      if (
        url.protocol !== "https:" ||
        !this.allowedMediaHosts.includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        invalid();
      const mediaId = `${postId}:${id(data.num ?? 1)}`;
      if (!post.ownMedia.some((m) => m.externalMediaId === mediaId))
        post.ownMedia.push({
          externalMediaId: mediaId,
          type: "photo",
          url: url.href,
          width: Number(data.width) || undefined,
          height: Number(data.height) || undefined,
        });
    }
    for (const { count, positions } of mediaCoverage.values())
      if (positions.size !== count) invalid();
    const boundaryReached =
      this.platform === "x" ? oldBatches >= 2 : page.boundary === true;
    return {
      items: [...grouped.values()],
      complete: page.terminal === true || boundaryReached,
      boundaryReached,
      nextCursor: {
        startTime: cursor.startTime,
        sourceId: account.externalUserId,
        providerCursor: page.next ?? null,
        oldBatches,
        orderUnsafe: unsafe,
        lastDate: page.last_date ?? cursor.lastDate ?? null,
      },
    };
  }
}
