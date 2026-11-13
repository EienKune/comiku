import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { BirthdayDataAdapter } from "../src/birthdays/birthday-data.adapter.js";
import { BirthdaysService } from "../src/birthdays/birthdays.service.js";
import { BirthdayReminderService } from "../src/birthdays/birthday-reminder.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";

const now = new Date("2026-11-12T01:00:00Z");
const person = {
  key: "other-game:alice",
  name: "合成人物",
  aliases: ["Alice"],
  month: 11,
  day: 12,
  avatarUrl: null,
};

/** Test-only implementation: no BA IDs, providers, freshness policy or source tables. */
class SyntheticAdapter extends BirthdayDataAdapter {
  enabled = true;
  readonly namespace = "synthetic";
  reads = 0;
  scheduled = 0;
  async catalog() {
    this.reads++;
    return {
      people: [{ ...person, privateSourceField: "PRIVATE" }],
      updatedAt: now,
      lastCheckedAt: now,
    };
  }
  async schedule() {
    this.scheduled++;
    return { queued: true };
  }
  async scheduleSupplement() {
    this.scheduled++;
  }
  async cleanupCatalogs() {
    this.scheduled++;
  }
  async reminderPublication() {
    this.reads++;
    return {
      catalogId: "00000000-0000-4000-8000-000000000001",
      catalogVersion: "0".repeat(64),
      checkedAt: now,
      validBefore: new Date("2026-11-13T01:00:00Z"),
      people: [{ key: person.key, name: person.name, month: 11, day: 12 }],
    };
  }
}

test("replacing only the adapter supports string identities and keeps public projections explicit", async () => {
  const adapter = new SyntheticAdapter();
  let displayEnabled = true;
  const db = {
    birthdaySettings: { findUnique: async () => ({ displayEnabled }) },
  };
  const service = new BirthdaysService(db as unknown as PrismaService, adapter);
  const calendar = await service.calendar(now);
  assert.equal(calendar.enabled, true);
  assert.equal(calendar.people[0]?.key, person.key);
  assert.equal(calendar.people[0]?.daysUntil, 0);
  assert.equal(calendar.people[0]?.avatarUrl, null);
  assert.ok(!JSON.stringify(calendar).includes("PRIVATE"));
  assert.equal((await service.catalogStatus()).personCount, 1);
  displayEnabled = false;
  const before = adapter.reads;
  assert.equal((await service.calendar(now)).enabled, false);
  assert.equal(adapter.reads, before);
  assert.equal((await service.schedule()).queued, true);
});

test("disabled adapter performs no catalog, reminder, scheduling or cleanup work", async () => {
  const adapter = new SyntheticAdapter();
  adapter.enabled = false;
  const service = new BirthdaysService({} as PrismaService, adapter);
  assert.equal((await service.calendar(now)).enabled, false);
  assert.equal((await service.catalogStatus()).available, false);
  assert.equal((await service.schedule()).queued, false);
  assert.throws(() => service.schedule("admin"), /尚未启用/);
  await service.scheduleSupplement();
  await service.cleanupCatalogs();
  const reminders = new BirthdayReminderService(
    {} as PrismaService,
    { enabled: true } as NotificationConnectionRegistry,
    adapter,
  );
  await reminders.maintain(now);
  assert.equal(adapter.reads, 0);
  assert.equal(adapter.scheduled, 0);
});

test("generic reminder freezes another dataset without reading BA source tables and deduplicates its namespace", async () => {
  const adapter = new SyntheticAdapter();
  const settings = {
    remindersEnabled: true,
    sendTime: "09:00",
    offsetDays: [0],
    reminderGeneration: 1,
    reminderAcceptAfter: new Date(0),
    templateNote: "",
    templateRevision: 0,
    offsetStates: {
      "0": { generation: 1, acceptAfter: new Date(0).toISOString() },
    },
  };
  const scope = {
    channelId: "channel",
    enabled: true,
    audienceGeneration: 1,
    acceptAfter: new Date(0),
  };
  const channel = {
    id: "channel",
    enabled: true,
    sourceAcceptAfter: new Date(0),
    audienceGeneration: 1,
    revision: 0,
    groupId: "12345",
    connectionKey: "test",
    connectionFingerprint: "0".repeat(64),
  };
  let occurrence: unknown = null;
  const events: {
    eventKey: string;
    snapshot: { people: unknown[] };
    routeRefs: unknown[];
  }[] = [];
  const db = {
    $transaction: async (run: (tx: unknown) => Promise<void>) => run(db),
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    birthdaySettings: { findUnique: async () => settings },
    birthdayChannelSubscription: {
      count: async () => 1,
      findMany: async () => [scope],
      findUniqueOrThrow: async () => scope,
    },
    notificationChannel: { findUniqueOrThrow: async () => channel },
    birthdayReminderOccurrence: {
      findUnique: async () => occurrence,
      create: async ({ data }: { data: unknown }) => {
        occurrence = data;
      },
      update: async () => {},
    },
    notificationEvent: {
      create: async ({ data }: { data: (typeof events)[number] }) => {
        events.push(data);
        return { id: "event" };
      },
    },
  };
  const reminders = new BirthdayReminderService(
    db as unknown as PrismaService,
    { enabled: true } as NotificationConnectionRegistry,
    adapter,
  );
  await reminders.maintain(now);
  await reminders.maintain(now);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventKey, "birthday:synthetic:2026-11-12:0");
  assert.deepEqual(events[0]!.snapshot.people, [
    { key: person.key, name: person.name, month: 11, day: 12 },
  ]);
  assert.equal(events[0]!.routeRefs.length, 1);
});
