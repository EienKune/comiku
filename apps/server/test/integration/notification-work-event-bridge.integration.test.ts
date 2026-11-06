import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationWorkEventBridgeService } from "../../src/notifications/notification-work-event-bridge.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "durable work-event bridge: indexed discovery, capture and registration boundaries",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const registry = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true", SYNTHETIC_TOKEN: "synthetic" },
      manifest: [
        {
          key: "bridge",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const publisher = new NotificationPublisherService(db);
    const service = new NotificationsService(db, publisher, registry, env);
    const bridge = () =>
      new NotificationWorkEventBridgeService(db, publisher, registry);
    const actor = await db.user.create({
      data: {
        username: `bridge_${randomUUID()}`,
        displayName: "Synthetic",
        passwordHash: "synthetic",
        mustChangePassword: false,
        roles: { create: { role: "admin" } },
      },
    });
    const author = await db.author.create({
      data: { displayName: `bridge_${randomUUID()}` },
    });
    const account = await db.authorExternalAccount.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalUserId: randomUUID(),
      },
    });
    let channel = await service.createChannel(actor.id, {
      name: "Synthetic bridge",
      connectionKey: "bridge",
      groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
      enabled: true,
      eventTypes: ["imported", "stage_joined"],
      includeDetails: false,
      receiverMode: "legacy",
    });
    const workIds: string[] = [];
    const candidateIds: string[] = [];
    async function work() {
      const candidate = await db.candidatePost.create({
        data: {
          authorId: author.id,
          authorExternalAccountId: account.id,
          platform: "fixture",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          rawJson: {},
        },
      });
      candidateIds.push(candidate.id);
      const created = await db.work.create({
        data: {
          authorId: author.id,
          sourceCandidatePostId: candidate.id,
          importedById: actor.id,
          title: "CURRENT_PRIVATE_TITLE_CANARY",
        },
      });
      workIds.push(created.id);
      return created;
    }
    async function event(
      workId: string,
      patch: Partial<Prisma.WorkEventUncheckedCreateInput> = {},
      tx: Prisma.TransactionClient = db,
    ) {
      return tx.workEvent.create({
        data: { workId, action: "imported", detail: {}, ...patch },
      });
    }
    const receipt = (sourceEventId: string) =>
      db.notificationWorkEventReceipt.findUniqueOrThrow({
        where: { sourceEventId },
      });
    const due = () =>
      db.notificationWorkEventReceipt.updateMany({
        where: { resourceId: { in: workIds }, status: "retry_wait" },
        data: { nextAttemptAt: new Date(0) },
      });
    try {
      await bridge().maintain();
      const activation =
        await db.notificationWorkEventActivation.findUniqueOrThrow({
          where: { id: "work-events-v1" },
        });
      await t.test(
        "source field is absent from default Prisma DTO and history before activation is untouched",
        async () => {
          const w = await work();
          const old = await event(w.id, { createdAt: new Date(0) });
          assert.equal("notificationCapturedAt" in old, false);
          await bridge().maintain();
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { sourceEventId: old.id },
            }),
            0,
          );
          assert.ok(activation.sourceSince.getTime() > 0);
        },
      );
      await t.test(
        "late commit remains discoverable after a newer event and concurrent captures are unique",
        async () => {
          const w = await work();
          const inserted = barrier();
          const release = barrier();
          let lateId = "";
          const late = db.$transaction(
            async (tx) => {
              lateId = (await event(w.id, {}, tx)).id;
              inserted.resolve();
              await release.promise;
            },
            { timeout: 15_000 },
          );
          await inserted.promise;
          const newer = await event(w.id);
          await bridge().maintain();
          assert.equal((await receipt(newer.id)).status, "recorded");
          release.resolve();
          await late;
          await Promise.all([bridge().maintain(), bridge().maintain()]);
          await bridge().maintain();
          assert.equal((await receipt(lateId)).status, "recorded");
          assert.equal(
            await db.notificationEvent.count({ where: { resourceId: w.id } }),
            2,
          );
          assert.equal((await receipt(lateId)).resourceOrdinal, 2);
          await Promise.all([event(w.id), event(w.id)]);
          await Promise.all([bridge().maintain(), bridge().maintain()]);
          await bridge().maintain();
          const rows = await db.notificationWorkEventReceipt.findMany({
            where: { resourceId: w.id },
            orderBy: { resourceOrdinal: "asc" },
          });
          assert.deepEqual(
            rows.map((row) => row.resourceOrdinal),
            [1, 2, 3, 4],
          );
          assert.ok(rows.every((row) => row.status === "recorded"));
          assert.equal(
            await db.notificationEvent.count({ where: { resourceId: w.id } }),
            4,
          );
        },
      );
      await t.test(
        "capture failure rolls source marker and receipt back atomically",
        async () => {
          const w = await work();
          const source = await event(w.id);
          const failingDb = {
            notificationWorkEventActivation: db.notificationWorkEventActivation,
            $transaction: (
              fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
            ) =>
              db.$transaction(async (tx) => {
                const proxy = new Proxy(tx, {
                  get(target, prop) {
                    if (prop === "notificationWorkEventReceipt")
                      return {
                        ...target.notificationWorkEventReceipt,
                        create: async (
                          args: Parameters<
                            typeof target.notificationWorkEventReceipt.create
                          >[0],
                        ) => {
                          await target.notificationWorkEventReceipt.create(
                            args,
                          );
                          throw new Error("synthetic_capture_failure");
                        },
                      };
                    return Reflect.get(target, prop);
                  },
                });
                return fn(proxy);
              }),
          } as unknown as PrismaService;
          await new NotificationWorkEventBridgeService(
            failingDb,
            publisher,
            registry,
          ).maintain();
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { sourceEventId: source.id },
            }),
            0,
          );
          const marker = await db.$queryRaw<
            { captured: Date | null }[]
          >`SELECT notification_captured_at AS captured FROM work_events WHERE id = ${source.id}::uuid`;
          assert.equal(marker[0]!.captured, null);
          await bridge().maintain();
          assert.equal((await receipt(source.id)).status, "recorded");
        },
      );
      await t.test(
        "registration rollback retries durably and a different work is never starved",
        async () => {
          const first = await work();
          const second = await work();
          const a = await event(first.id);
          const b = await event(second.id);
          const original = publisher.recordFrozenRoutesTx.bind(publisher);
          publisher.recordFrozenRoutesTx = async (tx, input, routes) => {
            const saved = await original(tx, input, routes);
            if (input.resourceId === first.id)
              throw new Error("synthetic_registration_failure");
            return saved;
          };
          try {
            await bridge().maintain();
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          assert.equal((await receipt(a.id)).status, "retry_wait");
          assert.equal((await receipt(a.id)).attempts, 1);
          assert.equal(
            await db.notificationEvent.count({
              where: { resourceId: first.id },
            }),
            0,
          );
          assert.equal((await receipt(b.id)).status, "recorded");
          const follow = await event(first.id);
          await bridge().maintain();
          assert.equal((await receipt(follow.id)).status, "pending");
          await due();
          await bridge().maintain();
          await bridge().maintain();
          assert.equal((await receipt(a.id)).status, "recorded");
          assert.equal((await receipt(follow.id)).status, "recorded");
          assert.doesNotMatch(
            JSON.stringify((await receipt(a.id)).safeInput),
            /CURRENT_PRIVATE_TITLE_CANARY/,
          );
        },
      );
      await t.test(
        "failure-record persistence error does not starve a different resource in the same batch",
        async () => {
          const first = await work();
          const second = await work();
          const a = await event(first.id);
          const b = await event(second.id);
          const failingDb = new Proxy(db, {
            get(target, prop) {
              if (prop === "$transaction")
                return (
                  fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
                ) =>
                  target.$transaction(async (tx) =>
                    fn(
                      new Proxy(tx, {
                        get(transaction, key) {
                          if (key === "notificationWorkEventReceipt")
                            return {
                              ...transaction.notificationWorkEventReceipt,
                              update: async (
                                args: Parameters<
                                  typeof transaction.notificationWorkEventReceipt.update
                                >[0],
                              ) => {
                                if (args.data.status === "retry_wait")
                                  throw new Error(
                                    "synthetic_failure_record_unavailable",
                                  );
                                return transaction.notificationWorkEventReceipt.update(
                                  args,
                                );
                              },
                            };
                          return Reflect.get(transaction, key);
                        },
                      }),
                    ),
                  );
              return Reflect.get(target, prop);
            },
          });
          const original = publisher.recordFrozenRoutesTx.bind(publisher);
          publisher.recordFrozenRoutesTx = async (tx, input, routes) => {
            if (input.resourceId === first.id)
              throw new Error("synthetic_registration_unavailable");
            return original(tx, input, routes);
          };
          try {
            await new NotificationWorkEventBridgeService(
              failingDb,
              publisher,
              registry,
            ).maintain();
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          assert.equal((await receipt(a.id)).status, "pending");
          assert.equal((await receipt(b.id)).status, "recorded");
          await bridge().maintain();
          assert.equal((await receipt(a.id)).status, "recorded");
        },
      );
      await t.test(
        "invalid source and invalid persisted payload terminate without blocking later work",
        async () => {
          const w = await work();
          const poison = await event(w.id, {
            action: "stage_joined",
            detail: { stage: "private-poison" },
          });
          const good = await event(w.id);
          await bridge().maintain();
          await bridge().maintain();
          assert.equal((await receipt(poison.id)).status, "invalid");
          assert.equal((await receipt(good.id)).status, "recorded");
          const source = await event(w.id);
          const original = publisher.recordFrozenRoutesTx.bind(publisher);
          publisher.recordFrozenRoutesTx = async () => {
            throw new Error("synthetic_retry");
          };
          try {
            await bridge().maintain();
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          await db.notificationWorkEventReceipt.update({
            where: { sourceEventId: source.id },
            data: { safeInput: { bad: true }, nextAttemptAt: new Date(0) },
          });
          await bridge().maintain();
          assert.equal((await receipt(source.id)).status, "invalid");
          const changed = await event(w.id);
          publisher.recordFrozenRoutesTx = async () => {
            throw new Error("synthetic_retry");
          };
          try {
            await bridge().maintain();
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          const captured = await receipt(changed.id);
          await db.notificationWorkEventReceipt.update({
            where: { id: captured.id },
            data: {
              safeInput: {
                ...(captured.safeInput as Record<
                  string,
                  Prisma.InputJsonValue
                >),
                workNumber: 999999,
              },
              nextAttemptAt: new Date(0),
            },
          });
          await bridge().maintain();
          assert.equal((await receipt(changed.id)).status, "invalid");
        },
      );
      await t.test(
        "rename/no-op retain cutoff; meaningful generation suppresses old uncaptured events",
        async () => {
          const w = await work();
          const before = await db.notificationChannel.findUniqueOrThrow({
            where: { id: channel.id },
          });
          const source = await event(w.id);
          channel = await service.updateChannel(actor.id, channel.id, {
            ...channel,
            name: "Renamed",
            expectedRevision: channel.revision,
          });
          channel = await service.updateChannel(actor.id, channel.id, {
            ...channel,
            expectedRevision: channel.revision,
          });
          const renamed = await db.notificationChannel.findUniqueOrThrow({
            where: { id: channel.id },
          });
          assert.equal(
            renamed.sourceAcceptAfter.getTime(),
            before.sourceAcceptAfter.getTime(),
          );
          await bridge().maintain();
          assert.equal((await receipt(source.id)).status, "recorded");
          const backlog = await event(w.id);
          channel = await service.updateChannel(actor.id, channel.id, {
            ...channel,
            includeDetails: true,
            expectedRevision: channel.revision,
          });
          await bridge().maintain();
          assert.equal((await receipt(backlog.id)).status, "skipped");
          const fresh = await event(w.id);
          await bridge().maintain();
          assert.equal((await receipt(fresh.id)).status, "recorded");
        },
      );
      await t.test(
        "global pause is query-free, preserves activation and compensates after restart",
        async () => {
          const w = await work();
          const source = await event(w.id);
          const disabled = new NotificationConnectionRegistry({
            env: { NOTIFICATIONS_ENABLED: "false" },
          });
          await new NotificationWorkEventBridgeService(
            {} as PrismaService,
            publisher,
            disabled,
          ).maintain();
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { sourceEventId: source.id },
            }),
            0,
          );
          await bridge().maintain();
          assert.equal((await receipt(source.id)).status, "recorded");
          assert.equal(
            (
              await db.notificationWorkEventActivation.findUniqueOrThrow({
                where: { id: "work-events-v1" },
              })
            ).sourceSince.getTime(),
            activation.sourceSince.getTime(),
          );
        },
      );
      await t.test(
        "captured retry freezes its audience across configuration changes",
        async () => {
          const w = await work();
          const source = await event(w.id);
          const original = publisher.recordFrozenRoutesTx.bind(publisher);
          publisher.recordFrozenRoutesTx = async () => {
            throw new Error("synthetic_retry");
          };
          try {
            await bridge().maintain();
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          const frozen = (await receipt(source.id)).routeRefs;
          channel = await service.updateChannel(actor.id, channel.id, {
            ...channel,
            groupId: String(BigInt(channel.groupId) + 1n),
            expectedRevision: channel.revision,
          });
          await due();
          await bridge().maintain();
          const saved = await db.notificationEvent.findUniqueOrThrow({
            where: { eventKey: `work-event:${source.id}` },
          });
          assert.deepEqual(saved.routeRefs, frozen);
          assert.notEqual(
            (frozen as { generation: number }[])[0]!.generation,
            channel.audienceGeneration,
          );
        },
      );
      await t.test(
        "hash collision is quarantined while transient registration retries remain recoverable after five failures",
        async () => {
          const w = await work();
          const poison = await event(w.id);
          await publisher.record({
            eventKey: `work-event:${poison.id}`,
            type: "imported",
            resourceId: w.id,
            aggregateVersion: 1,
            occurredAt: poison.createdAt,
          });
          await bridge().maintain();
          assert.equal((await receipt(poison.id)).status, "invalid");
          const source = await event(w.id);
          const original = publisher.recordFrozenRoutesTx.bind(publisher);
          publisher.recordFrozenRoutesTx = async () => {
            throw new Error("synthetic_retry");
          };
          try {
            for (let i = 0; i < 5; i++) {
              await due();
              await bridge().maintain();
            }
          } finally {
            publisher.recordFrozenRoutesTx = original;
          }
          const retry = await receipt(source.id);
          assert.equal(retry.status, "retry_wait");
          assert.equal(retry.attempts, 5);
          assert.equal(retry.errorCode, "registration_temporarily_unavailable");
          await due();
          await bridge().maintain();
          assert.equal((await receipt(source.id)).status, "recorded");
          const next = await event(w.id);
          await bridge().maintain();
          assert.equal((await receipt(next.id)).status, "recorded");
        },
      );
      await t.test(
        "deferred resource head blocks 10000 followers without quadratic selection work while another head progresses",
        async () => {
          const blocked = await work();
          const unrelated = await work();
          const backlogSize = 10_000;
          await db.$executeRaw`
            INSERT INTO notification_work_event_receipts
              (id, source_event_id, resource_id, resource_ordinal, safe_input, route_refs,
                status, next_attempt_at, updated_at)
            SELECT gen_random_uuid(), gen_random_uuid(), ${blocked.id}::uuid, ordinal,
              '{}'::jsonb, '[]'::jsonb,
              CASE WHEN ordinal = 1 THEN 'retry_wait' ELSE 'pending' END,
              CASE WHEN ordinal = 1 THEN clock_timestamp() + interval '1 hour' ELSE 'epoch'::timestamptz END,
              clock_timestamp()
            FROM generate_series(1, ${backlogSize}) AS series(ordinal)`;
          const source = await event(unrelated.id);
          await db.$executeRaw`ANALYZE notification_work_event_receipts`;
          let executedDueQuery: Prisma.Sql | undefined;
          const observedDb = new Proxy(db, {
            get(target, key) {
              if (key === "$queryRaw")
                return (
                  strings: TemplateStringsArray,
                  ...values: unknown[]
                ) => {
                  const query = Prisma.sql(strings, ...values);
                  if (query.sql.includes("notification_work_event_receipts"))
                    executedDueQuery = query;
                  return target.$queryRaw(query);
                };
              return Reflect.get(target, key);
            },
          });
          await new NotificationWorkEventBridgeService(
            observedDb,
            publisher,
            registry,
          ).maintain();
          assert.equal((await receipt(source.id)).status, "recorded");
          const blockedCounts = await db.notificationWorkEventReceipt.groupBy({
            by: ["status"],
            where: { resourceId: blocked.id },
            _count: { _all: true },
          });
          assert.deepEqual(
            Object.fromEntries(
              blockedCounts.map((row) => [row.status, row._count._all]),
            ),
            { pending: backlogSize - 1, retry_wait: 1 },
          );
          assert.ok(
            executedDueQuery,
            "must explain the actual maintain due query",
          );
          type PlanNode = {
            "Actual Rows"?: number;
            "Actual Loops"?: number;
            "Rows Removed by Filter"?: number;
            "Rows Removed by Join Filter"?: number;
            Plans?: PlanNode[];
          };
          const explained = await db.$queryRaw<
            { "QUERY PLAN": { Plan: PlanNode }[] }[]
          >(
            Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${executedDueQuery}`,
          );
          function observedWork(node: PlanNode): number {
            const localRows =
              (node["Actual Rows"] ?? 0) +
              (node["Rows Removed by Filter"] ?? 0) +
              (node["Rows Removed by Join Filter"] ?? 0);
            return (
              localRows * (node["Actual Loops"] ?? 1) +
              (node.Plans ?? []).reduce(
                (sum, child) => sum + observedWork(child),
                0,
              )
            );
          }
          const workUnits = observedWork(explained[0]!["QUERY PLAN"][0]!.Plan);
          // Bound observed database row/filter work, independent of elapsed time,
          // index names or a prescribed planner node. The old anti-join is ~50M.
          assert.ok(
            workUnits < backlogSize * 20,
            `due selection examined ${workUnits} row/filter units for ${backlogSize} blocked receipts`,
          );
        },
      );
      await t.test(
        "unsupported subscription is terminal and each capture pass is limited to 50 sources",
        async () => {
          const w = await work();
          const unsubscribed = await event(w.id, { action: "stage_left" });
          await bridge().maintain();
          assert.equal((await receipt(unsubscribed.id)).status, "skipped");
          await db.workEvent.createMany({
            data: Array.from({ length: 51 }, () => ({
              workId: w.id,
              action: "imported" as const,
            })),
          });
          await bridge().maintain();
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { resourceId: w.id },
            }),
            51,
          );
          await bridge().maintain();
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { resourceId: w.id },
            }),
            52,
          );
          const plan = await db.$queryRaw<
            { indexdef: string }[]
          >`SELECT indexdef FROM pg_indexes WHERE indexname = 'work_events_notification_uncaptured_idx'`;
          assert.match(plan[0]!.indexdef, /notification_captured_at IS NULL/);
        },
      );
    } finally {
      await db.notificationWorkEventReceipt.deleteMany({
        where: { resourceId: { in: workIds } },
      });
      await db.notificationEvent.deleteMany({
        where: { resourceId: { in: workIds } },
      });
      await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({
        where: { id: { in: candidateIds } },
      });
      await db.authorExternalAccount.delete({ where: { id: account.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.notificationChannel.delete({ where: { id: channel.id } });
      await db.userRole.deleteMany({ where: { userId: actor.id } });
      await db.user.delete({ where: { id: actor.id } });
      await db.$disconnect();
    }
  },
);
