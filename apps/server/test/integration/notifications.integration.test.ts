import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationRuntimeService } from "../../src/notifications/notification-runtime.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import type { NotificationSendResult } from "../../src/notifications/notifications.contracts.js";
import type { OneBotHttpAdapter } from "../../src/notifications/onebot-http.adapter.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test(
  "notification PostgreSQL ledger: transaction, routing, lease, recovery and administrator fences",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const prefix = `notification-fixture:${randomUUID()}:`;
    const admin = await db.user.create({
      data: {
        username: `nt_${randomUUID()}`,
        displayName: "Synthetic administrator",
        passwordHash: "synthetic-not-a-login",
        mustChangePassword: false,
        roles: { create: { role: "admin" } },
      },
    });
    const registry = new NotificationConnectionRegistry({
      env: {
        NOTIFICATIONS_ENABLED: "true",
        SYNTHETIC_BOT_TOKEN: "synthetic-canary",
      },
      manifest: [
        {
          key: "fixture",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_BOT_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const publisher = new NotificationPublisherService(db);
    const service = new NotificationsService(db, publisher, registry, env);
    const channel = await service.createChannel(admin.id, {
      name: "Synthetic group",
      connectionKey: "fixture",
      groupId: "123456789",
      enabled: true,
      eventTypes: ["imported", "archived"],
      includeDetails: false,
      receiverMode: "legacy",
    });
    const sent: { group: string; text: string }[] = [];
    const outcomes: NotificationSendResult[] = [];
    const adapter = {
      async send(
        _connection: unknown,
        group: string,
        text: string,
      ): Promise<NotificationSendResult> {
        // Acquiring every sending row with NOWAIT proves the network callback has no business row lock.
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE channel_id = ${channel.id}::uuid AND status = 'sending' FOR UPDATE NOWAIT`;
        });
        sent.push({ group, text });
        return (
          outcomes.shift() ?? {
            status: "accepted",
            providerMessageId: `synthetic-${sent.length}`,
            sendBoundaryCrossed: true,
          }
        );
      },
    };
    const worker = () => {
      const jobs = new JobsService(db);
      const runtime = new NotificationRuntimeService(
        db,
        jobs,
        registry,
        adapter as unknown as OneBotHttpAdapter,
        env,
      );
      runtime.onModuleInit();
      return { jobs, runtime };
    };
    const first = worker();
    const second = worker();
    const publish = (
      suffix: string,
      resourceId = randomUUID(),
      aggregateVersion = 1,
    ) =>
      publisher.record({
        eventKey: prefix + suffix,
        type: "imported",
        resourceId,
        aggregateVersion,
        occurredAt: "2026-11-06T00:00:00Z",
        workNumber: 1001,
        title: "SECRET_TITLE_CANARY",
      });
    const unthrottle = async () => {
      await db.notificationChannel.update({
        where: { id: channel.id },
        data: {
          nextSendAt: new Date(0),
          rateWindowAt: new Date(0),
          rateWindowCount: 0,
        },
      });
    };
    const deliveryFor = (eventId: string) =>
      db.notificationDelivery.findFirstOrThrow({
        where: { eventId, replayGeneration: 0 },
      });
    const ready = async (id: string) => {
      const row = await db.notificationDelivery.update({
        where: { id },
        data: { nextAttemptAt: new Date(0) },
      });
      if (row.jobId)
        await db.backgroundJob.update({
          where: { id: row.jobId },
          data: { availableAt: new Date(0) },
        });
      await unthrottle();
    };
    try {
      await t.test(
        "recordTx rollback, concurrent idempotency, hash conflicts and route deduplication",
        async () => {
          await assert.rejects(
            db.$transaction(async (tx) => {
              await publisher.recordTx(tx, {
                eventKey: prefix + "rollback",
                type: "imported",
                resourceId: randomUUID(),
                aggregateVersion: 1,
                occurredAt: new Date(),
              });
              throw new Error("rollback fixture");
            }),
          );
          assert.equal(
            await db.notificationEvent.count({
              where: { eventKey: prefix + "rollback" },
            }),
            0,
          );
          const resource = randomUUID();
          const [a, b] = await Promise.all([
            publish("concurrent", resource),
            publish("concurrent", resource),
          ]);
          assert.equal(a.id, b.id);
          await assert.rejects(publish("concurrent", resource, 2), /不一致/);
          await Promise.all([
            first.runtime.maintain(),
            second.runtime.maintain(),
          ]);
          assert.equal(
            await db.notificationDelivery.count({ where: { eventId: a.id } }),
            1,
          );
          await Promise.all([
            first.runtime.runNext(),
            second.runtime.runNext(),
          ]);
          assert.equal(sent.length, 1);
          assert.equal((await deliveryFor(a.id)).status, "accepted");
          assert.ok(!sent[0]!.text.includes("SECRET_TITLE_CANARY"));
        },
      );

      await t.test(
        "canonical no-op and name-only saves preserve pending, retry and unrouted intentions",
        async () => {
          const retryEvent = await publish("metadata-retry");
          await first.runtime.maintain();
          await unthrottle();
          outcomes.push({
            status: "retryable",
            errorCode: "connection_refused",
            sendBoundaryCrossed: false,
          });
          await first.runtime.runNext();
          const waiting = await deliveryFor(retryEvent.id);
          assert.equal(waiting.status, "retry_wait");
          const pendingEvent = await publish("metadata-pending");
          await first.runtime.maintain();
          const unroutedEvent = await publish("metadata-unrouted");
          const current = await db.notificationChannel.findUniqueOrThrow({
            where: { id: channel.id },
          });
          const noOp = await service.updateChannel(admin.id, channel.id, {
            ...current,
            name: ` ${current.name} `,
            eventTypes: [...current.eventTypes].reverse(),
            expectedRevision: current.revision,
          });
          assert.equal(noOp.revision, current.revision);
          assert.equal(noOp.audienceGeneration, current.audienceGeneration);
          const renamed = await service.updateChannel(admin.id, channel.id, {
            ...noOp,
            name: "Renamed synthetic group",
            expectedRevision: noOp.revision,
          });
          assert.equal(renamed.revision, current.revision + 1);
          assert.equal(renamed.audienceGeneration, current.audienceGeneration);
          assert.equal((await deliveryFor(retryEvent.id)).status, "retry_wait");
          assert.equal((await deliveryFor(pendingEvent.id)).status, "pending");
          assert.deepEqual(
            (
              await db.notificationEvent.findUniqueOrThrow({
                where: { id: unroutedEvent.id },
              })
            ).routeRefs,
            unroutedEvent.routeRefs,
          );
          await first.runtime.maintain();
          assert.equal((await deliveryFor(unroutedEvent.id)).status, "pending");
          await ready(waiting.id);
          for (let i = 0; i < 3; i++) {
            await unthrottle();
            await first.runtime.runNext();
          }
          for (const event of [retryEvent, pendingEvent, unroutedEvent]) {
            const sentRow = await deliveryFor(event.id);
            assert.equal(sentRow.status, "accepted");
            assert.equal(sentRow.channelRevision, current.revision);
          }
          const changedEvent = await publish("metadata-real-policy");
          await first.runtime.maintain();
          const policy = await service.updateChannel(admin.id, channel.id, {
            ...renamed,
            includeDetails: !renamed.includeDetails,
            expectedRevision: renamed.revision,
          });
          assert.equal(
            policy.audienceGeneration,
            renamed.audienceGeneration + 1,
          );
          assert.equal(
            (await deliveryFor(changedEvent.id)).status,
            "cancelled",
          );
          await service.updateChannel(admin.id, channel.id, {
            ...policy,
            includeDetails: renamed.includeDetails,
            expectedRevision: policy.revision,
          });
          const before = sent.length;
          await first.runtime.runNext();
          assert.equal(sent.length, before);
        },
      );

      await t.test(
        "reconciliation cannot replace a concurrent administrator cancellation",
        async () => {
          const event = await publish("reconcile-cancel");
          await first.runtime.maintain();
          const row = await deliveryFor(event.id);
          await db.backgroundJob.update({
            where: { id: row.jobId! },
            data: { status: "failed", attempts: 3 },
          });
          const read = barrier();
          const resume = barrier();
          let intercepted = false;
          const controlled = db.$extends({
            query: {
              notificationDelivery: {
                async findUnique({ args, query }) {
                  const snapshot = await query(args);
                  if (args.where.id === row.id && !intercepted) {
                    intercepted = true;
                    read.resolve();
                    await resume.promise;
                  }
                  return snapshot;
                },
              },
            },
          });
          const runtime = new NotificationRuntimeService(
            controlled as unknown as PrismaService,
            first.jobs,
            registry,
            adapter as unknown as OneBotHttpAdapter,
            env,
          );
          const maintenance = runtime.maintain();
          let disabled:
            Awaited<ReturnType<typeof service.updateChannel>> | undefined;
          try {
            await Promise.race([
              read.promise,
              delay(2_000).then(() => {
                throw new Error(
                  "reconciliation did not reach the controlled pending read",
                );
              }),
            ]);
            const current = await db.notificationChannel.findUniqueOrThrow({
              where: { id: channel.id },
            });
            disabled = await service.updateChannel(admin.id, channel.id, {
              ...current,
              enabled: false,
              expectedRevision: current.revision,
            });
            resume.resolve();
            await maintenance;
            const cancelled = await deliveryFor(event.id);
            assert.equal(cancelled.status, "cancelled");
            assert.equal(cancelled.errorCode, "channel_configuration_changed");
          } finally {
            resume.resolve();
            await maintenance;
            if (disabled)
              await service.updateChannel(admin.id, channel.id, {
                ...disabled,
                enabled: true,
                expectedRevision: disabled.revision,
              });
          }
        },
      );

      await t.test(
        "retained-history default and status pages use their time-keyset indexes",
        async () => {
          const event = await publish("history-index");
          await first.runtime.maintain();
          const original = await deliveryFor(event.id);
          await db.notificationDelivery.update({
            where: { id: original.id },
            data: { status: "cancelled" },
          });
          const before = sent.length;
          await first.runtime.runNext();
          assert.equal(sent.length, before);
          await db.notificationDelivery.createMany({
            data: Array.from({ length: 2_000 }, (_, i) => ({
              eventId: event.id,
              channelId: original.channelId,
              audienceGeneration: original.audienceGeneration,
              replayGeneration: i + 1,
              connectionKey: original.connectionKey,
              connectionFingerprint: original.connectionFingerprint,
              groupId: original.groupId,
              channelRevision: original.channelRevision,
              text: "Synthetic retained history",
              status:
                i % 40 === 0 ? "cancelled" : i % 2 ? "accepted" : "failed",
              createdAt: new Date(Date.UTC(2021, 0, 1) + i * 1_000),
            })),
          });
          await db.$executeRaw`ANALYZE notification_deliveries`;
          type Plan = {
            "Node Type": string;
            "Index Name"?: string;
            "Actual Rows": number;
            "Actual Loops": number;
            "Rows Removed by Filter"?: number;
            "Rows Removed by Index Recheck"?: number;
            Plans?: Plan[];
          };
          type Explain = { "QUERY PLAN": { Plan: Plan }[] }[];
          const unfiltered =
            await db.$queryRaw<Explain>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM notification_deliveries ORDER BY created_at DESC, id DESC LIMIT 50`;
          const filtered =
            await db.$queryRaw<Explain>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM notification_deliveries WHERE status = 'accepted' ORDER BY created_at DESC, id DESC LIMIT 50`;
          const sparse =
            await db.$queryRaw<Explain>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM notification_deliveries WHERE status = 'cancelled' ORDER BY created_at DESC, id DESC LIMIT 50`;
          const timeIndex = "notification_deliveries_created_at_id_idx";
          const statusIndex =
            "notification_deliveries_status_created_at_id_idx";
          const nodes = (plan: Plan): Plan[] => [
            plan,
            ...(plan.Plans ?? []).flatMap(nodes),
          ];
          const assertBoundedPage = (
            label: string,
            explain: Explain,
            allowedIndexes: string[],
            maxScanned: number,
            boundedSort = false,
          ) => {
            const evidence = JSON.stringify({ label, explain });
            const root = explain[0]?.["QUERY PLAN"][0]?.Plan;
            assert.ok(root, evidence);
            const all = nodes(root);
            assert.equal(root["Node Type"], "Limit", evidence);
            assert.equal(root["Actual Rows"], 50, evidence);
            assert.ok(
              all.every((plan) => !/Seq Scan/.test(plan["Node Type"])),
              evidence,
            );
            const sorts = all.filter((plan) => /Sort/.test(plan["Node Type"]));
            assert.ok(
              sorts.length === 0 ||
                (boundedSort &&
                  all.every(
                    (plan) =>
                      plan["Actual Rows"] * plan["Actual Loops"] <= maxScanned,
                  )),
              evidence,
            );
            const scans = all.filter((plan) => plan["Index Name"]);
            assert.equal(scans.length, 1, evidence);
            const scan = scans[0]!;
            assert.ok(allowedIndexes.includes(scan["Index Name"]!), evidence);
            const scanned =
              (scan["Actual Rows"] +
                (scan["Rows Removed by Filter"] ?? 0) +
                (scan["Rows Removed by Index Recheck"] ?? 0)) *
              scan["Actual Loops"];
            assert.ok(scanned >= 50 && scanned <= maxScanned, evidence);
            t.diagnostic(
              JSON.stringify({
                label,
                index: scan["Index Name"],
                node: scan["Node Type"],
                rows: scan["Actual Rows"],
                filtered: scan["Rows Removed by Filter"] ?? 0,
                scanned,
              }),
            );
          };
          assertBoundedPage("unfiltered", unfiltered, [timeIndex], 75);
          // With roughly 50% accepted rows, filtering a backward time index is also bounded.
          assertBoundedPage(
            "common-status",
            filtered,
            [timeIndex, statusIndex],
            150,
          );
          // A sparse bitmap range may sort its few matches; never the entire history.
          assertBoundedPage("sparse-status", sparse, [statusIndex], 75, true);
        },
      );

      await t.test(
        "safe retry persists wake time and attempt history without exhausting a Jobs deferral",
        async () => {
          const event = await publish("retry");
          await first.runtime.maintain();
          await unthrottle();
          outcomes.push({
            status: "retryable",
            errorCode: "connection_refused",
            sendBoundaryCrossed: false,
          });
          await first.runtime.runNext();
          const waiting = await deliveryFor(event.id);
          assert.equal(waiting.status, "retry_wait");
          assert.ok(waiting.nextAttemptAt! > new Date());
          const job = await db.backgroundJob.findUniqueOrThrow({
            where: { id: waiting.jobId! },
          });
          assert.equal(job.status, "queued");
          assert.ok(job.availableAt > new Date());
          assert.equal(await first.runtime.runNext(), false);
          await ready(waiting.id);
          await second.runtime.runNext();
          const accepted = await deliveryFor(event.id);
          assert.equal(accepted.status, "accepted");
          assert.equal(accepted.attempts, 2);
          assert.deepEqual(
            (
              await db.notificationAttempt.findMany({
                where: { deliveryId: waiting.id },
                orderBy: { number: "asc" },
              })
            ).map((a) => a.status),
            ["retryable", "accepted"],
          );
        },
      );

      await t.test(
        "safe retries stop after three external attempts and permanent failures never hot-loop",
        async () => {
          const event = await publish("retry-budget");
          await first.runtime.maintain();
          const original = await deliveryFor(event.id);
          for (let i = 0; i < 3; i++) {
            await ready(original.id);
            outcomes.push({
              status: "retryable",
              errorCode: "connection_refused",
              sendBoundaryCrossed: false,
            });
            await first.runtime.runNext();
          }
          const failed = await deliveryFor(event.id);
          assert.equal(failed.status, "failed");
          assert.equal(failed.attempts, 3);
          const permanentEvent = await publish("permanent-failure");
          await first.runtime.maintain();
          await unthrottle();
          outcomes.push({
            status: "failed",
            errorCode: "provider_rejected",
            sendBoundaryCrossed: true,
          });
          await first.runtime.runNext();
          assert.equal((await deliveryFor(permanentEvent.id)).status, "failed");
          const before = sent.length;
          await first.runtime.maintain();
          assert.equal(await first.runtime.runNext(), false);
          assert.equal(sent.length, before);
        },
      );

      await t.test(
        "unknown blocks the same resource only, explicit replay and acknowledgement are idempotent",
        async () => {
          const resource = randomUUID();
          const a = await publish("unknown", resource);
          const b = await publish("blocked", resource, 2);
          const c = await publish("other");
          await first.runtime.maintain();
          await unthrottle();
          outcomes.push({
            status: "unknown",
            errorCode: "response_timeout",
            sendBoundaryCrossed: true,
          });
          await first.runtime.runNext();
          assert.equal((await deliveryFor(a.id)).status, "unknown");
          const before = sent.length;
          await first.runtime.runNext();
          assert.equal(sent.length, before);
          await unthrottle();
          await first.runtime.runNext();
          assert.equal((await deliveryFor(c.id)).status, "accepted");
          assert.equal((await deliveryFor(b.id)).attempts, 0);
          const source = await deliveryFor(a.id);
          const key = randomUUID();
          await assert.rejects(
            service.resolveDelivery(admin.id, source.id, {
              expectedRevision: source.revision,
              action: "retry",
              idempotencyKey: key,
            }),
            /重复/,
          );
          const input = {
            expectedRevision: source.revision,
            action: "retry" as const,
            idempotencyKey: key,
            confirmPossibleDuplicate: true,
          };
          const [replay, duplicateReplay] = await Promise.all([
            service.resolveDelivery(admin.id, source.id, input),
            service.resolveDelivery(admin.id, source.id, input),
          ]);
          assert.equal(duplicateReplay.id, replay.id);
          assert.ok(replay.preview.includes("历史补发"));
          assert.equal((await deliveryFor(a.id)).status, "unknown");
          assert.ok((await deliveryFor(a.id)).resolvedAt);
          await db.notificationDelivery.update({
            where: { id: source.id },
            data: { createdAt: new Date("2020-01-01T00:00:00Z") },
          });
          await first.runtime.maintain();
          assert.equal((await deliveryFor(a.id)).status, "unknown");
          // Cancel only this scenario's waiting rows so subsequent subtests are independent.
          await db.notificationDelivery.updateMany({
            where: { id: { in: [(await deliveryFor(b.id)).id, replay.id] } },
            data: { status: "cancelled" },
          });
          const cancelled = await db.notificationDelivery.findUniqueOrThrow({
            where: { id: replay.id },
          });
          const ack = {
            expectedRevision: cancelled.revision,
            action: "acknowledge" as const,
            idempotencyKey: randomUUID(),
          };
          assert.equal(
            (await service.resolveDelivery(admin.id, cancelled.id, ack)).id,
            (await service.resolveDelivery(admin.id, cancelled.id, ack)).id,
          );
        },
      );

      await t.test(
        "third exhausted lease reconciles sending to unknown even without executing its handler",
        async () => {
          const event = await publish("exhausted");
          await first.runtime.maintain();
          const row = await deliveryFor(event.id);
          const lostLease = randomUUID();
          await db.notificationDelivery.update({
            where: { id: row.id },
            data: { status: "sending", attempts: 1 },
          });
          await db.notificationAttempt.create({
            data: {
              deliveryId: row.id,
              number: 1,
              jobId: row.jobId!,
              leaseId: lostLease,
              sendBoundaryCrossed: true,
            },
          });
          await db.backgroundJob.update({
            where: { id: row.jobId! },
            data: {
              status: "running",
              attempts: 3,
              leaseId: lostLease,
              leaseUntil: new Date(0),
            },
          });
          const other = await first.jobs.claim(
            "network",
            new Date(),
            "notifications",
          );
          if (other) await first.jobs.execute(other);
          assert.equal(
            (
              await db.backgroundJob.findUniqueOrThrow({
                where: { id: row.jobId! },
              })
            ).status,
            "failed",
          );
          const before = sent.length;
          await first.runtime.maintain();
          assert.equal((await deliveryFor(event.id)).status, "unknown");
          assert.equal(sent.length, before);
          assert.equal(
            (
              await db.notificationAttempt.findUniqueOrThrow({
                where: { deliveryId_number: { deliveryId: row.id, number: 1 } },
              })
            ).status,
            "unknown",
          );
          const beforeSend = await publish("exhausted-before-send");
          await first.runtime.maintain();
          const untouched = await deliveryFor(beforeSend.id);
          await db.backgroundJob.update({
            where: { id: untouched.jobId! },
            data: { status: "failed", attempts: 3 },
          });
          await first.runtime.maintain();
          assert.equal((await deliveryFor(beforeSend.id)).status, "failed");
          assert.equal((await deliveryFor(beforeSend.id)).attempts, 0);
        },
      );

      await t.test(
        "manual resolution waits for the channel before locking a delivery",
        async () => {
          const event = await publish("lock-order");
          await first.runtime.maintain();
          const row = await deliveryFor(event.id);
          await db.notificationDelivery.update({
            where: { id: row.id },
            data: { status: "failed" },
          });
          let pending: ReturnType<typeof service.resolveDelivery> | undefined;
          await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channel.id}::uuid FOR UPDATE`;
            pending = service.resolveDelivery(admin.id, row.id, {
              expectedRevision: row.revision,
              action: "acknowledge",
              idempotencyKey: randomUUID(),
            });
            let blocked = false;
            for (let i = 0; i < 100; i++) {
              const [activity] = await db.$queryRaw<
                { waiting: boolean }[]
              >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
            AND query LIKE '%notification_channels%') AS waiting`;
              if (activity?.waiting) {
                blocked = true;
                break;
              }
              await delay(10);
            }
            assert.ok(
              blocked,
              "resolve must demonstrably be waiting for the held channel lock",
            );
            // An old delivery-first implementation fails here with lock_not_available.
            await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id = ${row.id}::uuid FOR UPDATE NOWAIT`;
          });
          assert.ok((await pending!).resolvedAt);
        },
      );

      await t.test(
        "channel CAS, disable/re-enable and target changes never revive original routes",
        async () => {
          const event = await publish("config-snapshot");
          const current = await db.notificationChannel.findUniqueOrThrow({
            where: { id: channel.id },
          });
          const disabled = await service.updateChannel(admin.id, channel.id, {
            ...channel,
            expectedRevision: current.revision,
            enabled: false,
          });
          await assert.rejects(
            service.updateChannel(admin.id, channel.id, {
              ...channel,
              expectedRevision: current.revision,
            }),
            /已更新/,
          );
          await service.updateChannel(admin.id, channel.id, {
            ...disabled,
            expectedRevision: disabled.revision,
            enabled: true,
            groupId: "987654321",
            includeDetails: true,
          });
          await first.runtime.maintain();
          const cancelled = await deliveryFor(event.id);
          assert.equal(cancelled.status, "cancelled");
          assert.equal(cancelled.groupId, "123456789");
          assert.ok(!cancelled.text.includes("SECRET_TITLE_CANARY"));
          assert.equal(
            (
              await publisher.record({
                eventKey: event.eventKey,
                type: "imported",
                resourceId: event.resourceId,
                aggregateVersion: event.aggregateVersion,
                occurredAt: event.occurredAt,
                workNumber: 1001,
                title: "SECRET_TITLE_CANARY",
              })
            ).id,
            event.id,
          );
          assert.deepEqual(
            (
              await db.notificationEvent.findUniqueOrThrow({
                where: { id: event.id },
              })
            ).routeRefs,
            event.routeRefs,
          );
        },
      );

      await t.test(
        "manual tests recheck administrator permission before sending, writes reject revoked actors",
        async () => {
          const request = randomUUID();
          const queued = await service.testChannel(
            admin.id,
            channel.id,
            request,
          );
          assert.equal(
            (await service.testChannel(admin.id, channel.id, request)).id,
            queued.id,
          );
          await first.runtime.maintain();
          await db.userRole.deleteMany({ where: { userId: admin.id } });
          const before = sent.length;
          await unthrottle();
          for (let i = 0; i < 5; i++)
            if (!(await first.runtime.runNext())) break;
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: queued.id },
              })
            ).status,
            "cancelled",
          );
          assert.equal(sent.length, before);
          await assert.rejects(
            service.testChannel(admin.id, channel.id, randomUUID()),
            /权限/,
          );
        },
      );
    } finally {
      const events = await db.notificationEvent.findMany({
        where: {
          OR: [
            { eventKey: { startsWith: prefix } },
            { eventKey: { startsWith: `test:${admin.id}:` } },
          ],
        },
        select: { id: true },
      });
      const deliveries = await db.notificationDelivery.findMany({
        where: { eventId: { in: events.map((e) => e.id) } },
        select: { id: true, jobId: true },
      });
      await db.notificationAttempt.deleteMany({
        where: { deliveryId: { in: deliveries.map((d) => d.id) } },
      });
      await db.notificationDelivery.deleteMany({
        where: { id: { in: deliveries.map((d) => d.id) } },
      });
      await db.backgroundJob.deleteMany({
        where: {
          id: { in: deliveries.flatMap((d) => (d.jobId ? [d.jobId] : [])) },
        },
      });
      await db.notificationEvent.deleteMany({
        where: { id: { in: events.map((e) => e.id) } },
      });
      await db.notificationChannel.delete({ where: { id: channel.id } });
      await db.userRole.deleteMany({ where: { userId: admin.id } });
      await db.user.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  },
);
