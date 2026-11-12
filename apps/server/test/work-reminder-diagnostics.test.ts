import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { WorkRemindersService } from "../src/work-reminders/work-reminders.service.js";
import { WorkReminderProjection } from "../src/work-reminders/work-reminder-projection.js";
import { NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES } from "../src/notifications/notification-message-segments.js";

test("local digest capacity logs scalar context without private message, contacts or consuming the slot", async (t) => {
  const now = new Date("2026-11-12T01:01:00.000Z");
  const before = new Date(now.getTime() - 86_400_000);
  const privacyCanary = "PRIVATE_DIGEST_CONTENT_CANARY";
  const qq = "98765432100123456789";
  const channel = {
    id: "channel-id",
    enabled: true,
    name: privacyCanary,
    groupId: qq,
    sourceAcceptAfter: before,
  };
  const scope = {
    channelId: channel.id,
    digestEnabled: false,
    readyEnabled: false,
    overdueEnabled: true,
    mentionsEnabled: true,
    generation: 1,
    acceptAfter: before,
  };
  const settings = {
    enabled: true,
    generation: 1,
    sendTimes: ["09:00", "18:00"],
    acceptAfter: before,
    note: privacyCanary,
  };
  const items = Array.from({ length: 2000 }, (_, index) => ({
    participantId: `participant-${index}`,
    round: 1,
    userId: "user-id",
    workId: "work-id",
    workNumber: index + 1,
    title: privacyCanary + "私有标题".repeat(20),
    displayName: privacyCanary,
    stage: "translate" as const,
    kind: "overdue" as const,
    qqNumber: qq,
    userRevision: 0,
    sourceKey: "a".repeat(64),
    evidenceKey: "b".repeat(64),
    state: "ready" as const,
    eligible: true,
    waiting: false,
    completed: false,
    ended: false,
    eligibleMilliseconds: 259_200_000,
  }));
  t.mock.method(WorkReminderProjection.prototype, "maintain", async () => ({
    processed: 0,
    acquired: true,
  }));
  t.mock.method(WorkReminderProjection.prototype, "readItems", async () => ({
    items,
    readyCount: 0,
    overdueCount: items.length,
  }));
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const noRegistration = () => {
    throw new Error("an oversized digest must not consume its slot or notices");
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    workReminderClock: {
      findUniqueOrThrow: async () => ({ lastObservedAt: now }),
    },
    workReminderSettings: { findUnique: async () => settings },
    workReminderSubscription: { findUnique: async () => scope },
    notificationChannel: { findUniqueOrThrow: async () => channel },
    workDigestOccurrence: {
      findUnique: async () => null,
      create: noRegistration,
    },
    notificationEvent: { create: noRegistration },
    workReminderNotice: { createMany: noRegistration },
  };
  const db = {
    $executeRaw: async () => 1,
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    workReminderSettings: { findUnique: async () => settings },
    workReminderSubscription: { findMany: async () => [scope] },
  };
  await new WorkRemindersService(
    db as never,
    { enabled: true } as never,
    { appOrigin: `https://${privacyCanary}.example` } as never,
  ).maintain(now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].length, 1);
  const warning = String(warnings[0][0]);
  const logged = JSON.parse(warning);
  assert.deepEqual(logged, {
    scope: "work-reminders",
    event: "digest_capacity_exceeded",
    errorCode: "work_reminder_payload_too_large",
    channelId: channel.id,
    localDate: "2026-11-12",
    slot: "09:00",
    itemCount: items.length,
    mentionCount: 1,
    textCodeUnits: logged.textCodeUnits,
    limitBytes: NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES,
  });
  assert.ok(Number.isSafeInteger(logged.textCodeUnits));
  assert.ok(logged.textCodeUnits > 1000);
  assert.doesNotMatch(warning, /PRIVATE_DIGEST|98765432100123456789/);
  assert.doesNotMatch(warning, /title|displayName|groupId|qq|https/i);
});
