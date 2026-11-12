import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationRuntimeService } from "../src/notifications/notification-runtime.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import type { OneBotHttpAdapter } from "../src/notifications/onebot-http.adapter.js";
import type { Environment } from "../src/config/environment.js";
import type { JobHandler } from "../src/jobs/jobs.service.js";
import { JobDeferred } from "../src/jobs/jobs.service.js";
import type { NotificationSendResult } from "../src/notifications/notifications.contracts.js";

test("maintenance records bridge evidence once while observation failures cannot stop routing", async () => {
  for (const observationFails of [false, true]) {
    const result = { success: true, captured: 2, registered: 1 };
    const observations: unknown[] = [];
    let routingReads = 0;
    const runtime = new NotificationRuntimeService(
      {
        notificationEvent: {
          findMany: async () => {
            routingReads++;
            return [];
          },
        },
        notificationDelivery: { findMany: async () => [] },
        $queryRaw: async () => [],
      } as never,
      {} as never,
      { enabled: true } as never,
      {} as never,
      { appOrigin: "https://example.test" } as Environment,
      { maintain: async () => result } as never,
      {
        recordMaintenance: async (evidence: unknown) => {
          observations.push(evidence);
          if (observationFails) throw new Error("synthetic monitoring failure");
        },
      } as never,
    );
    await runtime.maintain();
    assert.deepEqual(observations, [result]);
    assert.equal(routingReads, 1);
  }
});

test("routing uses recipient frozen text even after event metadata and current template change", async () => {
  let saved!: { text: string };
  const channel = {
    id: "channel",
    enabled: true,
    audienceGeneration: 1,
    groupId: "123",
    connectionKey: "test",
    connectionFingerprint: "a".repeat(64),
  };
  const event = {
    id: "event",
    routedAt: null,
    routeRefs: [
      {
        id: channel.id,
        revision: 1,
        generation: 1,
        groupId: "123",
        connectionKey: "test",
        connectionFingerprint: "a".repeat(64),
        content: { text: "FROZEN ORIGINAL BODY" },
      },
    ],
  };
  const tx = {
    $queryRaw: async () => [],
    notificationEvent: {
      findUniqueOrThrow: async () => event,
      update: async () => ({}),
    },
    notificationChannel: { findUnique: async () => channel },
    notificationDelivery: {
      createMany: async ({ data }: { data: { text: string } }) => {
        saved = data;
      },
    },
  };
  const db = {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    $queryRaw: async () => [],
    notificationEvent: { findMany: async () => [event] },
    notificationDelivery: { findMany: async () => [] },
  };
  const runtime = new NotificationRuntimeService(
    db as never,
    {} as never,
    { enabled: true } as never,
    {} as never,
    { appOrigin: "https://changed.example" } as Environment,
  );
  await runtime.maintain();
  assert.equal(saved.text, "FROZEN ORIGINAL BODY");
});

test("disabled runtime registers nothing, polls nothing and sends nothing", async () => {
  const fail = () => {
    throw new Error("disabled notification touched dependency");
  };
  const runtime = new NotificationRuntimeService(
    new Proxy({}, { get: fail }) as unknown as PrismaService,
    new Proxy({}, { get: fail }) as unknown as JobsService,
    { enabled: false } as unknown as NotificationConnectionRegistry,
    { send: fail } as unknown as OneBotHttpAdapter,
    { appOrigin: "https://example.test" } as Environment,
  );
  runtime.onModuleInit();
  assert.equal(runtime.enabled, false);
  await runtime.maintain();
  assert.equal(await runtime.runNext(), false);
});

test("reconciliation preserves a cancellation committed after its pending snapshot", async () => {
  const delivery = {
    id: "delivery",
    jobId: "job",
    status: "pending",
    errorCode: null as string | null,
    revision: 0,
  };
  let attemptsChanged = 0;
  type Change = {
    status: string;
    errorCode: string;
    revision: { increment: number };
  };
  const apply = (data: Change) => {
    delivery.status = data.status;
    delivery.errorCode = data.errorCode;
    delivery.revision += data.revision.increment;
  };
  const tx = {
    $queryRaw: async () => [],
    backgroundJob: {
      findUnique: async () => ({ id: "job", status: "failed", attempts: 3 }),
    },
    notificationDelivery: {
      findUnique: async () => {
        const snapshot = { ...delivery };
        Object.assign(delivery, {
          status: "cancelled",
          errorCode: "channel_configuration_changed",
          revision: 1,
        });
        return snapshot;
      },
      update: async ({ data }: { data: Change }) => apply(data),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          jobId?: string;
          status?: string;
          revision?: number;
        };
        data: Change;
      }) => {
        const matches =
          where.id === delivery.id &&
          (where.jobId === undefined || where.jobId === delivery.jobId) &&
          (where.status === undefined || where.status === delivery.status) &&
          (where.revision === undefined ||
            where.revision === delivery.revision);
        if (matches) apply(data);
        return { count: Number(matches) };
      },
    },
    notificationAttempt: {
      updateMany: async () => {
        attemptsChanged++;
        return { count: 1 };
      },
    },
  };
  const db = {
    notificationEvent: { findMany: async () => [] },
    notificationDelivery: { findMany: async () => [] },
    $queryRaw: async () => [{ id: delivery.id, jobId: delivery.jobId }],
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const runtime = new NotificationRuntimeService(
    db as unknown as PrismaService,
    {} as unknown as JobsService,
    { enabled: true } as unknown as NotificationConnectionRegistry,
    {} as unknown as OneBotHttpAdapter,
    { appOrigin: "https://example.test" } as Environment,
  );
  await runtime.maintain();
  assert.equal(delivery.status, "cancelled");
  assert.equal(delivery.errorCode, "channel_configuration_changed");
  assert.equal(delivery.revision, 1);
  assert.equal(attemptsChanged, 0);
});

