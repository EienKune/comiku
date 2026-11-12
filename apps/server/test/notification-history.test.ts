import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { validate } from "class-validator";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { NotificationDeliveryQueryDto } from "../src/notifications/notifications.dto.js";
import { NotificationStatusService } from "../src/notifications/notification-status.service.js";
import { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import { notificationTemplatePreview } from "../src/notifications/notification-content.js";
import {
  normalizeNotificationEvent,
  notificationPreview,
  renderNotificationMessage,
} from "../src/notifications/notification-events.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { Environment } from "../src/config/environment.js";
import type { Prisma } from "../src/generated/prisma/client.js";

const date = new Date("2026-11-10T00:00:00.000Z");
function row(patch: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    eventId: randomUUID(),
    channelId: randomUUID(),
    audienceGeneration: 1,
    groupId: "123",
    connectionKey: "fixture",
    status: "pending",
    attempts: 0,
    revision: 0,
    createdAt: date,
    updatedAt: date,
    resolvedAt: null,
    errorCode: null,
    providerMessageId: null,
    text: "Frozen original body",
    nextAttemptAt: null as Date | null,
    jobId: null as string | null,
    event: {
      type: "archived",
      resourceId: randomUUID(),
      snapshot: { workNumber: 42 },
      routeRefs: [],
    },
    channel: { name: "Renamed", groupId: "999" },
    ...patch,
  };
}
function history(
  rows = [row(), row()],
  work: { id: string } | null = { id: randomUUID() },
) {
  const queries: Prisma.Sql[] = [];
  const workLookups: unknown[] = [];
  const jobQueries: unknown[] = [];
  const jobs: { id: string; resourceId: string; availableAt: Date }[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      queries.push(sql);
      return rows.map(({ id }) => ({ id }));
    },
    notificationDelivery: { findMany: async () => rows },
    work: {
      findUnique: async (query: unknown) => {
        workLookups.push(query);
        return work;
      },
    },
    backgroundJob: {
      findMany: async (query: unknown) => {
        jobQueries.push(query);
        return jobs;
      },
    },
  };
  const service = new NotificationsService(
    db as unknown as PrismaService,
    {} as NotificationPublisherService,
    new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "false" },
    }),
    { appOrigin: "https://example.test" } as Environment,
  );
  return { service, queries, workLookups, jobQueries, jobs, rows };
}

test("delivery filters use original group, indexed work identity, exclusive dates and limit+1", async () => {
  const h = history();
  const page = await h.service.listDeliveries({
    groupId: "123",
    workNumber: 42,
    eventType: "archived",
    createdFrom: "2026-11-10T08:00:00+08:00",
    createdBefore: "2026-11-11T00:00:00Z",
    limit: 1,
  });
  assert.equal(page.items[0]?.groupId, "123");
  assert.equal(page.items[0]?.preview, "Frozen original body");
  assert.deepEqual(h.workLookups, [
    { where: { workNumber: 42 }, select: { id: true } },
  ]);
  const sql = h.queries[0]!;
  assert.match(sql.text, /d\.group_id =/);
  assert.match(sql.text, /e\.resource_id =/);
  assert.match(sql.text, /e\.type =/);
  assert.match(sql.text, /d\.created_at >=/);
  assert.match(sql.text, /d\.created_at </);
  assert.doesNotMatch(sql.text, /snapshot|COUNT\(|OFFSET|channel\.group_id/i);
  assert.ok(
    sql.values.some(
      (v) => v instanceof Date && v.toISOString() === date.toISOString(),
    ),
  );
  assert.equal(sql.values.at(-1), 2);
  assert.ok(page.nextCursor);
});

test("cursor v2 binds every canonical filter and limit; equivalent timestamps can continue", async () => {
  const h = history();
  const filters = {
    groupId: "123",
    workNumber: 42,
    eventType: "archived",
    status: "pending",
    createdFrom: "2026-11-10T08:00:00+08:00",
    createdBefore: "2026-11-11T00:00:00Z",
    limit: 1,
  };
  const cursor = (await h.service.listDeliveries(filters)).nextCursor!;
  assert.ok(cursor);
  for (const patch of [
    { groupId: "999" },
    { workNumber: 43 },
    { eventType: "imported" },
    { status: "accepted" },
    { createdFrom: "2026-11-09T00:00:00Z" },
    { createdBefore: "2026-11-12T00:00:00Z" },
    { limit: 2 },
  ])
    await assert.rejects(
      h.service.listDeliveries({ ...filters, ...patch, cursor }),
      { status: 400 },
    );
  await h.service.listDeliveries({
    ...filters,
    createdFrom: date.toISOString(),
    cursor,
  });
  assert.match(
    h.queries.at(-1)!.text,
    /\(d\.group_id, d\.created_at, d\.id\) </,
  );
  const statusPage = await h.service.listDeliveries({
    status: "pending",
    limit: 1,
  });
  await h.service.listDeliveries({
    status: "pending",
    limit: 1,
    cursor: statusPage.nextCursor!,
  });
  assert.match(h.queries.at(-1)!.text, /\(d\.status, d\.created_at, d\.id\) </);
});

test("history rejects invalid filters before storage; missing works still validate cursor", async () => {
  const h = history([], null);
  for (const query of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { groupId: "0" },
    { groupId: "1 OR true" },
    { workNumber: 2147483648 },
    { workNumber: 0 },
    { eventType: "secret" },
    { createdFrom: "2026-11-10" },
    { createdFrom: "2026-02-30T00:00:00Z" },
    {
      createdFrom: "2026-11-11T00:00:00Z",
      createdBefore: "2026-11-10T00:00:00Z",
    },
    { createdFrom: date.toISOString(), createdBefore: date.toISOString() },
    { cursor: "" },
  ])
    await assert.rejects(h.service.listDeliveries(query), { status: 400 });
  assert.equal(h.queries.length, 0);
  assert.deepEqual(await h.service.listDeliveries({ workNumber: 42 }), {
    items: [],
    nextCursor: null,
  });
  await assert.rejects(
    h.service.listDeliveries({ workNumber: 42, cursor: "bad" }),
    { status: 400 },
  );
  assert.equal(h.queries.length, 0);
});

