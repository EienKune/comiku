import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationRuntimeService } from "../src/notifications/notification-runtime.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import type { OneBotHttpAdapter } from "../src/notifications/onebot-http.adapter.js";
import type { Environment } from "../src/config/environment.js";

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
