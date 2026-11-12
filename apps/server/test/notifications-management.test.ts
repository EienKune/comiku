import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import type { Environment } from "../src/config/environment.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import {
  normalizeNotificationEvent,
  renderNotificationMessage,
} from "../src/notifications/notification-events.js";

for (const rename of [false, true]) {
  test(`${rename ? "name-only" : "canonical no-op"} saves preserve the audience and pending notifications`, async () => {
    const channel = {
      id: "channel",
      name: "Synthetic",
      connectionKey: "fixture",
      connectionFingerprint: "a".repeat(64),
      groupId: "123",
      enabled: true,
      eventTypes: ["imported", "archived"],
      includeDetails: false,
      revision: 2,
      audienceGeneration: 3,
    };
    let updates = 0;
    let cancellations = 0;
    const tx = {
      $queryRaw: async () => [],
      user: {
        findUnique: async () => ({
          isActive: true,
          mustChangePassword: false,
          roles: [{ role: "admin" }],
        }),
      },
      notificationChannel: {
        findUnique: async () => channel,
        update: async ({
          data,
        }: {
          data: {
            name?: string;
            revision?: { increment: number };
            audienceGeneration?: { increment: number };
          };
        }) => {
          updates++;
          return {
            ...channel,
            name: data.name ?? channel.name,
            revision: channel.revision + (data.revision?.increment ?? 0),
            audienceGeneration:
              channel.audienceGeneration +
              (data.audienceGeneration?.increment ?? 0),
          };
        },
      },
      notificationDelivery: {
        updateMany: async () => {
          cancellations++;
          return { count: 1 };
        },
      },
    };
    const service = new NotificationsService(
      {
        $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      } as unknown as PrismaService,
      {} as unknown as NotificationPublisherService,
      {
        get: () => ({
          key: "fixture",
          fingerprint: channel.connectionFingerprint,
        }),
      } as unknown as NotificationConnectionRegistry,
      { appOrigin: "https://example.test" } as Environment,
    );
    const result = await service.updateChannel("actor", channel.id, {
      ...channel,
      name: rename ? "Renamed" : " Synthetic ",
      eventTypes: ["archived", "imported", "imported"],
      expectedRevision: 2,
    });
    assert.equal(result.audienceGeneration, 3);
    assert.equal(result.revision, rename ? 3 : 2);
    assert.equal(updates, rename ? 1 : 0);
    assert.equal(cancellations, 0);
  });
}

