import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationRuntimeService } from "../../src/notifications/notification-runtime.service.js";
import { NotificationWorkEventBridgeService } from "../../src/notifications/notification-work-event-bridge.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import type { OneBotHttpAdapter } from "../../src/notifications/onebot-http.adapter.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "template subscriptions freeze capture-time content and preserve legacy history",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const registry = new NotificationConnectionRegistry({
      env: {
        NOTIFICATIONS_ENABLED: "true",
        SYNTHETIC_TEMPLATE_TOKEN: "synthetic",
      },
      manifest: [
        {
          key: "template-fixture",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_TEMPLATE_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const publisher = new NotificationPublisherService(db);
    const service = new NotificationsService(db, publisher, registry, env);
    const bridge = (database = db) =>
      new NotificationWorkEventBridgeService(
        database,
        publisher,
        registry,
        env,
      );
    const runtime = new NotificationRuntimeService(
      db,
      new JobsService(db),
      registry,
      {} as OneBotHttpAdapter,
      env,
    );
    const actor = await db.user.create({
      data: {
        username: `tmpl_${randomUUID()}`,
        displayName: "ACTOR_AT_CAPTURE",
        passwordHash: "synthetic",
        mustChangePassword: false,
        roles: { create: { role: "admin" } },
      },
    });
    const author = await db.author.create({
      data: { displayName: "AUTHOR_AT_CAPTURE" },
    });
    const account = await db.authorExternalAccount.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalUserId: randomUUID(),
      },
    });
    const workIds: string[] = [],
      candidateIds: string[] = [],
      channelIds: string[] = [];
    const base = {
      connectionKey: "template-fixture",
      enabled: true,
      eventTypes: ["stage_submitted"],
      includeDetails: false,
    };
    const channel = async (
      name: string,
      mode: "templates" | "legacy",
      stages: ("translate" | "proofread" | "typeset")[] | null = null,
    ) => {
      const c = await service.createChannel(actor.id, {
        ...base,
        name,
        groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
        receiverMode: mode,
        subscriptionRules: [{ eventType: "stage_submitted", stages }],
      });
      channelIds.push(c.id);
      return c;
    };
    const work = async () => {
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
      const w = await db.work.create({
        data: {
          authorId: author.id,
          sourceCandidatePostId: candidate.id,
          importedById: actor.id,
          title: "TITLE_AT_CAPTURE",
        },
      });
      workIds.push(w.id);
      return w;
    };
    const source = (
      workId: string,
      stage?: "translate" | "proofread" | "typeset",
    ) =>
      db.workEvent.create({
        data: {
          workId,
          actorId: actor.id,
          action: "stage_submitted",
          detail: { ...(stage && { stage }), privateNote: "MUST_NOT_LEAK" },
        },
      });
    const template = async () =>
      (await service.configuration()).templates.find(
        (row) => row.eventType === "stage_submitted",
      )!;
    const save = async (fields: {
      titleEnabled: boolean;
      authorEnabled: boolean;
      actorEnabled: boolean;
      note: string;
    }) =>
      service.updateTemplate(actor.id, "stage_submitted", {
        expectedRevision: (await template()).revision,
        ...fields,
      });
    const originalTemplate = (await service.configuration()).templates?.find(
      (row) => row.eventType === "stage_submitted",
    );
    try {
      await t.test(
        "catalog has 15 conservative independent templates and stale concurrent saves fail",
        async () => {
          const config = await service.configuration();
          assert.equal(
            config.templates?.length,
            15,
            "all public events need shared templates",
          );
          const initial = await template();
          assert.equal(initial.titleEnabled, false);
          assert.equal(initial.authorEnabled, false);
          assert.equal(initial.actorEnabled, false);
          const changes = {
            expectedRevision: initial.revision,
            titleEnabled: true,
            authorEnabled: false,
            actorEnabled: true,
            note: "ORIGINAL_TEMPLATE_NOTE",
          };
          const outcomes = await Promise.allSettled([
            service.updateTemplate(actor.id, "stage_submitted", changes),
            service.updateTemplate(actor.id, "stage_submitted", {
              ...changes,
              note: "OTHER_NOTE",
            }),
          ]);
          assert.equal(
            outcomes.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            outcomes.filter((r) => r.status === "rejected").length,
            1,
          );
          await save({
            titleEnabled: true,
            authorEnabled: false,
            actorEnabled: true,
            note: "ORIGINAL_TEMPLATE_NOTE",
          });
        },
      );
      const modern = await channel("Modern", "templates", ["translate"]);
      let legacy = await channel("Legacy", "legacy");
      await bridge().maintain();
      await t.test(
        "stage conditions use historical source stage, and legacy/new groups get distinct frozen bodies",
        async () => {
          const w = await work();
          const event = await source(w.id, "translate");
          await bridge().maintain();
          const receipt =
            await db.notificationWorkEventReceipt.findUniqueOrThrow({
              where: { sourceEventId: event.id },
            });
          assert.equal(receipt.inputVersion, 2);
          assert.equal(receipt.status, "recorded");
          await save({
            titleEnabled: false,
            authorEnabled: true,
            actorEnabled: false,
            note: "REVISED_TEMPLATE_NOTE",
          });
          await db.work.update({
            where: { id: w.id },
            data: { title: "LATER_TITLE" },
          });
          await db.user.update({
            where: { id: actor.id },
            data: { displayName: "LATER_ACTOR" },
          });
          await runtime.maintain();
          const deliveries = await db.notificationDelivery.findMany({
            where: { eventId: receipt.notificationEventId! },
          });
          assert.equal(deliveries.length, 2);
          const newText = deliveries.find(
            (d) => d.channelId === modern.id,
          )!.text;
          const oldText = deliveries.find(
            (d) => d.channelId === legacy.id,
          )!.text;
          assert.match(newText, /TITLE_AT_CAPTURE/);
          assert.match(newText, /ACTOR_AT_CAPTURE/);
          assert.match(newText, /ORIGINAL_TEMPLATE_NOTE/);
          assert.doesNotMatch(
            newText,
            /AUTHOR_AT_CAPTURE|LATER_|REVISED_TEMPLATE_NOTE|MUST_NOT_LEAK/,
          );
          assert.doesNotMatch(
            oldText,
            /TITLE_AT_CAPTURE|ACTOR_AT_CAPTURE|AUTHOR_AT_CAPTURE|TEMPLATE_NOTE|MUST_NOT_LEAK/,
          );
          const w2 = await work();
          const proof = await source(w2.id, "proofread");
          const missing = await source(w2.id);
          await bridge().maintain();
          await bridge().maintain();
          await runtime.maintain();
          for (const id of [proof.id, missing.id]) {
            const r = await db.notificationWorkEventReceipt.findUniqueOrThrow({
              where: { sourceEventId: id },
            });
            const ds = await db.notificationDelivery.findMany({
              where: { eventId: r.notificationEventId! },
            });
            assert.deepEqual(
              ds.map((d) => d.channelId),
              [legacy.id],
            );
          }
        },
      );
      await t.test(
        "capture failure leaves business source committed, retries with first successful observation and never rehydrates",
        async () => {
          const w = await work();
          const event = await source(w.id, "translate");
          let failures = 0;
          const faultDb = new Proxy(db, {
            get(target, key, receiver) {
              if (key !== "$transaction")
                return Reflect.get(target, key, receiver);
              return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
                target.$transaction((tx) =>
                  fn(
                    new Proxy(tx, {
                      get(txTarget, txKey, txReceiver) {
                        if (txKey !== "notificationWorkEventReceipt")
                          return Reflect.get(txTarget, txKey, txReceiver);
                        return new Proxy(
                          txTarget.notificationWorkEventReceipt,
                          {
                            get(delegate, method) {
                              if (method === "create")
                                return () => {
                                  failures++;
                                  throw new Error(
                                    "synthetic capture persistence fault",
                                  );
                                };
                              return Reflect.get(delegate, method);
                            },
                          },
                        );
                      },
                    }),
                  ),
                );
            },
          });
          await bridge(faultDb).maintain();
          assert.ok(failures > 0);
          assert.ok(await db.workEvent.findUnique({ where: { id: event.id } }));
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: { sourceEventId: event.id },
            }),
            0,
          );
          const marked = await db.$queryRaw<
            { captured: Date | null }[]
          >`SELECT notification_captured_at AS captured FROM work_events WHERE id=${event.id}::uuid`;
          assert.equal(marked[0]!.captured, null);
          await db.author.update({
            where: { id: author.id },
            data: { displayName: "AUTHOR_FIRST_SUCCESS" },
          });
          await bridge().maintain();
          await db.author.update({
            where: { id: author.id },
            data: { displayName: "AUTHOR_AFTER_SUCCESS" },
          });
          await runtime.maintain();
          await bridge().maintain();
          const r = await db.notificationWorkEventReceipt.findUniqueOrThrow({
            where: { sourceEventId: event.id },
          });
          const d = await db.notificationDelivery.findFirstOrThrow({
            where: { eventId: r.notificationEventId!, channelId: modern.id },
          });
          assert.match(d.text, /AUTHOR_FIRST_SUCCESS/);
          assert.doesNotMatch(d.text, /AUTHOR_AFTER_SUCCESS/);
          const listed = await service.listDeliveries();
          const view = listed.items.find((row) => row.id === d.id)!;
          assert.ok(view.metadataObservedAt);
          assert.ok(view.contentRevision !== null);
        },
      );
      await t.test(
        "legacy v1 pending and history survive mode adoption without audience rollover",
        async () => {
          const resource = (await work()).id;
          const stored = await db.notificationChannel.findUniqueOrThrow({
            where: { id: legacy.id },
          });
          const v1 = await db.$transaction((tx) =>
            publisher.recordFrozenRoutesTx(
              tx,
              {
                eventKey: `legacy-template-test:${randomUUID()}`,
                type: "stage_submitted",
                resourceId: resource,
                aggregateVersion: 1,
                occurredAt: new Date(),
                workNumber: 9001,
              },
              [
                {
                  id: legacy.id,
                  revision: stored.revision,
                  generation: stored.audienceGeneration,
                  groupId: stored.groupId,
                  connectionKey: stored.connectionKey,
                  connectionFingerprint: stored.connectionFingerprint,
                  includeDetails: false,
                  templateVersion: 1,
                },
              ],
            ),
          );
          await runtime.maintain();
          const old = await db.notificationDelivery.findFirstOrThrow({
            where: { eventId: v1.id },
          });
          legacy = await service.updateChannel(actor.id, legacy.id, {
            ...base,
            name: legacy.name,
            groupId: legacy.groupId,
            receiverMode: "templates",
            subscriptionRules: [{ eventType: "stage_submitted", stages: null }],
            expectedRevision: legacy.revision,
          });
          assert.equal(legacy.audienceGeneration, stored.audienceGeneration);
          assert.equal(
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: legacy.id },
              })
            ).sourceAcceptAfter.toISOString(),
            stored.sourceAcceptAfter.toISOString(),
          );
          const pending = await db.notificationDelivery.findUniqueOrThrow({
            where: { id: old.id },
          });
          assert.equal(pending.status, "pending");
          assert.equal(pending.text, old.text);
          await db.notificationDelivery.update({
            where: { id: old.id },
            data: { status: "failed" },
          });
          const replay = await service.resolveDelivery(actor.id, old.id, {
            expectedRevision: pending.revision,
            action: "retry",
            idempotencyKey: randomUUID(),
          });
          assert.ok(replay.preview.includes(old.text));
          assert.match(replay.preview, /补发/);
          assert.doesNotMatch(replay.preview, /REVISED_TEMPLATE_NOTE|AUTHOR_/);
          assert.ok([...replay.preview].length <= 1000);
          const event = await source(resource, "translate");
          await bridge().maintain();
          await runtime.maintain();
          const r = await db.notificationWorkEventReceipt.findUniqueOrThrow({
            where: { sourceEventId: event.id },
          });
          const fresh = await db.notificationDelivery.findFirstOrThrow({
            where: { eventId: r.notificationEventId!, channelId: legacy.id },
          });
          assert.match(
            fresh.text,
            /REVISED_TEMPLATE_NOTE|AUTHOR_AFTER_SUCCESS/,
          );
        },
      );
      await t.test(
        "saved sample is idempotent, uses saved template, and subscription change cancels all old pending",
        async () => {
          const key = randomUUID();
          const expectedTemplateRevision = (await template()).revision;
          const a = await service.testChannel(actor.id, modern.id, key, {
            eventType: "stage_submitted",
            stage: "translate",
            expectedRevision: modern.revision,
            expectedTemplateRevision,
          });
          const b = await service.testChannel(actor.id, modern.id, key, {
            eventType: "stage_submitted",
            stage: "translate",
            expectedRevision: modern.revision,
            expectedTemplateRevision,
          });
          assert.equal(a.id, b.id);
          assert.match(a.preview, /REVISED_TEMPLATE_NOTE/);
          await assert.rejects(
            service.testChannel(actor.id, modern.id, randomUUID(), {
              eventType: "stage_submitted",
              stage: "proofread",
              expectedRevision: modern.revision,
              expectedTemplateRevision,
            }),
          );
          const changed = await service.updateChannel(actor.id, modern.id, {
            ...base,
            name: modern.name,
            groupId: modern.groupId,
            receiverMode: "templates",
            subscriptionRules: [
              { eventType: "stage_submitted", stages: ["proofread"] },
            ],
            expectedRevision: modern.revision,
          });
          assert.equal(
            changed.audienceGeneration,
            modern.audienceGeneration + 1,
          );
          assert.equal(
            await db.notificationDelivery.count({
              where: {
                channelId: modern.id,
                status: { in: ["pending", "retry_wait"] },
              },
            }),
            0,
          );
        },
      );
    } finally {
      const events = await db.notificationEvent.findMany({
        where: {
          OR: [
            { resourceId: { in: workIds } },
            { eventKey: { startsWith: `test:${actor.id}:` } },
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
      await db.notificationWorkEventReceipt.deleteMany({
        where: { resourceId: { in: workIds } },
      });
      await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({
        where: { id: { in: candidateIds } },
      });
      await db.authorExternalAccount.delete({ where: { id: account.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.notificationChannel.deleteMany({
        where: { id: { in: channelIds } },
      });
      if (originalTemplate)
        await service.updateTemplate(actor.id, "stage_submitted", {
          expectedRevision: (await template()).revision,
          titleEnabled: originalTemplate.titleEnabled,
          authorEnabled: originalTemplate.authorEnabled,
          actorEnabled: originalTemplate.actorEnabled,
          note: originalTemplate.note,
        });
      await db.userRole.deleteMany({ where: { userId: actor.id } });
      await db.user.delete({ where: { id: actor.id } });
      await db.$disconnect();
    }
  },
);