test("only committed non-accepted sends log numeric protocol diagnostics without private payloads", async (t) => {
  const privacyCanary = "PRIVATE_MESSAGE_TOKEN_URL_CANARY";
  const qq = "98765432100123456789";
  const warnings: unknown[][] = [];
  let attemptSettled = false;
  t.mock.method(console, "warn", (...args: unknown[]) => {
    assert.equal(attemptSettled, true, "warn only after durable settlement");
    warnings.push(args);
  });
  for (const fixture of [
    {
      status: "unknown",
      commit: true,
      diagnostics: {
        httpStatus: 200,
        retcode: 12001,
        wording: privacyCanary,
        qq,
        response: { message: privacyCanary },
      },
      expected: { httpStatus: 200, retcode: 12001 },
    },
    {
      status: "failed",
      commit: true,
      diagnostics: { httpStatus: 403, retcode: 1404 },
      expected: { httpStatus: 403, retcode: 1404 },
    },
    {
      status: "retryable",
      commit: true,
      diagnostics: {
        httpStatus: "200",
        retcode: Number.NaN,
        rawResponse: privacyCanary,
      },
      expected: {},
    },
    {
      status: "unknown",
      commit: true,
      diagnostics: { httpStatus: 600, retcode: Number.MAX_SAFE_INTEGER },
      expected: {},
    },
    { status: "accepted", commit: true, diagnostics: {}, expected: {} },
    { status: "unknown", commit: false, diagnostics: {}, expected: {} },
  ] as const) {
    attemptSettled = false;
    const channel = {
      id: "channel-id",
      enabled: true,
      audienceGeneration: 1,
      groupId: qq,
      connectionKey: "synthetic",
      connectionFingerprint: "a".repeat(64),
      rateWindowAt: null,
      nextSendAt: null,
    };
    const row = {
      id: "delivery-id",
      channelId: channel.id,
      eventId: "event-id",
      status: "pending",
      attempts: 0,
      audienceGeneration: 1,
      groupId: qq,
      connectionKey: channel.connectionKey,
      connectionFingerprint: channel.connectionFingerprint,
      text: privacyCanary,
      messageSegments: null,
      channel,
      event: {
        id: "event-id",
        type: "imported",
        resourceKind: "work",
        resourceId: "work-id",
        aggregateVersion: 1,
        ordinal: 0,
        snapshot: { private: privacyCanary, qq },
      },
    };
    const tx = {
      $queryRaw: async () => [],
      backgroundJob: { count: async () => 1 },
      notificationDelivery: {
        findUnique: async () => row,
        findUniqueOrThrow: async () => row,
        findFirst: async () => null,
        update: async () => row,
        updateMany: async () => ({ count: Number(fixture.commit) }),
      },
      notificationEvent: { findFirst: async () => null },
      notificationChannel: { update: async () => channel },
      notificationAttempt: {
        create: async () => ({ id: "attempt-id", number: 1 }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          assert.equal("diagnostics" in data, false);
          attemptSettled = true;
        },
      },
    };
    let handler!: JobHandler;
    const runtime = new NotificationRuntimeService(
      {
        $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
      } as unknown as PrismaService,
      {
        register: (_kind: string, run: JobHandler) => {
          handler = run;
        },
      } as unknown as JobsService,
      {
        enabled: true,
        get: () => ({ fingerprint: channel.connectionFingerprint }),
      } as unknown as NotificationConnectionRegistry,
      {
        send: async () =>
          ({
            status: fixture.status,
            errorCode: "notification_receipt_unconfirmed",
            sendBoundaryCrossed: true,
            diagnostics: fixture.diagnostics,
          }) as NotificationSendResult,
      } as unknown as OneBotHttpAdapter,
      { appOrigin: `https://${privacyCanary}.example` } as Environment,
    );
    runtime.onModuleInit();
    const before = warnings.length;
    const execution = handler(
      { id: "job-id", resourceId: row.id, leaseId: "lease-id" } as never,
      new AbortController().signal,
    );
    if (fixture.status === "retryable" && fixture.commit)
      await assert.rejects(execution, JobDeferred);
    else await execution;
    if (fixture.status === "accepted" || !fixture.commit) {
      assert.equal(warnings.length, before);
      continue;
    }
    assert.equal(warnings.length, before + 1);
    assert.equal(warnings.at(-1)!.length, 1);
    const warning = String(warnings.at(-1)![0]);
    assert.deepEqual(JSON.parse(warning), {
      scope: "notifications",
      event: "delivery_settled",
      deliveryId: row.id,
      attemptId: "attempt-id",
      channelId: channel.id,
      eventId: row.eventId,
      eventType: "imported",
      attemptNumber: 1,
      status: fixture.status,
      errorCode: "notification_receipt_unconfirmed",
      ...fixture.expected,
    });
    assert.doesNotMatch(warning, /PRIVATE_MESSAGE|98765432100123456789/);
    assert.doesNotMatch(warning, /wording|response|token|url|qq/i);
  }
});
