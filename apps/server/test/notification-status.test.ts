import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Logger } from "@nestjs/common";
import type { PrismaService } from "../src/database/prisma.service.js";
import { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import { Prisma } from "../src/generated/prisma/client.js";

async function createService(
  query: (sql: Prisma.Sql) => Promise<unknown>,
  enabled = true,
) {
  const loaded =
    await import("../src/notifications/notification-status.service.js").catch(
      () => null,
    );
  assert.ok(loaded?.NotificationStatusService, "status service must exist");
  return new loaded.NotificationStatusService(
    { $queryRaw: query, $executeRaw: query } as unknown as PrismaService,
    new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: String(enabled) },
    }),
  );
}
const date = new Date("2026-11-10T00:00:00.000Z");
const activation = (patch: Record<string, unknown> = {}) => ({
  id: "work-events-v1",
  sourceSince: date,
  lastMaintenanceAt: null,
  lastCaptureAt: null,
  lastRegistrationAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  ...patch,
});

for (const enabled of [false, true]) {
  test(`${enabled ? "uninitialized" : "disabled"} status does not query source events`, async () => {
    const sqls: Prisma.Sql[] = [];
    const service = await createService(async (sql) => {
      sqls.push(sql);
      if (sql.text.includes("notification_work_event_activation"))
        return enabled ? [] : [activation()];
      assert.doesNotMatch(sql.text, /FROM work_events/);
      return [];
    }, enabled);
    const result = await service.status();
    assert.equal(result.state, enabled ? "not_started" : "disabled");
    assert.equal(result.counts.uncaptured, null);
    assert.deepEqual(result.counts.pending, {
      count: 0,
      capped: false,
      oldestAt: null,
    });
    assert.equal(sqls.length, 9);
  });
}

test("status uses bounded oldest-first queries and reports failed maintenance before first success", async () => {
  const service = await createService(async (sql) => {
    if (sql.text.includes("notification_work_event_activation"))
      return [
        activation({ lastErrorAt: date, lastErrorCode: "maintenance_failed" }),
      ];
    assert.match(
      sql.text,
      /ORDER BY (?:status ASC, )?(?:e\.)?created_at ASC, (?:e\.)?id ASC/,
    );
    assert.match(sql.text, /LIMIT 1001/);
    assert.doesNotMatch(sql.text, /COUNT\(|GROUP BY/i);
    return Array.from({ length: 1001 }, (_, index) => ({
      id: String(index),
      createdAt: date,
    }));
  });
  const result = await service.status();
  assert.equal(result.state, "error");
  for (const metric of Object.values(result.counts))
    assert.deepEqual(metric, {
      count: 1000,
      capped: true,
      oldestAt: date.toISOString(),
    });
});

test("worker state reflects last successful maintenance rather than configuration or capture activity", async () => {
  for (const [patch, expected] of [
    [{}, "not_started"],
    [{ lastMaintenanceAt: new Date() }, "healthy"],
    [{ lastMaintenanceAt: new Date(Date.now() - 61_000) }, "stale"],
    [
      { lastMaintenanceAt: date, lastErrorAt: new Date(date.getTime() + 1) },
      "error",
    ],
    [{ lastMaintenanceAt: new Date(), lastErrorAt: date }, "healthy"],
  ] as const) {
    const service = await createService(async (sql) =>
      sql.text.includes("notification_work_event_activation")
        ? [activation(patch)]
        : [],
    );
    assert.equal((await service.status()).state, expected);
  }
});

test("uncaptured metrics split old and expanded source boundaries into separate bounded index reads", async () => {
  const queries: Prisma.Sql[] = [];
  const expandedSince = new Date(date.getTime() + 10_000);
  const service = await createService(async (sql) => {
    if (sql.text.includes("notification_work_event_activation"))
      return [
        activation(),
        activation({
          id: "work-events-expanded-v1",
          sourceSince: expandedSince,
        }),
      ];
    if (!sql.text.includes("FROM work_events")) return [];
    queries.push(sql);
    return Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      createdAt: queries.length === 1 ? date : expandedSince,
    }));
  });
  const status = await service.status();
  assert.equal(
    queries.length,
    2,
    "each source index needs its own independently bounded read",
  );
  assert.ok(queries.some((sql) => sql.text.includes("'metadata_updated'")));
  for (const query of queries) {
    assert.doesNotMatch(query.text, /\bOR\b/);
    assert.match(query.text, /LIMIT 1001/);
  }
  assert.deepEqual(status.counts.uncaptured, {
    count: 1000,
    capped: true,
    oldestAt: date.toISOString(),
  });
});

