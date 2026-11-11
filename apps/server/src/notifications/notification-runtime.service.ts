import {
  Inject,
  Injectable,
  Optional,
  type OnModuleInit,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import type { BackgroundJob, Prisma } from "../generated/prisma/client.js";
import { JobDeferred, JobsService, retryDelay } from "../jobs/jobs.service.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import { OneBotHttpAdapter } from "./onebot-http.adapter.js";
import { renderNotificationMessage } from "./notification-events.js";
import { NotificationWorkEventBridgeService } from "./notification-work-event-bridge.service.js";
import { NotificationStatusService } from "./notification-status.service.js";
import type {
  NormalizedNotificationEvent,
  NotificationSendResult,
  NotificationFrozenContent,
} from "./notifications.contracts.js";
import {
  assertNotificationAdministrator,
  NOTIFICATION_JOB_KIND,
  NOTIFICATION_SCOPE,
} from "./notification-engine.helpers.js";
import {
  birthdayDeliveryInvalidReason,
  lockBirthdaySettings,
  lockBirthdaySubscription,
} from "./notification-birthday-policy.js";

@Injectable()
export class NotificationRuntimeService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
    @Inject(OneBotHttpAdapter) private readonly adapter: OneBotHttpAdapter,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Optional()
    @Inject(NotificationWorkEventBridgeService)
    private readonly workEventBridge?: NotificationWorkEventBridgeService,
    @Optional()
    @Inject(NotificationStatusService)
    private readonly status?: NotificationStatusService,
  ) {}

  get enabled() {
    return this.registry.enabled;
  }
  onModuleInit() {
    if (this.enabled)
      this.jobs.register(NOTIFICATION_JOB_KIND, (job, signal) =>
        this.execute(job, signal),
      );
  }
  async runNext(signal?: AbortSignal) {
    if (!this.enabled) return false;
    return this.jobs.runNext("network", signal, NOTIFICATION_SCOPE);
  }

  /** Bounded durable routing/reconciliation; no request, interval, lease or TTL of its own. */
  async maintain() {
    if (!this.enabled) return;
    const evidence = await this.workEventBridge?.maintain();
    if (evidence && this.status) {
      try {
        await this.status.recordMaintenance(evidence);
      } catch {
        // Observation is independent of durable routing, including injected or
        // future observer failures outside the status service's own guard.
      }
    }
    const events = await this.db.notificationEvent.findMany({
      where: { routedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    for (const candidate of events)
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM notification_events WHERE id = ${candidate.id}::uuid FOR UPDATE`;
        const event = await tx.notificationEvent.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        if (event.routedAt) return;
        const refs = event.routeRefs as unknown as {
          id: string;
          revision: number;
          generation: number;
          groupId?: string;
          connectionKey?: string;
          connectionFingerprint?: string;
          includeDetails?: boolean;
          content?: NotificationFrozenContent;
          birthdayGlobalGeneration?: number;
          birthdayOffsetGeneration?: number;
          birthdayScopeGeneration?: number;
        }[];
        const birthdaySettings =
          event.resourceKind === "birthday_digest" &&
          this.environment.birthdays?.enabled
            ? await lockBirthdaySettings(tx)
            : null;
        for (const ref of refs) {
          if (event.resourceKind === "birthday_digest")
            await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${ref.id}::uuid FOR SHARE`;
          const channel = await tx.notificationChannel.findUnique({
            where: { id: ref.id },
          });
          if (!channel) throw new Error("notification_channel_missing");
          const birthdayInvalid =
            event.resourceKind === "birthday_digest"
              ? ((!this.environment.birthdays?.enabled
                  ? "birthday_feature_disabled"
                  : birthdayDeliveryInvalidReason(
                      event.snapshot,
                      ref,
                      birthdaySettings,
                      await lockBirthdaySubscription(tx, channel.id),
                    )) ??
                (typeof ref.content?.text === "string" &&
                ref.content.text.trim() &&
                [...ref.content.text].length <= 1000
                  ? null
                  : "birthday_frozen_content_invalid"))
              : null;
          const current =
            !!ref.groupId &&
            !!ref.connectionKey &&
            !!ref.connectionFingerprint &&
            channel.enabled &&
            channel.audienceGeneration === ref.generation &&
            channel.groupId === ref.groupId &&
            channel.connectionKey === ref.connectionKey &&
            channel.connectionFingerprint === ref.connectionFingerprint &&
            !birthdayInvalid;
          await tx.notificationDelivery.createMany({
            data: {
              eventId: event.id,
              channelId: channel.id,
              audienceGeneration: ref.generation,
              connectionKey: ref.connectionKey ?? channel.connectionKey,
              connectionFingerprint:
                ref.connectionFingerprint ?? channel.connectionFingerprint,
              channelRevision: ref.revision,
              groupId: ref.groupId ?? channel.groupId,
              status: current ? "pending" : "cancelled",
              errorCode: current
                ? null
                : (birthdayInvalid ?? "channel_configuration_changed"),
              ...(event.resourceKind === "birthday_digest" && {
                birthdayGlobalGeneration: ref.birthdayGlobalGeneration,
                birthdayOffsetGeneration: ref.birthdayOffsetGeneration,
                birthdayScopeGeneration: ref.birthdayScopeGeneration,
              }),
              text:
                ref.content?.text ??
                (event.resourceKind === "birthday_digest"
                  ? ""
                  : renderNotificationMessage(
                      event as unknown as NormalizedNotificationEvent,
                      {
                        includeDetails: ref.includeDetails ?? false,
                        siteUrl: this.environment.appOrigin,
                      },
                    )),
            },
            skipDuplicates: true,
          });
        }
        await tx.notificationEvent.update({
          where: { id: event.id },
          data: { routedAt: new Date() },
        });
      });

    // Sending evidence must settle even after Jobs retires the third expired lease.
    const unsettled = await this.db.$queryRaw<{ id: string; jobId: string }[]>`
      SELECT d.id, d.job_id AS "jobId" FROM notification_deliveries d
      JOIN background_jobs j ON j.id = d.job_id
      WHERE d.status IN ('pending', 'retry_wait', 'sending')
      AND ((d.status = 'sending' AND (j.status <> 'running' OR j.lease_until <= NOW()))
        OR j.status IN ('failed', 'succeeded') OR (j.status = 'queued' AND j.attempts >= 3))
      ORDER BY d.updated_at, d.id LIMIT 50`;
    for (const row of unsettled) await this.reconcile(row.jobId, row.id);

    const pending = await this.db.notificationDelivery.findMany({
      where: {
        status: { in: ["pending", "retry_wait"] },
        jobId: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    for (const row of pending)
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id = ${row.id}::uuid FOR UPDATE`;
        const current = await tx.notificationDelivery.findUniqueOrThrow({
          where: { id: row.id },
        });
        if (
          current.jobId ||
          !["pending", "retry_wait"].includes(current.status)
        )
          return;
        const job = await this.jobs.enqueue(
          {
            kind: NOTIFICATION_JOB_KIND,
            resourceId: current.id,
            idempotencyKey: `notification:${current.id}`,
            lane: "network",
            executionScope: NOTIFICATION_SCOPE,
          },
          tx,
        );
        await tx.notificationDelivery.update({
          where: { id: current.id },
          data: { jobId: job.id },
        });
      });
  }

  private async reconcile(jobId: string, deliveryId: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const job = await tx.backgroundJob.findUnique({ where: { id: jobId } });
      const now = new Date();
      if (
        !job ||
        (job.status === "running" && job.leaseUntil && job.leaseUntil > now)
      )
        return;
      const delivery = await tx.notificationDelivery.findUnique({
        where: { id: deliveryId },
      });
      if (
        !delivery ||
        delivery.jobId !== jobId ||
        !["pending", "retry_wait", "sending"].includes(delivery.status)
      )
        return;
      if (delivery.status === "sending") {
        const changed = await tx.notificationDelivery.updateMany({
          where: {
            id: delivery.id,
            jobId,
            status: delivery.status,
            revision: delivery.revision,
          },
          data: {
            status: "unknown",
            errorCode: "send_interrupted",
            revision: { increment: 1 },
          },
        });
        if (!changed.count) return;
        await tx.notificationAttempt.updateMany({
          where: { deliveryId, status: "sending" },
          data: {
            status: "unknown",
            errorCode: "send_interrupted",
            completedAt: now,
          },
        });
      } else if (
        job.status === "failed" ||
        job.status === "succeeded" ||
        job.attempts >= 3
      ) {
        await tx.notificationDelivery.updateMany({
          where: {
            id: deliveryId,
            jobId,
            status: delivery.status,
            revision: delivery.revision,
          },
          data: {
            status: "failed",
            errorCode: "job_exhausted",
            revision: { increment: 1 },
          },
        });
      }
    });
  }

  private async lockJob(tx: Prisma.TransactionClient, job: BackgroundJob) {
    await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
    return !!(await tx.backgroundJob.count({
      where: {
        id: job.id,
        status: "running",
        leaseId: job.leaseId,
        leaseUntil: { gt: new Date() },
      },
    }));
  }

  private async execute(job: BackgroundJob, signal: AbortSignal) {
    if (!this.enabled)
      throw new JobDeferred(new Date(Date.now() + 60_000), "scope_paused");
    const preparation = await this.db.$transaction(async (tx) => {
      if (!(await this.lockJob(tx, job))) return null;
      const initial = await tx.notificationDelivery.findUnique({
        where: { id: job.resourceId },
      });
      if (!initial) return null;
      // Only birthday deliveries query birthday policy tables. Lock them before
      // the shared channel row so settings changes fence the send reservation.
      const birthdaySettings =
        initial.birthdayGlobalGeneration != null &&
        this.environment.birthdays?.enabled
          ? await lockBirthdaySettings(tx)
          : null;
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${initial.channelId}::uuid FOR UPDATE`;
      const birthdaySubscription =
        initial.birthdayGlobalGeneration != null &&
        this.environment.birthdays?.enabled
          ? await lockBirthdaySubscription(tx, initial.channelId)
          : null;
      await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id = ${initial.id}::uuid FOR UPDATE`;
      const row = await tx.notificationDelivery.findUniqueOrThrow({
        where: { id: initial.id },
        include: { event: true, channel: true },
      });
      if (!["pending", "retry_wait", "sending"].includes(row.status))
        return null;
      if (row.status === "sending") {
        await tx.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: "unknown",
            errorCode: "send_interrupted",
            revision: { increment: 1 },
          },
        });
        await tx.notificationAttempt.updateMany({
          where: { deliveryId: row.id, status: "sending" },
          data: {
            status: "unknown",
            errorCode: "send_interrupted",
            completedAt: new Date(),
          },
        });
        return null;
      }
      const channel = row.channel;
      const now = new Date();
      const cancel = async (code: string) => {
        await tx.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: "cancelled",
            errorCode: code,
            revision: { increment: 1 },
          },
        });
        return null;
      };
      if (
        !channel.enabled ||
        channel.audienceGeneration !== row.audienceGeneration ||
        channel.groupId !== row.groupId ||
        channel.connectionKey !== row.connectionKey
      )
        return cancel("channel_configuration_changed");
      if (row.event.resourceKind === "birthday_digest") {
        if (!this.environment.birthdays?.enabled)
          return cancel("birthday_feature_disabled");
        const invalid = birthdayDeliveryInvalidReason(
          row.event.snapshot,
          row,
          birthdaySettings,
          birthdaySubscription,
          now,
        );
        if (invalid) return cancel(invalid);
      }
      const connection = this.registry.get(row.connectionKey);
      if (!connection)
        return {
          deferred: new JobDeferred(
            new Date(now.getTime() + 60_000),
            "credential_unavailable",
          ),
        };
      if (
        connection.fingerprint !== row.connectionFingerprint ||
        connection.fingerprint !== channel.connectionFingerprint
      )
        return cancel("connection_configuration_changed");
      if (row.requestedBy) {
        try {
          await assertNotificationAdministrator(tx, row.requestedBy);
        } catch (error) {
          if (error instanceof Error && error.name === "ForbiddenException")
            return cancel("requester_permission_changed");
          throw error;
        }
      }
      // A failed/unknown resource blocks only this channel/resource; unrelated works continue.
      const blocker = await tx.notificationDelivery.findFirst({
        where: {
          channelId: row.channelId,
          groupId: row.groupId,
          id: { not: row.id },
          event: {
            resourceKind: row.event.resourceKind ?? "work",
            resourceId: row.event.resourceId,
          },
          OR: [
            { status: "unknown", resolvedAt: null },
            {
              status: { in: ["pending", "retry_wait", "sending"] },
              event: {
                OR: [
                  { aggregateVersion: { lt: row.event.aggregateVersion } },
                  {
                    aggregateVersion: row.event.aggregateVersion,
                    ordinal: { lt: row.event.ordinal },
                  },
                ],
              },
            },
          ],
        },
        select: { id: true },
      });
      const earlierUnrouted = await tx.notificationEvent.findFirst({
        where: {
          resourceKind: row.event.resourceKind ?? "work",
          resourceId: row.event.resourceId,
          routedAt: null,
          routeRefs: {
            array_contains: [
              {
                id: row.channelId,
                generation: row.audienceGeneration,
              },
            ],
          },
          OR: [
            { aggregateVersion: { lt: row.event.aggregateVersion } },
            {
              aggregateVersion: row.event.aggregateVersion,
              ordinal: { lt: row.event.ordinal },
            },
          ],
        },
        select: { id: true },
      });
      if (blocker || earlierUnrouted)
        return {
          deferred: new JobDeferred(
            new Date(now.getTime() + 30_000),
            "capacity",
          ),
        };
      if (row.nextAttemptAt && row.nextAttemptAt > now)
        return { deferred: new JobDeferred(row.nextAttemptAt, "capacity") };
      const inWindow =
        channel.rateWindowAt &&
        now.getTime() - channel.rateWindowAt.getTime() < 60_000;
      const limitedUntil =
        inWindow && channel.rateWindowCount >= 20
          ? new Date(channel.rateWindowAt!.getTime() + 60_000)
          : channel.nextSendAt;
      if (limitedUntil && limitedUntil > now)
        return { deferred: new JobDeferred(limitedUntil, "capacity") };
      if (row.attempts >= 3) {
        await tx.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: "failed",
            errorCode: "retry_exhausted",
            revision: { increment: 1 },
          },
        });
        return null;
      }
      signal.throwIfAborted();
      await tx.notificationChannel.update({
        where: { id: channel.id },
        data: {
          nextSendAt: new Date(now.getTime() + 1000),
          rateWindowAt: inWindow ? channel.rateWindowAt : now,
          rateWindowCount: inWindow ? { increment: 1 } : 1,
        },
      });
      const attempt = await tx.notificationAttempt.create({
        data: {
          deliveryId: row.id,
          number: row.attempts + 1,
          jobId: job.id,
          leaseId: job.leaseId!,
          sendBoundaryCrossed: true,
        },
      });
      await tx.notificationDelivery.update({
        where: { id: row.id },
        data: {
          status: "sending",
          attempts: { increment: 1 },
          revision: { increment: 1 },
          nextAttemptAt: null,
          errorCode: null,
        },
      });
      return { row, attempt, connection };
    });
    if (!preparation) return;
    if ("deferred" in preparation) throw preparation.deferred;
    // The persisted sending boundary is intentionally conservative: a crash from here is unknown.
    let result: NotificationSendResult;
    try {
      signal.throwIfAborted();
      result = await this.adapter.send(
        preparation.connection,
        preparation.row.groupId,
        preparation.row.text,
        signal,
      );
    } catch {
      result = {
        status: "unknown",
        errorCode: "send_interrupted",
        sendBoundaryCrossed: true,
      };
    }
    const retryAt = new Date(
      Date.now() + retryDelay(preparation.attempt.number),
    );
    const safeRetry =
      result.status === "retryable" && preparation.attempt.number < 3;
    const settled = await this.db.$transaction(async (tx) => {
      if (!(await this.lockJob(tx, job))) return false;
      const changed = await tx.notificationDelivery.updateMany({
        where: {
          id: preparation.row.id,
          status: "sending",
          attempts: preparation.attempt.number,
        },
        data: {
          status: safeRetry
            ? "retry_wait"
            : result.status === "retryable"
              ? "failed"
              : result.status,
          errorCode: result.errorCode ?? null,
          providerMessageId: result.providerMessageId ?? null,
          nextAttemptAt: safeRetry ? retryAt : null,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) return false;
      await tx.notificationAttempt.update({
        where: { id: preparation.attempt.id },
        data: {
          status: result.status,
          sendBoundaryCrossed: result.sendBoundaryCrossed,
          errorCode: result.errorCode ?? null,
          providerMessageId: result.providerMessageId ?? null,
          completedAt: new Date(),
        },
      });
      return true;
    });
    if (settled && safeRetry) throw new JobDeferred(retryAt, "capacity");
  }
}
