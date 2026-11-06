import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NOTIFICATION_EVENT_KEYS } from "../../src/notifications/notification-events.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationRuntimeService } from "../../src/notifications/notification-runtime.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import type { NotificationSendResult } from "../../src/notifications/notifications.contracts.js";
import { OneBotHttpAdapter } from "../../src/notifications/onebot-http.adapter.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

type Browser = { cookie?: string };
type WorkView = {
  revision: number;
  editorEpoch: number;
  workflowStatus: string;
  typesetHandoffStartedAt: string | null;
};
type EntryView = { id: string; revision: number };

// The imported work is a synthetic fixture, as in workflow.integration.
// Subsequent claims, edits, submissions, handoff and publication use real HTTP.
test(
  "committed work lifecycle survives notification registration failure and reconciles once through Jobs",
  { skip: !testUrl, timeout: 90_000 },
  async (t) => {
    const prefix = randomUUID().slice(0, 8);
    const canaries = {
      title: `PRIVATE_TITLE_${prefix}`,
      author: `PRIVATE_AUTHOR_${prefix}`,
      actor: `PRIVATE_ACTOR_${prefix}`,
      text: `PRIVATE_TRANSLATION_${prefix}`,
      note: `PRIVATE_NOTE_${prefix}`,
      url: `https://fixture.invalid/PRIVATE_URL_${prefix}`,
      token: `SYNTHETIC_TOKEN_${prefix}`,
    };
    const registry = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true", SYNTHETIC_TOKEN: canaries.token },
      manifest: [
        {
          key: "work-loop",
          name: "Synthetic work loop",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const sent: { group: string; text: string }[] = [];
    let workId = "";
    let channelId = "";
    const adapter = {
      async send(
        _connection: unknown,
        group: string,
        text: string,
      ): Promise<NotificationSendResult> {
        // At the synthetic network boundary both locks can be acquired NOWAIT.
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE channel_id = ${channelId}::uuid AND status = 'sending' FOR UPDATE NOWAIT`;
        });
        sent.push({ group, text });
        return {
          status: "accepted",
          providerMessageId: `synthetic-work-loop-${sent.length}`,
          sendBoundaryCrossed: true,
        };
      },
      close() {},
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
        ),
      ],
    })
      .overrideProvider(NotificationConnectionRegistry)
      .useValue(registry)
      .overrideProvider(OneBotHttpAdapter)
      .useValue(adapter)
      .compile();
    const app = moduleRef.createNestApplication();
    configureApplication(app);
    const db = app.get(PrismaService);
    const files = app.get(FileObjectsService);
    const runtime = app.get(NotificationRuntimeService);
    const publisher = app.get(NotificationPublisherService);
    const notifications = app.get(NotificationsService);
    const userIds: string[] = [];
    let authorId = "",
      candidateId = "",
      accountId = "",
      fileId = "",
      base = "";
    const password = "synthetic-work-loop-password";
    // Avoid importing the new bridge: baseline RED must assert missing derived
    // events after a successful business loop, rather than fail at module load.
    const registerFrozen = Reflect.get(publisher, "recordFrozenRoutesTx");
    let registrationFailures = 0;
    const apiDurations: number[] = [];

    async function request<T>(
      browser: Browser,
      method: string,
      path: string,
      body?: object,
      expectedStatus = 200,
    ): Promise<T> {
      const startedAt = performance.now();
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: "http://localhost:5173",
          "X-Comiku-Request": "1",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(browser.cookie ? { Cookie: browser.cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const cookie = response.headers.get("set-cookie");
      if (cookie) browser.cookie = cookie.split(";")[0];
      const data: unknown = await response.json();
      apiDurations.push(performance.now() - startedAt);
      assert.equal(
        response.status,
        expectedStatus,
        `${method} ${path}: ${JSON.stringify(data)}`,
      );
      assert.ok(!JSON.stringify(data).includes("notificationCapturedAt"));
      return data as T;
    }
    async function browserFor(
      role: "admin" | "translator" | "proofreader" | "typesetter" | "operator",
    ) {
      const user = await db.user.create({
        data: {
          username: `work_notify_${prefix}_${role}`,
          displayName: `${canaries.actor}_${role}`,
          passwordHash: await hashPassword(password),
          mustChangePassword: false,
          roles: { create: { role } },
          languageCapabilities: { create: { language: "ja" } },
        },
      });
      userIds.push(user.id);
      const browser: Browser = {};
      await request(browser, "POST", "/api/auth/login", {
        username: user.username,
        password,
      });
      return { browser, user };
    }
    const view = (browser: Browser) =>
      request<WorkView>(browser, "GET", `/api/works/${workId}`);
    async function claim(browser: Browser, stage: string) {
      const current = await view(browser);
      const body = {
        stage,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      };
      const result = await request<WorkView>(
        browser,
        "POST",
        `/api/works/${workId}/stages/claim`,
        body,
      );
      const replay = await request<WorkView>(
        browser,
        "POST",
        `/api/works/${workId}/stages/claim`,
        body,
      );
      assert.equal(replay.revision, result.revision);
      // Claim is participation; editing or obtaining handoff starts the stage.
      assert.equal(result.workflowStatus, current.workflowStatus);
      return result;
    }
    async function submit(browser: Browser, stage: string) {
      const current = await view(browser);
      const body = {
        stage,
        expectedRevision: current.revision,
        expectedEditorEpoch: current.editorEpoch,
        idempotencyKey: randomUUID(),
      };
      const result = await request<WorkView>(
        browser,
        "POST",
        `/api/works/${workId}/stages/submit`,
        body,
      );
      const replay = await request<WorkView>(
        browser,
        "POST",
        `/api/works/${workId}/stages/submit`,
        body,
      );
      assert.equal(replay.revision, result.revision);
      return result;
    }
    async function hasReceiptTable() {
      const rows = await db.$queryRaw<
        { present: boolean }[]
      >`SELECT to_regclass('notification_work_event_receipts') IS NOT NULL AS present`;
      return rows[0]!.present;
    }

    try {
      await app.listen(0, "127.0.0.1");
      base = await app.getUrl();
      const admin = await browserFor("admin");
      const translator = await browserFor("translator");
      const proofreader = await browserFor("proofreader");
      const typesetter = await browserFor("typesetter");
      const operator = await browserFor("operator");
      const channel = await notifications.createChannel(admin.user.id, {
        name: `Synthetic work loop ${prefix}`,
        connectionKey: "work-loop",
        groupId: `9${Date.now()}${Math.floor(Math.random() * 1000)}`,
        enabled: true,
        eventTypes: [...NOTIFICATION_EVENT_KEYS],
        includeDetails: true,
        receiverMode: "legacy",
      });
      channelId = channel.id;
      // Activate before the fixture's first source event, never replay history.
      await runtime.maintain();
      Reflect.set(publisher, "recordFrozenRoutesTx", async () => {
        registrationFailures++;
        throw new Error("synthetic_notification_registration_failure");
      });

      authorId = (
        await db.author.create({
          data: {
            displayName: canaries.author,
            authorizationStatus: "authorized",
          },
        })
      ).id;
      accountId = (
        await db.authorExternalAccount.create({
          data: {
            authorId,
            platform: "fixture",
            externalUserId: prefix,
            handle: prefix,
          },
        })
      ).id;
      fileId = (
        await files.store({
          body: new TextEncoder().encode("synthetic work image"),
          contentType: "image/png",
          bucketScope: "source",
          kind: "candidate-media",
          createdById: admin.user.id,
        })
      ).id;
      candidateId = (
        await db.candidatePost.create({
          data: {
            authorId,
            authorExternalAccountId: accountId,
            platform: "fixture",
            externalPostId: prefix,
            externalPostUrl: canaries.url,
            text: canaries.text,
            postedAt: new Date(),
            rawJson: { privateCanary: canaries.note },
          },
        })
      ).id;
      const work = await db.work.create({
        data: {
          authorId,
          sourceCandidatePostId: candidateId,
          sourcePostUrl: canaries.url,
          title: canaries.title,
          importedById: admin.user.id,
          images: {
            create: {
              originalFileObjectId: fileId,
              orderIndex: 0,
              width: 1000,
              height: 700,
            },
          },
          events: {
            create: {
              actorId: admin.user.id,
              action: "imported",
              toWorkflowStatus: "pending_translate",
              toReviewStatus: "normal",
            },
          },
        },
      });
      workId = work.id;
      const image = await db.workImage.findFirstOrThrow({ where: { workId } });
      await claim(translator.browser, "translate");
      const marked = await request<{ entries: EntryView[] }>(
        translator.browser,
        "POST",
        `/api/work-images/${image.id}/markers`,
        {
          markerX: 0.5,
          markerY: 0.5,
          markerPositionType: "inside",
          expectedImageRevision: 0,
          expectedEditorEpoch: (await view(translator.browser)).editorEpoch,
          idempotencyKey: randomUUID(),
        },
        201,
      );
      const entry = await request<EntryView>(
        translator.browser,
        "PATCH",
        `/api/translation-entries/${marked.entries[0]!.id}`,
        {
          expectedRevision: marked.entries[0]!.revision,
          expectedEditorEpoch: (await view(translator.browser)).editorEpoch,
          translatedText: canaries.text,
          note: canaries.note,
        },
      );
      assert.equal(
        (await view(translator.browser)).workflowStatus,
        "translating",
      );
      assert.equal(
        (await submit(translator.browser, "translate")).workflowStatus,
        "pending_proofread",
      );
      await claim(proofreader.browser, "proofread");
      await request(
        proofreader.browser,
        "PATCH",
        `/api/translation-entries/${entry.id}`,
        {
          expectedRevision: entry.revision,
          expectedEditorEpoch: (await view(proofreader.browser)).editorEpoch,
          translatedText: `${canaries.text}_proofread`,
        },
      );
      assert.equal(
        (await view(proofreader.browser)).workflowStatus,
        "proofreading",
      );
      assert.equal(
        (await submit(proofreader.browser, "proofread")).workflowStatus,
        "pending_typeset",
      );
      const typesetClaim = await claim(typesetter.browser, "typeset");
      const handoffBody = {
        expectedRevision: typesetClaim.revision,
        expectedEditorEpoch: typesetClaim.editorEpoch,
        idempotencyKey: randomUUID(),
      };
      const handoff = await request<{ packageId: string; downloadUrl: string }>(
        typesetter.browser,
        "POST",
        `/api/works/${workId}/typeset/handoff-packages`,
        handoffBody,
      );
      const repeatedHandoff = await request<{ packageId: string }>(
        typesetter.browser,
        "POST",
        `/api/works/${workId}/typeset/handoff-packages`,
        handoffBody,
      );
      assert.equal(repeatedHandoff.packageId, handoff.packageId);
      const download = await fetch(base + handoff.downloadUrl, {
        headers: { Cookie: typesetter.browser.cookie! },
      });
      assert.equal(download.status, 200);
      assert.ok((await download.arrayBuffer()).byteLength > 0);
      const started = await view(typesetter.browser);
      assert.equal(started.workflowStatus, "typesetting");
      assert.ok(started.typesetHandoffStartedAt);
      const form = new FormData();
      form.set("expectedRevision", String(started.revision));
      form.set("idempotencyKey", randomUUID());
      form.set("mode", "new_version");
      form.set("note", canaries.note);
      form.set("sourceImageIds", JSON.stringify([image.id]));
      // Same synthetic PNG IHDR dimensions fixture as the existing workflow test.
      const png = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
      png.writeUInt32BE(1000, 16);
      png.writeUInt32BE(700, 20);
      form.append(
        "files",
        new Blob([png], { type: "image/png" }),
        "synthetic-result.png",
      );
      const uploaded = await fetch(
        base + `/api/works/${workId}/typeset/versions`,
        {
          method: "POST",
          headers: {
            Origin: "http://localhost:5173",
            "X-Comiku-Request": "1",
            Cookie: typesetter.browser.cookie!,
          },
          body: form,
        },
      );
      assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.json()));
      assert.equal(
        (await submit(typesetter.browser, "typeset")).workflowStatus,
        "pending_publish",
      );
      // Operator confirms publication; publish is not a claimable responsibility.
      const publicationBody = {
        expectedRevision: (await view(operator.browser)).revision,
        idempotencyKey: randomUUID(),
        note: canaries.note,
      };
      await request(
        operator.browser,
        "POST",
        `/api/works/${workId}/publishing/confirm`,
        publicationBody,
      );
      await request(
        operator.browser,
        "POST",
        `/api/works/${workId}/publishing/confirm`,
        publicationBody,
      );
      assert.equal((await view(operator.browser)).workflowStatus, "published");
      assert.equal(await db.publishRecord.count({ where: { workId } }), 1);
      t.diagnostic(
        `synthetic HTTP samples=${apiDurations.length}, maxMs=${Math.max(...apiDurations).toFixed(1)}; single fixture, not a capacity benchmark`,
      );

      const sources = await db.workEvent.findMany({ where: { workId } });
      const expectedSources = sources.filter((source) =>
        (NOTIFICATION_EVENT_KEYS as readonly string[]).includes(source.action),
      );
      assert.ok(expectedSources.length >= 8);
      assert.equal(
        sources.filter((source) => source.action === "stage_joined").length,
        3,
      );
      assert.equal(
        sources.filter((source) => source.action === "stage_submitted").length,
        3,
      );
      assert.equal(
        sources.filter((source) => source.action === "publish_confirmed")
          .length,
        1,
      );
      // The worker is offline throughout business requests, then registration fails.
      assert.equal(sent.length, 0);
      assert.equal(
        await db.notificationEvent.count({ where: { resourceId: workId } }),
        0,
      );
      await runtime.maintain();
      assert.equal(
        (await db.work.findUniqueOrThrow({ where: { id: workId } }))
          .workflowStatus,
        "published",
      );
      assert.equal(
        await db.workEvent.count({ where: { workId } }),
        sources.length,
      );
      assert.equal(sent.length, 0);
      assert.equal(
        await db.notificationEvent.count({ where: { resourceId: workId } }),
        0,
      );
      Reflect.set(publisher, "recordFrozenRoutesTx", registerFrozen);

      // Advance only this fixture's retry clock; baseline has no receipt table.
      if (await hasReceiptTable())
        await db.$executeRaw`UPDATE notification_work_event_receipts SET next_attempt_at = NOW() WHERE resource_id = ${workId}::uuid AND status = 'retry_wait'`;
      for (let attempt = 0; attempt < expectedSources.length + 3; attempt++) {
        await runtime.maintain();
        await db.notificationChannel.update({
          where: { id: channelId },
          data: {
            nextSendAt: new Date(0),
            rateWindowAt: new Date(0),
            rateWindowCount: 0,
          },
        });
        await runtime.runNext();
      }
      const events = await db.notificationEvent.findMany({
        where: { resourceId: workId },
      });
      assert.equal(
        events.length,
        expectedSources.length,
        "committed WorkEvents must be reconciled by the application worker",
      );
      assert.ok(
        registrationFailures > 0,
        "fault must reach notification registration after business commit",
      );
      assert.deepEqual(
        new Set(events.map((event) => event.eventKey)),
        new Set(expectedSources.map((source) => `work-event:${source.id}`)),
      );
      assert.equal(
        events.filter((event) => event.type === "stage_started").length,
        2,
      );
      assert.equal(
        events.filter((event) => event.type === "typeset_handoff_started")
          .length,
        1,
      );
      const receipts = await db.$queryRaw<
        {
          sourceEventId: string;
          status: string;
          safeInput: unknown;
          routeRefs: unknown;
        }[]
      >`SELECT source_event_id AS "sourceEventId", status, safe_input AS "safeInput", route_refs AS "routeRefs" FROM notification_work_event_receipts WHERE resource_id = ${workId}::uuid`;
      assert.equal(receipts.length, expectedSources.length);
      assert.ok(receipts.every((receipt) => receipt.status === "recorded"));
      const deliveries = await db.notificationDelivery.findMany({
        where: { event: { resourceId: workId } },
      });
      assert.equal(deliveries.length, expectedSources.length);
      assert.ok(deliveries.every((delivery) => delivery.status === "accepted"));
      assert.equal(sent.length, expectedSources.length);
      assert.ok(sent.every((message) => message.group === channel.groupId));
      const jobs = await db.backgroundJob.findMany({
        where: { id: { in: deliveries.map((delivery) => delivery.jobId!) } },
      });
      assert.equal(jobs.length, expectedSources.length);
      assert.ok(
        jobs.every(
          (job) =>
            job.status === "succeeded" &&
            job.executionScope === "notifications",
        ),
      );
      const exposed = JSON.stringify({ events, receipts, messages: sent });
      for (const canary of Object.values(canaries))
        assert.ok(
          !exposed.includes(canary),
          `private fixture value leaked: ${canary}`,
        );
      for (const event of events) {
        const snapshot = event.snapshot as Record<string, unknown>;
        assert.equal(snapshot.workNumber, work.workNumber);
        assert.equal(snapshot.title, null);
        assert.equal(snapshot.authorName, null);
        assert.equal(snapshot.actorName, null);
      }
      const counts = {
        events: events.length,
        receipts: receipts.length,
        deliveries: deliveries.length,
        sent: sent.length,
      };
      for (let repeat = 0; repeat < 3; repeat++) {
        await runtime.maintain();
        await runtime.runNext();
      }
      assert.deepEqual(
        {
          events: await db.notificationEvent.count({
            where: { resourceId: workId },
          }),
          receipts: (
            await db.$queryRaw<
              { count: number }[]
            >`SELECT COUNT(*)::int AS count FROM notification_work_event_receipts WHERE resource_id = ${workId}::uuid`
          )[0]!.count,
          deliveries: await db.notificationDelivery.count({
            where: { event: { resourceId: workId } },
          }),
          sent: sent.length,
        },
        counts,
      );
    } finally {
      Reflect.set(publisher, "recordFrozenRoutesTx", registerFrozen);
      if (workId) {
        const deliveries = await db.notificationDelivery.findMany({
          where: { event: { resourceId: workId } },
        });
        await db.notificationAttempt.deleteMany({
          where: {
            deliveryId: { in: deliveries.map((delivery) => delivery.id) },
          },
        });
        await db.notificationDelivery.deleteMany({
          where: { event: { resourceId: workId } },
        });
        await db.backgroundJob.deleteMany({
          where: {
            id: {
              in: deliveries.flatMap((delivery) =>
                delivery.jobId ? [delivery.jobId] : [],
              ),
            },
          },
        });
        if (await hasReceiptTable())
          await db.$executeRaw`DELETE FROM notification_work_event_receipts WHERE resource_id = ${workId}::uuid`;
        await db.notificationEvent.deleteMany({
          where: { resourceId: workId },
        });
        await db.publishRecord.deleteMany({ where: { workId } });
        await db.typesetHandoffPackage.deleteMany({ where: { workId } });
        await db.work.updateMany({
          where: { id: workId },
          data: { currentTypesetVersionId: null },
        });
        await db.typesetImageVersion.deleteMany({ where: { workId } });
        await db.workEvent.deleteMany({ where: { workId } });
        await db.stageContributionSubmission.deleteMany({
          where: { participant: { workId } },
        });
        await db.workStageAssignment.deleteMany({
          where: { participant: { workId } },
        });
        await db.workStageParticipant.deleteMany({ where: { workId } });
        await db.translationVersion.deleteMany({ where: { workId } });
        await db.workImage.deleteMany({ where: { workId } });
        await db.work.deleteMany({ where: { id: workId } });
      }
      if (channelId)
        await db.notificationChannel.deleteMany({ where: { id: channelId } });
      if (candidateId) {
        await db.candidateMedia.deleteMany({
          where: { candidatePostId: candidateId },
        });
        await db.candidatePost.deleteMany({ where: { id: candidateId } });
      }
      if (accountId)
        await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
      if (authorId) await db.author.deleteMany({ where: { id: authorId } });
      await db.fileObject.deleteMany({
        where: {
          OR: [
            { id: fileId || randomUUID() },
            { createdById: { in: userIds } },
          ],
        },
      });
      await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
      await db.userLanguageCapability.deleteMany({
        where: { userId: { in: userIds } },
      });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await app.close();
    }
  },
);
