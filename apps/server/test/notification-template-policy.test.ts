import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import type { Environment } from "../src/config/environment.js";
const loadPolicy = async () => {
  const module =
    await import("../src/notifications/notification-template-policy.js").catch(
      () => null,
    );
  assert.ok(module, "template policy implementation is required");
  return module;
};
test("unconfigured templates independently default all optional fields off", async () => {
  const { resolveTemplatePolicy } = await loadPolicy();
  const a = resolveTemplatePolicy("imported"),
    b = resolveTemplatePolicy("stage_submitted");
  assert.deepEqual(a, {
    eventType: "imported",
    titleEnabled: false,
    authorEnabled: false,
    actorEnabled: false,
    note: "",
    revision: 0,
    contentRevision: 0,
  });
  a.titleEnabled = true;
  assert.equal(b.titleEnabled, false);
});
test("stage rules exclude unknown stages and reject filtering global events", async () => {
  const { normalizeSubscriptionRules, matchesSubscriptionRule } =
    await loadPolicy();
  const rules = normalizeSubscriptionRules([
    {
      eventType: "stage_submitted",
      stages: ["typeset", "translate", "translate"],
    },
  ]);
  assert.deepEqual(rules, [
    { eventType: "stage_submitted", stages: ["translate", "typeset"] },
  ]);
  assert.equal(
    matchesSubscriptionRule(rules, "stage_submitted", undefined),
    null,
  );
  assert.equal(
    matchesSubscriptionRule(rules, "stage_submitted", "proofread"),
    null,
  );
  assert.ok(matchesSubscriptionRule(rules, "stage_submitted", "translate"));
  assert.throws(
    () =>
      normalizeSubscriptionRules([
        { eventType: "imported", stages: ["translate"] },
      ]),
    /职责/,
  );
  assert.throws(
    () =>
      normalizeSubscriptionRules([
        { eventType: "stage_submitted", stages: [] },
      ]),
    /职责/,
  );
});
const fixture = () => {
  let channel = {
    id: "channel",
    name: "群",
    connectionKey: "fixture",
    connectionFingerprint: "a".repeat(64),
    groupId: "123",
    enabled: true,
    eventTypes: ["stage_submitted"],
    includeDetails: true,
    receiverMode: "legacy",
    subscriptionRules: [],
    revision: 2,
    audienceGeneration: 4,
  };
  let cancellations = 0;
  let template: Record<string, unknown> | null = null;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ now: new Date() }],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    notificationChannel: {
      findUnique: async () => channel,
      findMany: async () => [channel],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        channel = {
          ...channel,
          ...data,
          revision: channel.revision + 1,
          audienceGeneration:
            channel.audienceGeneration + (data.audienceGeneration ? 1 : 0),
        } as typeof channel;
        return channel;
      },
    },
    notificationDelivery: {
      updateMany: async () => {
        cancellations++;
        return { count: 1 };
      },
    },
    notificationTemplate: {
      findMany: async () => (template ? [template] : []),
      findUnique: async () => template,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        template = data;
        return template;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        template = { ...template, ...data };
        return template;
      },
    },
  };
  const service = new NotificationsService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {} as NotificationPublisherService,
    {
      get: () => ({ key: "fixture", fingerprint: "a".repeat(64) }),
    } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  return {
    service,
    channel,
    tx,
    get cancellations() {
      return cancellations;
    },
  };
};
test("explicit adoption preserves audience and old queued text", async () => {
  const f = fixture();
  const result = await f.service.updateChannel("actor", "channel", {
    ...f.channel,
    receiverMode: "templates",
    subscriptionRules: [{ eventType: "stage_submitted", stages: null }],
    expectedRevision: 2,
    expectedTemplateRevisions: [{ eventType: "stage_submitted", revision: 0 }],
  });
  assert.equal(result.audienceGeneration, 4);
  assert.equal(result.receiverMode, "templates");
  assert.equal(f.cancellations, 0);
});
test("template saves preserve queues, use codepoints and reject stale revisions", async () => {
  const f = fixture();
  assert.equal(
    typeof f.service.updateTemplate,
    "function",
    "template management save is required",
  );
  const input = {
    expectedRevision: 0,
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: true,
    note: "🙂".repeat(120),
  };
  const saved = await f.service.updateTemplate(
    "actor",
    "stage_submitted",
    input,
  );
  assert.equal(saved.titleEnabled, true);
  assert.equal(saved.authorEnabled, false);
  assert.equal(saved.contentRevision, 1);
  assert.equal(f.cancellations, 0);
  await assert.rejects(
    f.service.updateTemplate("actor", "stage_submitted", input),
    /已更新/,
  );
  await assert.rejects(
    f.service.updateTemplate("actor", "stage_submitted", {
      ...input,
      expectedRevision: 1,
      note: "🙂".repeat(121),
    }),
    /120/,
  );
});