test("channel writes reject unavailable connection before any database write", async () => {
  const service = new NotificationsService(
    {
      $transaction: () => {
        throw new Error("database must not be reached");
      },
    } as unknown as PrismaService,
    {} as unknown as NotificationPublisherService,
    { get: () => undefined } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  await assert.rejects(
    service.createChannel("actor", {
      name: "群",
      connectionKey: "missing",
      groupId: "123",
      enabled: true,
      eventTypes: ["imported"],
      includeDetails: false,
    }),
    /连接不可用/,
  );
});

test("an administrator can disable an existing channel while its manifest connection is unavailable", async () => {
  const channel = {
    id: "channel",
    name: "群",
    connectionKey: "offline",
    connectionFingerprint: "a".repeat(64),
    groupId: "123",
    enabled: true,
    eventTypes: ["imported"],
    includeDetails: false,
    revision: 0,
    audienceGeneration: 1,
  };
  const tx = {
    $queryRaw: async () => [{ now: new Date("2026-11-07T00:00:00Z") }],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    notificationChannel: {
      findUnique: async () => channel,
      update: async ({ data }: { data: Partial<typeof channel> }) => ({
        ...channel,
        ...data,
        revision: 1,
        audienceGeneration: 2,
      }),
    },
    notificationDelivery: { updateMany: async () => ({ count: 0 }) },
  };
  const service = new NotificationsService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {} as unknown as NotificationPublisherService,
    { get: () => undefined } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  const result = await service.updateChannel("actor", channel.id, {
    ...channel,
    enabled: false,
    expectedRevision: 0,
  });
  assert.equal(result.enabled, false);
});

test("a concurrent unique-group constraint is reported as a controlled conflict", async () => {
  const tx = {
    $executeRaw: async () => 0,
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    $queryRaw: async () => [],
    notificationChannel: {
      count: async () => 0,
      findUnique: async () => null,
      create: async () => {
        throw { code: "P2002", secret: "not-for-output" };
      },
    },
  };
  const service = new NotificationsService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {} as unknown as NotificationPublisherService,
    {
      get: () => ({ key: "fixture", fingerprint: "a".repeat(64) }),
    } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  await assert.rejects(
    service.createChannel("actor", {
      name: "群",
      connectionKey: "fixture",
      groupId: "123",
      enabled: true,
      eventTypes: ["imported"],
      includeDetails: false,
    }),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.getStatus() === 409 &&
      !JSON.stringify(error).includes("not-for-output"),
  );
});

test("replaying a full Unicode message preserves one historical header and the complete link within 1000 codepoints", async () => {
  const appOrigin = `https://${Array(3).fill("a".repeat(63)).join(".")}.test`;
  const event = {
    id: "event",
    ...normalizeNotificationEvent({
      eventKey: "replay-boundary",
      type: "imported",
      resourceId: "b43061af-e7c4-4a57-bfc0-a7da1e254773",
      aggregateVersion: 1,
      occurredAt: "2026-11-06T00:00:00Z",
      workNumber: 1001,
      title: "🙂".repeat(240),
      authorName: "🙂".repeat(240),
      actorName: "🙂".repeat(240),
    }),
  };
  const channel = {
    id: "channel",
    name: "Synthetic",
    enabled: true,
    audienceGeneration: 1,
    connectionFingerprint: "a".repeat(64),
    connectionKey: "fixture",
    includeDetails: true,
  };
  const source = {
    id: "source",
    eventId: event.id,
    channelId: channel.id,
    event,
    channel,
    audienceGeneration: 1,
    connectionFingerprint: channel.connectionFingerprint,
    connectionKey: channel.connectionKey,
    groupId: "123",
    channelRevision: 0,
    revision: 0,
    status: "unknown",
    attempts: 1,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    errorCode: null,
    providerMessageId: null,
    text: renderNotificationMessage(event, {
      includeDetails: true,
      siteUrl: appOrigin,
      historicalReplay: true,
    }),
  };
  assert.equal([...source.text].length, 1000);
  const tx = {
    $queryRaw: async () => [],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    notificationDelivery: {
      findUnique: async () => source,
      findFirst: async () => null,
      aggregate: async () => ({ _max: { replayGeneration: 1 } }),
      update: async () => source,
      create: async ({ data }: { data: Partial<typeof source> }) => ({
        ...source,
        ...data,
        id: "replay",
      }),
    },
  };
  const service = new NotificationsService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {} as unknown as NotificationPublisherService,
    {
      get: () => ({
        key: "fixture",
        fingerprint: channel.connectionFingerprint,
      }),
    } as unknown as NotificationConnectionRegistry,
    { appOrigin } as Environment,
  );
  const result = await service.resolveDelivery("actor", source.id, {
    expectedRevision: 0,
    action: "retry",
    idempotencyKey: "synthetic",
    confirmPossibleDuplicate: true,
  });
  assert.ok([...result.preview].length <= 1000);
  assert.ok(result.preview.endsWith(`${appOrigin}/works/${event.resourceId}`));
  assert.equal(result.preview.match(/历史补发/g)?.length, 1);
});

test("enabled group targets may keep work subscriptions empty for independent reminder use", async () => {
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
    notificationChannel: {
      count: async () => 0,
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "reminders-only",
        revision: 0,
        audienceGeneration: 1,
        ...data,
      }),
    },
  };
  const service = new NotificationsService(
    {
      $transaction: (action: (value: typeof tx) => Promise<unknown>) =>
        action(tx),
    } as never,
    {} as never,
    { get: () => ({ key: "fixture", fingerprint: "a".repeat(64) }) } as never,
    { appOrigin: "https://example.test" } as Environment,
  );
  const channel = await service.createChannel("actor", {
    name: "Reminders only",
    connectionKey: "fixture",
    groupId: "123",
    enabled: true,
    eventTypes: [],
    subscriptionRules: [],
    receiverMode: "templates",
    includeDetails: false,
  });
  assert.equal(channel.enabled, true);
  assert.deepEqual(channel.eventTypes, []);
  assert.deepEqual(channel.subscriptionRules, []);
});