test("receipt pages whitelist fields, validate event types and bind opaque cursors to filter", async () => {
  const row = {
    id: randomUUID(),
    sourceEventId: randomUUID(),
    resourceId: randomUUID(),
    workNumber: "42",
    eventType: "imported",
    status: "retry_wait",
    attempts: 2,
    errorCode: "driver_password_CANARY",
    nextAttemptAt: date,
    createdAt: date,
    updatedAt: date,
    notificationEventId: null,
    safeInput: { title: "PRIVATE_CANARY" },
    routeRefs: [{ token: "SECRET_CANARY" }],
  };
  const queries: Prisma.Sql[] = [];
  const service = await createService(async (sql) => {
    queries.push(sql);
    return [row, { ...row, id: randomUUID(), eventType: "PRIVATE_CANARY" }];
  });
  const page = await service.receipts({ limit: 1 });
  assert.equal(page.items[0]?.eventLabel, "已导入");
  assert.equal(page.items[0]?.workNumber, 42);
  assert.equal(page.items[0]?.errorCode, null);
  assert.deepEqual(
    Object.keys(page.items[0]!).sort(),
    [
      "id",
      "sourceEventId",
      "resourceId",
      "workNumber",
      "eventType",
      "eventLabel",
      "status",
      "attempts",
      "errorCode",
      "nextAttemptAt",
      "createdAt",
      "updatedAt",
      "notificationEventId",
    ].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(page),
    /PRIVATE_CANARY|SECRET_CANARY|driver_password/,
  );
  assert.ok(page.nextCursor);
  assert.doesNotMatch(
    queries[0]!.text,
    /SELECT\s+\*|route_refs|safe_input\s*[,\n]/i,
  );
  await service.receipts({
    status: "retry_wait",
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.match(queries[1]!.text, /\(created_at, id\) </);
  for (const query of [
    { status: "pending", cursor: page.nextCursor },
    { cursor: "not-base64" },
    {
      cursor: Buffer.from(
        JSON.stringify({
          id: row.id,
          createdAt: "2026-02-30T00:00:00.000Z",
          status: "retry_wait",
        }),
      ).toString("base64url"),
    },
    {
      cursor: Buffer.from(
        JSON.stringify({
          id: "bad",
          createdAt: date.toISOString(),
          status: "retry_wait",
        }),
      ).toString("base64url"),
    },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.1 },
    { status: "private" },
  ])
    await assert.rejects(service.receipts(query), { status: 400 });
  const unknown = await service.receipts({ limit: 2 });
  assert.equal(unknown.items[1]?.eventType, null);
  assert.equal(unknown.items[1]?.eventLabel, null);
});

test("maintenance observations preserve activation cutoff and isolate storage failures without logging driver secrets", async () => {
  const writes: Prisma.Sql[] = [];
  const service = await createService(async (sql) => {
    writes.push(sql);
    return 1;
  });
  await service.recordMaintenance({
    success: true,
    captured: 2,
    registered: 0,
  });
  assert.match(writes[0]!.text, /last_maintenance_at/);
  assert.match(writes[0]!.text, /last_capture_at/);
  assert.doesNotMatch(writes[0]!.text, /source_since\s*=/);
  await service.recordMaintenance({
    success: false,
    captured: 0,
    registered: 0,
  });
  assert.match(writes[1]!.text, /last_error_at/);
  assert.doesNotMatch(writes[1]!.text, /last_maintenance_at\s*=/);
  const fail = await createService(async () => {
    throw new Error("DRIVER_SECRET_CANARY");
  });
  const messages: unknown[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = (message: unknown) => {
    messages.push(message);
  };
  try {
    await fail.recordMaintenance({ success: true, captured: 1, registered: 1 });
  } finally {
    Logger.prototype.warn = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(JSON.stringify(messages), /DRIVER_SECRET_CANARY/);
});
