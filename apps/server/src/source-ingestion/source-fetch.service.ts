import { JobsService } from "../jobs/jobs.service.js";
import { SourceResponseError } from "./source-response.js";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  CandidateTagDisposition,
  Prisma,
  SourceFetchTrigger,
  type SourceAdapterState,
} from "../generated/prisma/client.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import {
  CANDIDATE_MEDIA_CLASSIFIER,
  type CandidateMediaClassifier,
} from "./candidate-classifier.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
  SourceCursor,
} from "./content-source.js";
import { collectHashtags } from "./hashtags.js";
import { MEDIA_DOWNLOADER, type MediaDownloader } from "./media-downloader.js";
import { ContentSourceRegistry } from "./source-registry.js";
import type {
  RunSourceFetchDto,
  SourceFetchRunDto,
} from "./source-fetch.dto.js";

const runDetails = {
  items: {
    include: {
      externalAccount: {
        include: { author: { select: { displayName: true } } },
      },
      adapterState: true,
    },
    orderBy: { startedAt: "asc" },
  },
} as const;
type RunDetails = Prisma.SourceFetchRunGetPayload<{
  include: typeof runDetails;
}>;
type Account = Prisma.AuthorExternalAccountGetPayload<{
  include: { author: true; adapterStates: true };
}>;

