import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  birthdayAddDays,
  birthdayCutoffEligible,
  birthdayDueAt,
  birthdayLocalDate,
  birthdayOffsetStates,
  normalizeBirthdayNote,
  validateBirthdaySchedule,
} from "../src/birthdays/birthday-policy.js";
import {
  birthdayNotificationHash,
  renderBirthdayNotification,
} from "../src/birthdays/birthday-notification.js";
import { birthdayDeliveryInvalidReason } from "../src/notifications/notification-birthday-policy.js";
import { normalizeNotificationHistoryQuery } from "../src/notifications/notification-history-query.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
} from "../src/notifications/notification-events.js";
import { NotificationRuntimeService } from "../src/notifications/notification-runtime.service.js";
import type { Environment } from "../src/config/environment.js";
import { birthdayReminderCheckedAt } from "../src/birthdays/adapters/ba/ba-birthday-data.adapter.js";
import type { BirthdayPerson } from "../src/birthdays/adapters/ba/providers/schaledb.js";

test("birthday calendar uses Shanghai calendar addition without moving leap birthdays", () => {
  assert.equal(
    birthdayLocalDate(new Date("2026-12-31T16:00:00Z")),
    "2027-01-01",
  );
  assert.equal(birthdayAddDays("2026-12-31", 7), "2027-01-07");
  assert.equal(birthdayAddDays("2028-02-28", 1), "2028-02-29");
  assert.equal(birthdayAddDays("2027-02-28", 1), "2027-03-01");
  assert.equal(
    birthdayDueAt("2026-11-11", "09:00").toISOString(),
    "2026-11-11T01:00:00.000Z",
  );
  assert.equal(birthdayCutoffEligible(null, new Date()), false);
  assert.deepEqual(
    birthdayOffsetStates({ 0: { generation: 1, acceptAfter: "invalid" } }),
    {},
  );
  assert.throws(() =>
    validateBirthdaySchedule({
      displayEnabled: true,
      remindersEnabled: true,
      sendTime: "09:00",
      offsetDays: [],
    }),
  );
  assert.throws(() =>
    validateBirthdaySchedule({
      displayEnabled: true,
      remindersEnabled: true,
      sendTime: "24:00",
      offsetDays: [0],
    }),
  );
});

const people = [
  { key: "one", name: "示例甲", month: 11, day: 11, originalEntryId: 1 },
  { key: "two", name: "示例乙", month: 11, day: 11, originalEntryId: 2 },
];
const snapshot = {
  kind: "birthday_digest" as const,
  sendLocalDate: "2026-11-11",
  targetLocalDate: "2026-11-11",
  offsetDays: 0,
  dueAt: "2026-11-11T01:00:00.000Z",
  validBefore: "2026-11-11T16:00:00.000Z",
  catalogId: "fixture",
  catalogVersion: "a".repeat(64),
  checkedAt: "2026-11-11T00:00:00.000Z",
  people,
  count: 2,
};
test("birthday text retains the whole same-day list, safe replay space and no work URL", () => {
  const text = renderBirthdayNotification(snapshot, "生日快乐");
  assert.match(text, /示例甲、示例乙/);
  assert.match(text, /今天生日 · 2026-11-11/);
  assert.doesNotMatch(text, /works\/|作者|操作|职责/);
  assert.equal(normalizeBirthdayNote("  生日快乐  "), "生日快乐");
  assert.throws(() => normalizeBirthdayNote("bad\ncopy"));
  assert.throws(() => normalizeBirthdayNote("😀".repeat(121)));
  assert.throws(
    () =>
      renderBirthdayNotification(
        { ...snapshot, people: [{ ...people[0]!, name: "长".repeat(1000) }] },
        "",
      ),
    /too_long/,
  );
  assert.equal(
    birthdayNotificationHash("one", snapshot),
    birthdayNotificationHash("one", { ...snapshot }),
  );
  assert.notEqual(
    birthdayNotificationHash("one", snapshot),
    birthdayNotificationHash("two", snapshot),
  );
  assert.equal(
    normalizeNotificationHistoryQuery({ eventType: "birthday.reminder" })
      .eventType,
    "birthday.reminder",
  );
});

