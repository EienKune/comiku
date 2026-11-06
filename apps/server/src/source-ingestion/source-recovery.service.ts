import type { PrismaService } from "../database/prisma.service.js";
import { ConflictException } from "@nestjs/common";
import type {
  BackgroundJob,
  Prisma,
  SourceDiscoveryPost,
  SourceRecoveryCampaign,
} from "../generated/prisma/client.js";
import { type JobsService } from "../jobs/jobs.service.js";
import { SourcePlatformStates } from "./source-platform-state.js";
import { recoveryDue, recoveryKey } from "./source-discovery.service.js";

type Campaign = SourceRecoveryCampaign & { discoveryPost: SourceDiscoveryPost };
/** Campaigns are business retries; the existing JobsService owns all execution leases. */
export class SourceRecoveryService {
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
    private readonly platforms: SourcePlatformStates,
  ) {}
  register(
    execute: (
      job: BackgroundJob,
      campaign: Campaign,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    this.jobs.registerClaimGate("source_post_recover", async (job, tx, now) => {
      const campaign = await tx.sourceRecoveryCampaign.findUnique({
        where: { id: job.resourceId },
        include: { discoveryPost: true },
      });
      if (!campaign || campaign.jobId !== job.id)
        throw new Error("Invalid recovery campaign");
      return this.platforms.claim(job, tx, now, {
        platform: campaign.discoveryPost.platform,
        completedAt: campaign.completedAt,
        waiting: async () => {},
        running: async () => {
          await tx.sourceRecoveryCampaign.updateMany({
            where: { id: campaign.id, completedAt: null },
            data: { state: "running" },
          });
        },
      });
    });
    this.jobs.register("source_post_recover", async (job, signal) => {
      const campaign = await this.db.sourceRecoveryCampaign.findUnique({
        where: { id: job.resourceId },
        include: { discoveryPost: true },
      });
      if (!campaign || campaign.jobId !== job.id || campaign.completedAt)
        return;
      await execute(job, campaign, signal);
    });
  }
  async schedule(now = new Date()) {
    // One oldest due gap per account, at most 20 accounts each maintenance tick.
    const posts = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM (SELECT DISTINCT ON (account_id) id,account_id,next_retry_at
        FROM source_discovery_posts WHERE state IN ('metadata_pending','media_pending')
        AND next_retry_at<=${now}
        AND EXISTS (SELECT 1 FROM author_external_accounts a JOIN authors au ON au.id=a.author_id
          WHERE a.id=source_discovery_posts.account_id AND a.external_user_id=source_discovery_posts.source_user_id
          AND a.fetch_enabled AND a.deleted_at IS NULL AND au.deleted_at IS NULL AND au.authorization_status='authorized')
        AND EXISTS (SELECT 1 FROM source_adapter_states a WHERE a.external_account_id=source_discovery_posts.account_id
          AND a.adapter_key=source_discovery_posts.adapter_key AND a.enabled)
        AND (actor_id IS NULL OR EXISTS (SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id
          WHERE u.id=source_discovery_posts.actor_id AND u.is_active AND NOT u.must_change_password AND r.role IN ('admin','source')))
        AND NOT EXISTS
        (SELECT 1 FROM source_recovery_campaigns c WHERE c.discovery_post_id=source_discovery_posts.id AND c.completed_at IS NULL)
        ORDER BY account_id,next_retry_at,id) due ORDER BY next_retry_at,id LIMIT 20`;
    for (const { id } of posts)
      await this.db
        .$transaction(async (tx) => {
          const post = await tx.sourceDiscoveryPost.findUniqueOrThrow({
            where: { id },
          });
          try {
            await this.platforms.actor(tx, post.actorId);
          } catch (error) {
            // Actor revocation after the due query is an expected eligibility
            // change. Database/transaction errors still reach the safe event.
            if (error instanceof ConflictException) return;
            throw error;
          }
          await this.lockAccount(tx, post);
          await tx.$queryRaw`SELECT id FROM source_discovery_posts WHERE id=${id}::uuid FOR UPDATE`;
          const current = await tx.sourceDiscoveryPost.findUniqueOrThrow({
            where: { id },
          });
          if (
            !current.nextRetryAt ||
            current.nextRetryAt > now ||
            !["metadata_pending", "media_pending"].includes(current.state) ||
            current.attempts >= 8
          )
            return;
          if (!(await this.eligible(tx, current))) return;
          if (
            await tx.sourceRecoveryCampaign.count({
              where: { discoveryPostId: id, completedAt: null },
            })
          )
            return;
          const campaign = await tx.sourceRecoveryCampaign.create({
            data: { discoveryPostId: id, number: current.attempts + 1 },
          });
          const job = await this.jobs.enqueue(
            {
              kind: "source_post_recover",
              resourceId: campaign.id,
              actorId: current.actorId,
              idempotencyKey: recoveryKey(id, campaign.number),
              lane: "network",
              executionScope: `source:${current.platform}`,
              queueName: "recovery",
            },
            tx,
          );
          await tx.sourceRecoveryCampaign.update({
            where: { id: campaign.id },
            data: { jobId: job.id },
          });
        })
        .catch(() => {
          console.info(
            JSON.stringify({
              scope: "source_recovery",
              event: "schedule_failed",
              discoveryId: id,
              code: "schedule_transaction_failed",
            }),
          );
        });
  }
  async lockAccount(tx: Prisma.TransactionClient, post: SourceDiscoveryPost) {
    const account = await tx.authorExternalAccount.findUnique({
      where: { id: post.accountId },
      select: { authorId: true },
    });
    if (!account) return;
    await tx.$queryRaw`SELECT id FROM authors WHERE id=${account.authorId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM author_external_accounts WHERE id=${post.accountId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT account_id FROM source_account_scan_states WHERE account_id=${post.accountId}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM source_adapter_states WHERE external_account_id=${post.accountId}::uuid ORDER BY id FOR NO KEY UPDATE`;
  }
  eligible(tx: Prisma.TransactionClient, post: SourceDiscoveryPost) {
    return tx.authorExternalAccount.count({
      where: {
        id: post.accountId,
        externalUserId: post.sourceUserId,
        platform: post.platform,
        fetchEnabled: true,
        deletedAt: null,
        author: { deletedAt: null, authorizationStatus: "authorized" },
        adapterStates: { some: { adapterKey: post.adapterKey, enabled: true } },
      },
    });
  }
  /** Caller holds current job and source fences; failure is counted once per campaign. */
  async finish(
    tx: Prisma.TransactionClient,
    campaign: Campaign,
    success: boolean,
    code = "recovery_failed",
    now = new Date(),
  ) {
    const changed = await tx.sourceRecoveryCampaign.updateMany({
      where: { id: campaign.id, completedAt: null },
      data: {
        state: success ? "succeeded" : "failed",
        failureCode: success ? null : code,
        completedAt: now,
      },
    });
    if (!changed.count) return;
    if (!success) {
      const due = recoveryDue(campaign.number, now);
      await tx.sourceDiscoveryPost.updateMany({
        where: {
          id: campaign.discoveryPostId,
          state: { notIn: ["complete", "excluded", "needs_attention"] },
        },
        data: {
          attempts: campaign.number,
          nextRetryAt: due,
          state: due
            ? campaign.discoveryPost.expectedMediaCount === null
              ? "metadata_pending"
              : "media_pending"
            : "needs_attention",
          failureCode: code,
          revision: { increment: 1 },
        },
      });
    }
    console.info(
      JSON.stringify({
        scope: "source_recovery",
        event: success ? "recovered" : "campaign_failed",
        discoveryId: campaign.discoveryPostId,
        campaign: campaign.number,
        code: success ? undefined : code,
      }),
    );
  }
  async reconcile(now = new Date()) {
    const campaigns = await this.db.$queryRaw<{ id: string; jobId: string }[]>`
      SELECT c.id,c.job_id AS "jobId" FROM source_recovery_campaigns c JOIN background_jobs j ON j.id=c.job_id
      WHERE c.completed_at IS NULL AND (j.status='failed' OR (j.status='queued' AND j.attempts>=3) OR
      (j.status='running' AND j.attempts>=3 AND (j.lease_until IS NULL OR j.lease_until<=${now}))) ORDER BY c.id LIMIT 100`;
    for (const item of campaigns)
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM background_jobs WHERE id=${item.jobId}::uuid FOR UPDATE`;
        const job = await tx.backgroundJob.findUniqueOrThrow({
          where: { id: item.jobId },
        });
        if (
          job.status !== "failed" &&
          !(
            job.attempts >= 3 &&
            (job.status === "queued" ||
              (job.status === "running" &&
                (!job.leaseUntil || job.leaseUntil <= now)))
          )
        )
          return;
        const campaign = await tx.sourceRecoveryCampaign.findUniqueOrThrow({
          where: { id: item.id },
          include: { discoveryPost: true },
        });
        if (campaign.completedAt) return;
        if (job.actorId)
          await tx.$queryRaw`SELECT id FROM users WHERE id=${job.actorId}::uuid FOR SHARE`;
        await this.platforms.lock(tx, campaign.discoveryPost.platform);
        await this.lockAccount(tx, campaign.discoveryPost);
        await tx.backgroundJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            leaseId: null,
            leaseUntil: null,
            completedAt: job.completedAt ?? now,
          },
        });
        const released = await tx.sourceAccountScanState.updateMany({
          where: {
            accountId: campaign.discoveryPost.accountId,
            leaseOwnerJobId: job.id,
            epoch: campaign.scanEpoch ?? -1,
          },
          data: {
            leaseOwnerJobId: null,
            leaseUntil: null,
            epoch: { increment: 1 },
          },
        });
        if (released.count)
          await tx.sourceAdapterState.updateMany({
            where: {
              externalAccountId: campaign.discoveryPost.accountId,
              fetchLeaseId: campaign.id,
            },
            data: { fetchLeaseId: null, fetchLeaseUntil: null },
          });
        await this.finish(
          tx,
          campaign,
          false,
          "worker_attempts_exhausted",
          now,
        );
      });
  }
}