test("query DTO defaults to twenty and rejects unsafe filter shapes", async () => {
  assert.equal(new NotificationDeliveryQueryDto().limit, 20);
  for (const patch of [
    { groupId: "0" },
    { workNumber: 2147483648 },
    { eventType: "private" },
    { createdFrom: "2026-11-10T00:00:00" },
    { createdBefore: "2026-02-30T00:00:00Z" },
  ]) {
    const errors = await validate(
      Object.assign(new NotificationDeliveryQueryDto(), patch),
    );
    assert.ok(errors.length, JSON.stringify(patch));
  }
});

test("nextEligibleAt uses one bounded queued-job lookup and the later retry boundary", async () => {
  const a = row({
    jobId: randomUUID(),
    nextAttemptAt: new Date(date.getTime() + 5000),
  });
  const b = row({
    jobId: randomUUID(),
    status: "retry_wait",
    nextAttemptAt: date,
  });
  const c = row({ jobId: randomUUID(), status: "accepted" });
  const h = history([
    a,
    b,
    c,
    row({ status: "retry_wait" }),
    row({ jobId: randomUUID() }),
  ]);
  h.jobs.push(
    { id: a.jobId as string, resourceId: a.id, availableAt: date },
    {
      id: b.jobId as string,
      resourceId: b.id,
      availableAt: new Date(date.getTime() + 9000),
    },
  );
  const page = await h.service.listDeliveries();
  assert.deepEqual(
    page.items.map((item) => item.nextEligibleAt),
    [
      new Date(date.getTime() + 5000).toISOString(),
      new Date(date.getTime() + 9000).toISOString(),
      null,
      null,
      null,
    ],
  );
  assert.equal(h.jobQueries.length, 1);
  const query = h.jobQueries[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
  };
  assert.equal(query.where.status, "queued");
  assert.equal(query.where.kind, "notification_deliver");
  assert.deepEqual(query.where.attempts, { lt: 3 });
  assert.deepEqual(query.select, {
    id: true,
    resourceId: true,
    availableAt: true,
  });
  assert.doesNotMatch(JSON.stringify(page), /lastError|payload/);
});

test("outgoing metrics are separately bounded and exclude resolved failed/unknown history", async () => {
  const sqls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      sqls.push(sql);
      if (sql.text.includes("FROM notification_deliveries"))
        return Array.from({ length: 1001 }, () => ({ createdAt: date }));
      return [];
    },
  };
  const service = new NotificationStatusService(
    db as unknown as PrismaService,
    new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "false" },
    }),
  );
  const result = await service.status();
  assert.deepEqual(
    Object.keys(result.deliveries).sort(),
    [
      "pending",
      "retryWait",
      "sending",
      "failedUnresolved",
      "unknownUnresolved",
    ].sort(),
  );
  for (const metric of Object.values(result.deliveries))
    assert.deepEqual(metric, {
      count: 1000,
      capped: true,
      oldestAt: date.toISOString(),
    });
  const outgoing = sqls.filter((sql) =>
    sql.text.includes("FROM notification_deliveries"),
  );
  assert.equal(outgoing.length, 5);
  for (const sql of outgoing) {
    assert.match(
      sql.text,
      /ORDER BY status ASC, created_at ASC, id ASC LIMIT 1001/,
    );
    assert.match(sql.text, /status BETWEEN/);
    assert.doesNotMatch(sql.text, /COUNT\(|last_error|payload/i);
    assert.match(sql.text, /resolved_at IS NULL/);
    if (sql.values.includes("failed") || sql.values.includes("unknown"))
      assert.match(sql.text, /status IN \('failed', 'unknown'\)/);
  }
});

test("synthetic previews and tests never claim a fake work link; real event URLs remain exact", () => {
  for (const type of ["imported", "notification.test"] as const) {
    assert.doesNotMatch(
      notificationPreview(type, true, "https://example.test"),
      /\/works\//,
    );
    assert.match(
      notificationPreview(type, true, "https://example.test"),
      /示例|测试/,
    );
  }
  const settings = {
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: false,
    note: "",
  };
  assert.doesNotMatch(
    notificationTemplatePreview("imported", settings, "https://example.test"),
    /\/works\//,
  );
  const event = normalizeNotificationEvent({
    eventKey: "fixture",
    type: "imported",
    resourceId: randomUUID(),
    aggregateVersion: 1,
    occurredAt: date,
  });
  assert.ok(
    renderNotificationMessage(event, {
      includeDetails: false,
      siteUrl: "https://example.test",
    }).endsWith(`https://example.test/works/${event.resourceId}`),
  );
  assert.doesNotMatch(
    renderNotificationMessage(
      { ...event, type: "notification.test" },
      { includeDetails: false, siteUrl: "https://example.test" },
    ),
    /\/works\//,
  );
});