test("stage rule changes cancel the entire old audience while unchanged template saves retain content revision", async () => {
  const f = fixture();
  const changed = await f.service.updateChannel("actor", "channel", {
    ...f.channel,
    subscriptionRules: [{ eventType: "stage_submitted", stages: ["typeset"] }],
    expectedRevision: 2,
  });
  assert.equal(changed.audienceGeneration, 5);
  assert.equal(f.cancellations, 1);
  const first = await f.service.updateTemplate("actor", "imported", {
    expectedRevision: 0,
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: false,
    note: "提醒",
  });
  const second = await f.service.updateTemplate("actor", "imported", {
    expectedRevision: first.revision,
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: false,
    note: "提醒",
  });
  assert.equal(second.revision, 1);
  assert.equal(second.contentRevision, 1);
});
test("modern groups refuse old-client saves and downgrade attempts", async () => {
  const f = fixture();
  f.tx.notificationChannel.findUnique = async () => ({
    ...f.channel,
    receiverMode: "templates",
    subscriptionRules: [],
  });
  await assert.rejects(
    f.service.updateChannel("actor", "channel", {
      ...f.channel,
      receiverMode: undefined,
      expectedRevision: 2,
    }),
    /刷新/,
  );
  await assert.rejects(
    f.service.updateChannel("actor", "channel", {
      ...f.channel,
      receiverMode: "legacy",
      expectedRevision: 2,
    }),
    /刷新/,
  );
});
test("global and fixed-stage preview samples reject impossible selected stages", () => {
  const f = fixture();
  assert.throws(
    () =>
      f.service.preview({
        eventType: "imported",
        includeDetails: false,
        stage: "translate",
      }),
    /职责/,
  );
  assert.throws(
    () =>
      f.service.preview({
        eventType: "publish_confirmed",
        includeDetails: false,
        stage: "translate",
      }),
    /职责/,
  );
  const sample = f.service.preview({
    eventType: "stage_submitted",
    includeDetails: false,
    stage: "typeset",
    template: {
      titleEnabled: false,
      authorEnabled: true,
      actorEnabled: false,
      note: "🙂".repeat(120),
    },
  });
  assert.match(sample.text, /职责：嵌字/);
  assert.match(sample.text, /作者：/);
  assert.doesNotMatch(sample.text, /标题：|操作：/);
});
test("draft previews omit missing metadata without inventing names", () => {
  const f = fixture();
  const sample = f.service.preview({
    eventType: "stage_submitted",
    stage: "proofread",
    includeDetails: false,
    missingMetadata: true,
    template: {
      titleEnabled: true,
      authorEnabled: true,
      actorEnabled: true,
      note: "",
    },
  });
  assert.match(sample.text, /职责：校对/);
  assert.doesNotMatch(sample.text, /标题：|作者：|操作：/);
});

test("saved sample history and replay retain the confirmed template revision after template edits", async () => {
  const channel = {
    id: "channel",
    name: "Synthetic",
    groupId: "123",
    enabled: true,
    receiverMode: "templates",
    subscriptionRules: [{ eventType: "stage_submitted", stages: null }],
    eventTypes: ["stage_submitted"],
    includeDetails: false,
    revision: 2,
    audienceGeneration: 4,
    connectionKey: "fixture",
    connectionFingerprint: "a".repeat(64),
  };
  let template = {
    eventType: "stage_submitted",
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: false,
    note: "Original sample",
    revision: 3,
    contentRevision: 3,
  };
  let event: Record<string, unknown>;
  let source: Record<string, unknown> | null = null;
  const now = new Date("2026-01-01T00:00:00.000Z");
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    notificationChannel: { findUnique: async () => channel },
    notificationTemplate: { findMany: async () => [template] },
    notificationEvent: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        event = { ...event, ...data };
        return event;
      },
    },
    notificationDelivery: {
      findUnique: async ({ where }: { where: { requestKey?: string } }) =>
        where.requestKey ? null : source,
      findFirst: async () => null,
      aggregate: async () => ({ _max: { replayGeneration: 0 } }),
      update: async () => source,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const result = {
          ...data,
          id: source ? "replay" : "sample",
          event,
          channel,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          errorCode: null,
          providerMessageId: null,
          revision: 0,
          resolvedAt: null,
        };
        if (!source) source = result;
        return result;
      },
    },
  };
  const service = new NotificationsService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {
      recordTx: async (_tx: unknown, input: Record<string, unknown>) => {
        event = {
          ...input,
          id: "event",
          snapshot: { workNumber: null, stage: "translate" },
          routeRefs: [],
        };
        return event;
      },
    } as unknown as NotificationPublisherService,
    {
      enabled: true,
      get: () => ({
        key: "fixture",
        fingerprint: channel.connectionFingerprint,
      }),
    } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  const saved = await service.testChannel("actor", channel.id, "sample-key", {
    eventType: "stage_submitted",
    stage: "translate",
    expectedRevision: 2,
    expectedTemplateRevision: 3,
  });
  assert.equal(saved.contentRevision, 3);
  assert.equal(saved.metadataOrigin, null);
  assert.equal(saved.metadataObservedAt, null);
  assert.match(saved.preview, /示例消息，不对应真实作品/);
  assert.doesNotMatch(saved.preview, /\/works\//);
  const frozen = (
    event!.routeRefs as { content: { formatVersion: number } }[]
  )[0]!;
  assert.equal(frozen.content.formatVersion, 2);
  template = {
    ...template,
    note: "Changed later",
    revision: 4,
    contentRevision: 4,
  };
  source = { ...(source ?? {}), status: "failed" };
  const replay = await service.resolveDelivery("actor", saved.id, {
    expectedRevision: 0,
    action: "retry",
    idempotencyKey: "replay-key",
  });
  assert.equal(replay.contentRevision, 3);
  assert.equal(replay.metadataOrigin, null);
  assert.equal(replay.metadataObservedAt, null);
  assert.ok(replay.preview.includes(saved.preview));
  assert.match(replay.preview, /Original sample/);
  assert.doesNotMatch(replay.preview, /Changed later/);
});