test("birthday policy fences all three scopes and expires only the frozen birthday intent", () => {
  const cutoff = new Date("2026-11-10T00:00:00Z");
  const settings = {
    remindersEnabled: true,
    reminderGeneration: 2,
    reminderAcceptAfter: cutoff,
    offsetDays: [0],
    offsetStates: { 0: { generation: 3, acceptAfter: cutoff.toISOString() } },
  } as unknown as Parameters<typeof birthdayDeliveryInvalidReason>[2];
  const scope = {
    enabled: true,
    audienceGeneration: 4,
    acceptAfter: cutoff,
  } as Parameters<typeof birthdayDeliveryInvalidReason>[3];
  const generations = {
    birthdayGlobalGeneration: 2,
    birthdayOffsetGeneration: 3,
    birthdayScopeGeneration: 4,
  };
  const now = new Date("2026-11-11T02:00:00Z");
  assert.equal(
    birthdayDeliveryInvalidReason(snapshot, generations, settings, scope, now),
    null,
  );
  const dueAt = new Date(snapshot.dueAt);
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      generations,
      {
        ...settings!,
        reminderAcceptAfter: dueAt,
        offsetStates: {
          0: { generation: 3, acceptAfter: dueAt.toISOString() },
        },
      },
      { ...scope!, acceptAfter: dueAt },
      now,
    ),
    null,
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      { ...generations, birthdayGlobalGeneration: 1 },
      settings,
      scope,
      now,
    ),
    "birthday_schedule_changed",
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      { ...generations, birthdayOffsetGeneration: 2 },
      settings,
      scope,
      now,
    ),
    "birthday_schedule_changed",
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      { ...generations, birthdayScopeGeneration: 3 },
      settings,
      scope,
      now,
    ),
    "birthday_subscription_changed",
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      generations,
      {
        ...settings!,
        reminderAcceptAfter: new Date("2026-11-11T01:00:00.001Z"),
      },
      scope,
      now,
    ),
    "birthday_schedule_changed",
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      generations,
      settings,
      { ...scope!, acceptAfter: new Date("2026-11-11T01:00:00.001Z") },
      now,
    ),
    "birthday_subscription_changed",
  );
  assert.equal(
    birthdayDeliveryInvalidReason(
      snapshot,
      generations,
      settings,
      scope,
      new Date(snapshot.validBefore),
    ),
    "birthday_expired",
  );
});

test("birthday support does not broaden work normalization or change legacy work hashes", () => {
  const work = {
    eventKey: "fixture",
    type: "imported" as const,
    resourceId: "00000000-0000-4000-8000-000000000001",
    aggregateVersion: 1,
    occurredAt: "2026-11-11T00:00:00.000Z",
    workNumber: 1,
  };
  assert.deepEqual(Object.keys(normalizeNotificationEvent(work)), [
    "eventKey",
    "type",
    "resourceId",
    "aggregateVersion",
    "ordinal",
    "occurredAt",
    "snapshot",
  ]);
  assert.equal(
    notificationPayloadHash(work),
    notificationPayloadHash({ ...work, resourceKind: "work" } as typeof work),
  );
  assert.throws(
    () =>
      normalizeNotificationEvent({
        ...work,
        type: "birthday.reminder",
      } as never),
    /notification_event_invalid/,
  );
});