@Injectable()
export class SourceFetchService {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ContentSourceRegistry)
    private readonly sources: ContentSourceRegistry,
    @Inject(MEDIA_DOWNLOADER) private readonly downloader: MediaDownloader,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(CANDIDATE_MEDIA_CLASSIFIER)
    private readonly classifier: CandidateMediaClassifier,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  onModuleInit() {
    this.jobs.register("source_fetch", async (job, signal) => {
      const payload = job.payload as { accountIds: string[] };
      const run = await this.db.sourceFetchRun.findUnique({
        where: { id: job.resourceId },
      });
      if (!run || run.completedAt) return;
      try {
        await this.run(
          run.trigger,
          run.requestedById,
          payload.accountIds,
          run.id,
          signal,
        );
      } catch (error) {
        if (error instanceof BadRequestException || job.attempts >= 3) {
          await this.db.sourceFetchRun.update({
            where: { id: run.id },
            data: { status: "failed", completedAt: new Date() },
          });
          return;
        }
        throw error;
      }
    });
  }

  async runManual(requestedById: string, input: RunSourceFetchDto) {
    const accounts = await this.accounts(input.accountIds);
    if (
      !accounts.length ||
      (input.accountIds && accounts.length !== new Set(input.accountIds).size)
    )
      throw new BadRequestException("没有可抓取的授权账号");
    const run = await this.db.$transaction((tx) =>
      this.enqueueRun(
        tx,
        "manual",
        requestedById,
        accounts.map((item) => item.id),
      ),
    );
    return this.get(run.id);
  }

  private async enqueueRun(
    tx: Prisma.TransactionClient,
    trigger: SourceFetchTrigger,
    actorId: string | null,
    accountIds: string[],
  ) {
    const run = await tx.sourceFetchRun.create({
      data: { trigger, requestedById: actorId, status: "queued" },
    });
    await this.jobs.enqueue(
      {
        kind: "source_fetch",
        resourceId: run.id,
        actorId,
        idempotencyKey: `source:${run.id}`,
        lane: "network",
        payload: { accountIds },
      },
      tx,
    );
    return run;
  }

  async scheduleDue(now = new Date()) {
    if (!this.environment.sourceScheduleEnabled) return false;
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:source-schedule'))`;
      const schedule = await tx.workerSchedule.upsert({
        where: { name: "sources" },
        create: { name: "sources", dueAt: now },
        update: {},
      });
      if (schedule.dueAt > now) return false;
      await tx.workerSchedule.update({
        where: { name: "sources" },
        data: {
          dueAt: new Date(
            now.getTime() + this.environment.sourceScheduleMinutes * 60_000,
          ),
        },
      });
      const active = await tx.backgroundJob.count({
        where: { kind: "source_fetch", status: { in: ["queued", "running"] } },
      });
      if (active) return false;
      const accounts = await tx.authorExternalAccount.findMany({
        where: {
          fetchEnabled: true,
          deletedAt: null,
          author: { authorizationStatus: "authorized", deletedAt: null },
        },
        select: { id: true },
      });
      if (!accounts.length) return false;
      await this.enqueueRun(
        tx,
        "scheduled",
        null,
        accounts.map((item) => item.id),
      );
      return true;
    });
  }

  async get(id: string): Promise<SourceFetchRunDto> {
    return this.dto(
      await this.db.sourceFetchRun.findUniqueOrThrow({
        where: { id },
        include: runDetails,
      }),
    );
  }

  private async assertActor(id: string | null) {
    if (!id) return;
    const allowed = await this.db.user.count({
      where: {
        id,
        isActive: true,
        mustChangePassword: false,
        roles: { some: { role: { in: ["admin", "source"] } } },
      },
    });
    if (!allowed) throw new BadRequestException("抓取发起人的当前权限已失效");
  }
  async list(): Promise<SourceFetchRunDto[]> {
    const runs = await this.db.sourceFetchRun.findMany({
      include: runDetails,
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    return runs.map((run) => this.dto(run));
  }

  private async run(
    trigger: SourceFetchTrigger,
    requestedById: string | null,
    accountIds: string[],
    runId: string,
    signal: AbortSignal,
  ): Promise<SourceFetchRunDto> {
    await this.assertActor(requestedById);
    signal.throwIfAborted();
    let accounts = await this.accounts(accountIds);

    await this.ensureAdapterStates(accounts);
    accounts = await this.accounts(accountIds);
    const run = await this.db.sourceFetchRun.update({
      where: { id: runId },
      data: { status: "running" },
    });
    await this.db.sourceFetchRunItem.updateMany({
      where: { runId, status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorCode: "interrupted",
        errorMessage: "进程中断，已从持久游标恢复",
      },
    });
    for (const account of accounts) {
      signal.throwIfAborted();
      await this.assertActor(requestedById);
      await this.fetchWithFallback(run.id, account, requestedById, signal);
    }
    const statuses = await this.db.sourceFetchRunItem.findMany({
      where: { runId: run.id },
      select: { status: true },
    });
    const failures = statuses.filter((item) => item.status === "failed").length;
    const successes = statuses.filter(
      (item) => item.status === "succeeded",
    ).length;
    const status =
      successes && !failures
        ? "succeeded"
        : successes
          ? "partial_failed"
          : "failed";
    return this.dto(
      await this.db.sourceFetchRun.update({
        where: { id: run.id },
        data: { status, completedAt: new Date() },
        include: runDetails,
      }),
    );
  }

  private accounts(accountIds?: string[]): Promise<Account[]> {
    return this.db.authorExternalAccount.findMany({
      where: {
        ...(accountIds?.length ? { id: { in: accountIds } } : {}),
        fetchEnabled: true,
        deletedAt: null,
        author: { deletedAt: null, authorizationStatus: "authorized" },
      },
      include: { author: true, adapterStates: true },
      orderBy: { id: "asc" },
    });
  }

  private async ensureAdapterStates(accounts: Account[]) {
    for (const account of accounts) {
      const known = new Set(
        account.adapterStates.map((state) => state.adapterKey),
      );
      const data = this.sources
        .forPlatform(account.platform)
        .filter((client) => !known.has(client.adapterKey))
        .map((client) => ({
          externalAccountId: account.id,
          adapterKey: client.adapterKey,
          health: client.available
            ? ("idle" as const)
            : ("unavailable" as const),
        }));
      if (data.length)
        await this.db.sourceAdapterState.createMany({
          data,
          skipDuplicates: true,
        });
    }
  }

  private async fetchWithFallback(
    runId: string,
    account: Account,
    createdById: string | null,
    signal: AbortSignal,
  ) {
    let allowMeteredFallback = true;
    for (const client of this.sources.forPlatform(account.platform)) {
      const state = account.adapterStates.find(
        (item) => item.adapterKey === client.adapterKey,
      );
      if (!state) continue;
      const now = new Date();
      if (client.metered && !allowMeteredFallback) {
        await this.createSkippedItem(
          runId,
          account,
          state,
          client,
          "fallback_not_ready",
        );
        continue;
      }
      if (
        !state.enabled ||
        !client.available ||
        Boolean(state.nextAttemptAt && state.nextAttemptAt > now) ||
        (client.metered &&
          (this.environment.xOfficialDailyBudget < 1 ||
            this.environment.xOfficialMonthlyBudget < 1))
      ) {
        await this.createSkippedItem(runId, account, state, client);
        continue;
      }
      if (state.health === "unavailable" || state.health === "disabled") {
        await this.db.sourceAdapterState.update({
          where: { id: state.id },
          data: { health: "idle" },
        });
      }
      const leased = await this.db.sourceAdapterState.updateMany({
        where: {
          id: state.id,
          OR: [
            { fetchLeaseUntil: null },
            { fetchLeaseUntil: { lt: now } },
            { fetchLeaseId: runId },
          ],
        },
        data: {
          fetchLeaseId: runId,
          fetchLeaseUntil: new Date(now.getTime() + 30 * 60 * 1000),
          lastAttemptAt: now,
        },
      });
      const item = await this.db.sourceFetchRunItem.create({
        data: {
          runId,
          externalAccountId: account.id,
          adapterStateId: state.id,
          adapterKey: client.adapterKey,
          cursorBefore: state.cursorJson as Prisma.InputJsonValue,
          status: leased.count ? "running" : "skipped",
          ...(!leased.count
            ? {
                errorCode: "already_running",
                errorMessage: "该适配器已有抓取任务",
              }
            : {}),
        },
      });
      if (!leased.count) {
        await this.db.sourceFetchRunItem.update({
          where: { id: item.id },
          data: { completedAt: new Date() },
        });
        continue;
      }
      try {
        await this.fetchAdapter(
          item.id,
          runId,
          account,
          state,
          client,
          createdById,
          signal,
        );
        return;
      } catch (error) {
        const safe = this.safeError(error);
        const failures = state.consecutiveFailures + 1;
        const cooling = failures >= this.environment.sourceFailureThreshold;
        await this.db.$transaction([
          this.db.sourceFetchRunItem.update({
            where: { id: item.id },
            data: {
              status: "failed",
              errorCode: safe.code,
              errorMessage: safe.message,
              completedAt: new Date(),
            },
          }),
          this.db.sourceAdapterState.update({
            where: { id: state.id },
            data: {
              health: cooling ? "cooling_down" : "degraded",
              consecutiveFailures: failures,
              nextAttemptAt: cooling
                ? new Date(
                    Date.now() +
                      this.environment.sourceCooldownMinutes * 60_000,
                  )
                : null,
              lastErrorCode: safe.code,
              lastErrorMessage: safe.message,
              fetchLeaseId: null,
              fetchLeaseUntil: null,
              revision: { increment: 1 },
            },
          }),
        ]);
        if (!client.metered) allowMeteredFallback = cooling;
      } finally {
        await this.db.sourceAdapterState.updateMany({
          where: { id: state.id, fetchLeaseId: runId },
          data: { fetchLeaseId: null, fetchLeaseUntil: null },
        });
      }
    }
  }

  private async createSkippedItem(
    runId: string,
    account: Account,
    state: SourceAdapterState,
    client: ContentSourceClient,
    forcedReason?: string,
  ) {
    const reason =
      forcedReason ??
      (!state.enabled
        ? "adapter_disabled"
        : !client.available
          ? "adapter_unavailable"
          : client.metered &&
              (this.environment.xOfficialDailyBudget < 1 ||
                this.environment.xOfficialMonthlyBudget < 1)
            ? "budget_disabled"
            : "adapter_cooling_down");
    const health = !state.enabled
      ? "disabled"
      : !client.available
        ? "unavailable"
        : state.health;
    if (health !== state.health) {
      await this.db.sourceAdapterState.update({
        where: { id: state.id },
        data: { health },
      });
    }
    return this.db.sourceFetchRunItem.create({
      data: {
        runId,
        externalAccountId: account.id,
        adapterStateId: state.id,
        adapterKey: client.adapterKey,
        cursorBefore: state.cursorJson as Prisma.InputJsonValue,
        status: "skipped",
        errorCode: reason,
        errorMessage:
          reason === "budget_disabled"
            ? "官方 API 回退预算尚未启用"
            : reason === "fallback_not_ready"
              ? "首选免费通道尚未达到回退阈值"
              : "适配器当前不可用",
        completedAt: new Date(),
      },
    });
  }

  private async fetchAdapter(
    itemId: string,
    leaseId: string,
    account: Account,
    state: SourceAdapterState,
    client: ContentSourceClient,
    createdById: string | null,
    signal: AbortSignal,
  ) {
    let cursor = state.cursorJson as SourceCursor;
    if (!Object.keys(cursor).length) {
      cursor = state.highWaterPublishedAt
        ? {
            startTime: new Date(
              state.highWaterPublishedAt.getTime() -
                this.environment.sourceOverlapMinutes * 60_000,
            ).toISOString(),
          }
        : client.initialCursor(account.firstSyncMode, new Date());
    }
    await this.db.sourceAdapterState.updateMany({
      where: { id: state.id, fetchLeaseId: leaseId },
      data: { cursorJson: cursor as Prisma.InputJsonValue },
    });
    const initialBoundary =
      typeof cursor.startTime === "string" ? new Date(cursor.startTime) : null;
    const counters = {
      pagesFetched: 0,
      itemsSeen: 0,
      candidatesCreated: 0,
      candidatesExisting: 0,
      mediaStored: 0,
      apiRequests: 0,
    };
    let highTime = state.highWaterPublishedAt ?? initialBoundary;
    let highId = state.highWaterExternalId;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      signal.throwIfAborted();
      await this.assertActor(createdById);
      if (client.metered) await this.consumeMeteredBudget(client.adapterKey);
      counters.apiRequests += 1;
      await this.db.sourceFetchRunItem.update({
        where: { id: itemId },
        data: { apiRequests: counters.apiRequests },
      });
      const page = await client.fetchPage(
        {
          externalUserId: account.externalUserId,
          handle: account.handle ?? undefined,
        },
        cursor,
      );
      signal.throwIfAborted();
      await this.assertActor(createdById);
      await this.assertEligible(account, state.id, leaseId);
      counters.pagesFetched += 1;
      counters.itemsSeen += page.items.length;
      for (const content of page.items) {
        const at = new Date(content.publishedAt);
        if (initialBoundary && at < initialBoundary) continue;
        if (
          !highTime ||
          at > highTime ||
          (at.getTime() === highTime.getTime() &&
            this.compareExternalIds(content.externalContentId, highId) > 0)
        ) {
          highTime = at;
          highId = content.externalContentId;
        }
        if (content.type === "repost" || !content.ownMedia.length) continue;
        const saved = await this.saveCandidate(
          account,
          state,
          client,
          content,
          createdById,
        );
        if (saved.created) {
          counters.candidatesCreated += 1;
          counters.mediaStored += saved.mediaStored;
        } else counters.candidatesExisting += 1;
      }
      if (!page.nextCursor)
        throw new Error("Source adapter did not return a durable cursor");
      cursor = page.nextCursor;
      await this.db.$transaction([
        this.db.sourceAdapterState.updateMany({
          where: { id: state.id, fetchLeaseId: leaseId },
          data: {
            cursorJson: cursor as Prisma.InputJsonValue,
            fetchLeaseUntil: new Date(Date.now() + 30 * 60 * 1000),
          },
        }),
        this.db.sourceFetchRunItem.update({
          where: { id: itemId },
          data: counters,
        }),
      ]);
      const boundary = state.highWaterPublishedAt
        ? state.highWaterPublishedAt.getTime() -
          this.environment.sourceOverlapMinutes * 60_000
        : (initialBoundary?.getTime() ?? null);
      const crossed =
        boundary !== null &&
        page.items.length > 0 &&
        page.items.every(
          (item) => new Date(item.publishedAt).getTime() < boundary,
        );
      if (page.complete || crossed) break;
      if (pageNumber === 99)
        throw new Error("Source pagination exceeded the safety limit");
    }
    await this.assertEligible(account, state.id, leaseId);
    const changed = await this.db.sourceAdapterState.updateMany({
      where: { id: state.id, fetchLeaseId: leaseId },
      data: {
        cursorJson: {},
        highWaterPublishedAt: highTime,
        highWaterExternalId: highId,
        health: "healthy",
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        revision: { increment: 1 },
      },
    });
    if (!changed.count)
      throw new Error("Adapter lease expired before committing watermarks");
    await this.db.sourceFetchRunItem.update({
      where: { id: itemId },
      data: {
        status: "succeeded",
        cursorAfter: {},
        ...counters,
        completedAt: new Date(),
      },
    });
  }

  async consumeMeteredBudget(adapterKey: string) {
    const now = new Date();
    const limits = [
      [
        `d:${now.toISOString().slice(0, 10)}`,
        this.environment.xOfficialDailyBudget,
      ],
      [
        `m:${now.toISOString().slice(0, 7)}`,
        this.environment.xOfficialMonthlyBudget,
      ],
    ] as const;
    if (limits.some(([, limit]) => limit < 1))
      throw new Error("X official API fallback budget is disabled");
    await this.db.$transaction(async (tx) => {
      for (const [periodKey, limit] of limits) {
        await tx.sourceAdapterBudgetUsage.upsert({
          where: { adapterKey_periodKey: { adapterKey, periodKey } },
          create: { adapterKey, periodKey },
          update: {},
        });
        const consumed = await tx.sourceAdapterBudgetUsage.updateMany({
          where: { adapterKey, periodKey, used: { lt: limit } },
          data: { used: { increment: 1 } },
        });
        if (!consumed.count)
          throw new Error(
            `X official API ${periodKey[0] === "d" ? "daily" : "monthly"} budget exhausted`,
          );
      }
    });
  }

  private async saveCandidate(
    account: Account,
    state: SourceAdapterState,
    client: ContentSourceClient,
    content: NormalizedSourceContent,
    createdById: string | null,
  ): Promise<{ created: boolean; mediaStored: number }> {
    const hashtags = collectHashtags(content.hashtags ?? [], content.text);
    const existing = await this.db.candidatePost.findUnique({
      where: {
        platform_externalPostId: {
          platform: account.platform,
          externalPostId: content.externalContentId,
        },
      },
    });
    if (existing) {
      await this.observe(
        existing.id,
        account.id,
        state.id,
        client.adapterKey,
        content.rawJson,
      );
      await this.db.candidateHashtag.createMany({
        data: hashtags.map((tag) => ({ candidatePostId: existing.id, ...tag })),
        skipDuplicates: true,
      });
      await this.refreshTagDisposition(existing.id);
      return { created: false, mediaStored: 0 };
    }
    const stored: Prisma.FileObjectGetPayload<object>[] = [];
    try {
      for (const media of content.ownMedia) {
        const downloaded = await this.downloader.download(
          media.url,
          client.allowedMediaHosts,
        );
        stored.push(
          await this.files.store({
            body: downloaded.body,
            contentType: downloaded.contentType,
            bucketScope: "source",
            kind: "candidate-media",
            sourceName: media.url,
            createdById: createdById ?? undefined,
          }),
        );
      }
      const tagDisposition = await this.tagDisposition(this.db, hashtags);
      const candidate = await this.db.$transaction(async (tx) => {
        const created = await tx.candidatePost.create({
          data: {
            authorId: account.authorId,
            authorExternalAccountId: account.id,
            platform: account.platform,
            externalPostId: content.externalContentId,
            externalPostUrl: content.permalink,
            text: content.text,
            referencedPostType:
              content.type === "reply"
                ? "reply"
                : content.type === "quote"
                  ? "quote"
                  : null,
            referencedPostId: content.referencedContentId,
            postedAt: new Date(content.publishedAt),
            rawJson: content.rawJson as Prisma.InputJsonValue,
            tagDisposition,
            hashtags: { create: hashtags },
            sourceObservations: {
              create: {
                externalAccountId: account.id,
                adapterStateId: state.id,
                adapterKey: client.adapterKey,
                rawJson: content.rawJson as Prisma.InputJsonValue,
              },
            },
          },
        });
        await tx.candidateMedia.createMany({
          data: content.ownMedia.map((media, index) => ({
            candidatePostId: created.id,
            externalMediaId: media.externalMediaId,
            orderIndex: index,
            fileObjectId: stored[index].id,
            sourceUrl: media.url,
            width: media.width,
            height: media.height,
            mediaType: media.type,
          })),
        });
        return created;
      });
      if (this.classifier.available) {
        const result = await this.classifier
          .classify({
            candidateId: candidate.id,
            media: stored.map((file) => ({
              fileObjectId: file.id,
              contentType: file.contentType,
            })),
          })
          .catch(() => null);
        if (result) {
          await this.db.candidateClassificationSuggestion.create({
            data: { candidatePostId: candidate.id, ...result },
          });
        }
      }
      return { created: true, mediaStored: stored.length };
    } catch (error) {
      for (const file of stored.reverse())
        await this.files.purgeUnreferenced(file.id).catch(() => undefined);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const duplicate = await this.db.candidatePost.findUniqueOrThrow({
          where: {
            platform_externalPostId: {
              platform: account.platform,
              externalPostId: content.externalContentId,
            },
          },
        });
        await this.observe(
          duplicate.id,
          account.id,
          state.id,
          client.adapterKey,
          content.rawJson,
        );
        await this.db.candidateHashtag.createMany({
          data: hashtags.map((tag) => ({
            candidatePostId: duplicate.id,
            ...tag,
          })),
          skipDuplicates: true,
        });
        await this.refreshTagDisposition(duplicate.id);
        return { created: false, mediaStored: 0 };
      }
      throw error;
    }
  }

  private observe(
    candidatePostId: string,
    externalAccountId: string,
    adapterStateId: string,
    adapterKey: string,
    rawJson: Record<string, unknown>,
  ) {
    return this.db.candidateSourceObservation.upsert({
      where: { candidatePostId_adapterKey: { candidatePostId, adapterKey } },
      create: {
        candidatePostId,
        externalAccountId,
        adapterStateId,
        adapterKey,
        rawJson: rawJson as Prisma.InputJsonValue,
      },
      update: {
        rawJson: rawJson as Prisma.InputJsonValue,
        lastObservedAt: new Date(),
        observationCount: { increment: 1 },
      },
    });
  }

  private async refreshTagDisposition(candidatePostId: string) {
    const hashtags = await this.db.candidateHashtag.findMany({
      where: { candidatePostId },
      select: { normalizedValue: true },
    });
    const tagDisposition = await this.tagDisposition(this.db, hashtags);
    await this.db.candidatePost.update({
      where: { id: candidatePostId },
      data: { tagDisposition },
    });
  }

  private async tagDisposition(
    db: Prisma.TransactionClient | PrismaService,
    hashtags: { normalizedValue: string }[],
  ): Promise<CandidateTagDisposition> {
    if (!hashtags.length) return CandidateTagDisposition.neutral;
    const matches = await db.candidateTagAlias.findMany({
      where: {
        normalizedValue: { in: hashtags.map((tag) => tag.normalizedValue) },
        group: { enabled: true, kind: { in: ["valid", "blocked"] } },
      },
      select: { group: { select: { kind: true } } },
    });
    if (matches.some(({ group }) => group.kind === "blocked"))
      return CandidateTagDisposition.blocked;
    if (matches.some(({ group }) => group.kind === "valid"))
      return CandidateTagDisposition.valid;
    return CandidateTagDisposition.neutral;
  }

  private compareExternalIds(left: string, right: string | null) {
    if (!right) return 1;
    if (/^\d+$/.test(left) && /^\d+$/.test(right))
      return BigInt(left) > BigInt(right)
        ? 1
        : BigInt(left) < BigInt(right)
          ? -1
          : 0;
    return left.localeCompare(right);
  }

  private async assertEligible(
    account: Account,
    adapterStateId: string,
    leaseId: string,
  ) {
    const eligible = await this.db.authorExternalAccount.count({
      where: {
        id: account.id,
        revision: account.revision,
        fetchEnabled: true,
        deletedAt: null,
        author: { deletedAt: null, authorizationStatus: "authorized" },
        adapterStates: {
          some: {
            id: adapterStateId,
            enabled: true,
            fetchLeaseId: leaseId,
            fetchLeaseUntil: { gt: new Date() },
          },
        },
      },
    });
    if (!eligible) {
      throw new Error("Source account changed while fetching");
    }
  }

  private safeError(error: unknown) {
    if (error instanceof SourceResponseError)
      return { code: error.code, message: error.message };
    const name = error instanceof Error ? error.name : "Error";
    const message = "抓取未完成，请检查适配器配置、预算及授权后重试";
    return {
      code: name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "Error",
      message: message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500),
    };
  }

  private dto(run: RunDetails): SourceFetchRunDto {
    return {
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      requestedById: run.requestedById,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      items: run.items.map((item) => ({
        id: item.id,
        externalAccountId: item.externalAccountId,
        authorName: item.externalAccount.author.displayName,
        platform: item.externalAccount.platform,
        adapterKey: item.adapterKey,
        adapterHealth: item.adapterState.health,
        status: item.status,
        pagesFetched: item.pagesFetched,
        itemsSeen: item.itemsSeen,
        candidatesCreated: item.candidatesCreated,
        candidatesExisting: item.candidatesExisting,
        mediaStored: item.mediaStored,
        apiRequests: item.apiRequests,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        startedAt: item.startedAt.toISOString(),
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    };
  }
}