test("reminders validate each birthday's own evidence and keep Schale original review protection", () => {
  const now = new Date("2026-11-11T02:00:00Z");
  const fresh = new Date(now.getTime() - 47 * 3_600_000);
  const stale = new Date(now.getTime() - 49 * 3_600_000);
  const base: BirthdayPerson = {
    key: "synthetic",
    name: "合成人物",
    aliases: [],
    month: 11,
    day: 11,
    originalEntryId: 1,
    entryIds: [1],
    notificationEligible: true,
  };
  const kivo: BirthdayPerson = {
    ...base,
    originalEntryId: null,
    entryIds: [],
    birthdaySource: {
      source: "kivo",
      entryId: 123,
      profileHash: "a".repeat(64),
    },
  };
  const evidence = {
    personKey: base.key,
    status: "confirmed",
    profileHash: "a".repeat(64),
    lastCheckedAt: fresh,
  };
  assert.equal(birthdayReminderCheckedAt(base, fresh, undefined, now), fresh);
  assert.equal(
    birthdayReminderCheckedAt(
      { ...base, originalEntryId: null },
      fresh,
      undefined,
      now,
    ),
    null,
  );
  assert.equal(
    birthdayReminderCheckedAt(kivo, stale, evidence, now),
    fresh,
    "Schale failure must not block a fresh supplemental birthday",
  );
  assert.equal(
    birthdayReminderCheckedAt(
      kivo,
      now,
      { ...evidence, lastCheckedAt: stale },
      now,
    ),
    null,
    "a primary-source success must not refresh a supplemental birthday",
  );
  for (const changed of [
    { status: "pending" },
    { personKey: "another-person" },
    { profileHash: "b".repeat(64) },
    { lastCheckedAt: null },
    { lastCheckedAt: new Date(now.getTime() + 1) },
    { lastCheckedAt: new Date(now.getTime() - 48 * 3_600_000) },
  ]) {
    assert.equal(
      birthdayReminderCheckedAt(kivo, now, { ...evidence, ...changed }, now),
      null,
    );
  }
  assert.equal(birthdayReminderCheckedAt(kivo, now, undefined, now), null);
  assert.equal(
    birthdayReminderCheckedAt(
      { ...kivo, notificationEligible: false },
      now,
      evidence,
      now,
    ),
    null,
  );
  const mixed = {
    ...snapshot,
    people: [
      ...people,
      {
        ...people[0]!,
        key: "kivo",
        name: "合成未实装人物",
        originalEntryId: null,
      },
    ],
  };
  assert.match(renderBirthdayNotification(mixed, ""), /合成未实装人物/);
  assert.equal(
    birthdayNotificationHash("legacy", snapshot),
    "d2d782c1dadfa755c31cc6b33ae359111d76e176047a797c9b8ba54c6ffd4105",
  );
});

test("disabled birthday feature cancels frozen routes and reserved jobs without birthday policy reads", async () => {
  const channel = {
    id: "channel",
    enabled: true,
    audienceGeneration: 1,
    groupId: "123",
    connectionKey: "fixture",
    connectionFingerprint: "a".repeat(64),
  };
  const event = {
    id: "event",
    type: "birthday.reminder",
    resourceKind: "birthday_digest",
    routedAt: null,
    snapshot,
    routeRefs: [
      {
        id: channel.id,
        generation: 1,
        groupId: channel.groupId,
        connectionKey: channel.connectionKey,
        connectionFingerprint: channel.connectionFingerprint,
        birthdayGlobalGeneration: 2,
        birthdayOffsetGeneration: 3,
        birthdayScopeGeneration: 4,
        content: { text: "FROZEN BIRTHDAY" },
      },
    ],
  };
  const writes: { status: string; errorCode: string }[] = [];
  const row = {
    id: "delivery",
    channelId: channel.id,
    audienceGeneration: channel.audienceGeneration,
    groupId: channel.groupId,
    connectionKey: channel.connectionKey,
    status: "pending",
    birthdayGlobalGeneration: 2,
    event,
    channel,
  };
  const tx = {
    $queryRaw: async () => [],
    backgroundJob: { count: async () => 1 },
    notificationEvent: {
      findUniqueOrThrow: async () => event,
      update: async () => ({}),
    },
    notificationChannel: { findUnique: async () => channel },
    notificationDelivery: {
      findUnique: async () => row,
      findUniqueOrThrow: async () => row,
      createMany: async ({
        data,
      }: {
        data: { status: string; errorCode: string };
      }) => {
        writes.push(data);
      },
      update: async ({
        data,
      }: {
        data: { status: string; errorCode: string };
      }) => {
        writes.push(data);
      },
    },
  };
  const db = {
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    $queryRaw: async () => [],
    notificationEvent: { findMany: async () => [event] },
    notificationDelivery: { findMany: async () => [] },
  };
  let execute!: (job: never, signal: AbortSignal) => Promise<void>;
  const runtime = new NotificationRuntimeService(
    db as never,
    {
      register: (_kind: string, handler: typeof execute) => {
        execute = handler;
      },
    } as never,
    { enabled: true } as never,
    {
      send: () => {
        throw new Error("disabled feature sent");
      },
    } as never,
    { birthdays: { enabled: false } } as Environment,
  );
  await runtime.maintain();
  runtime.onModuleInit();
  await execute(
    { id: "job", resourceId: row.id } as never,
    new AbortController().signal,
  );
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every(
      (write) =>
        write.status === "cancelled" &&
        write.errorCode === "birthday_feature_disabled",
    ),
  );
});
