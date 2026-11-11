import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BirthdaysService,
  nextBirthdaySync,
  readBirthdayPeople,
} from "../src/birthdays/birthdays.service.js";
import { parseEnvironment } from "../src/config/environment.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { BackgroundJob } from "../src/generated/prisma/client.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type {
  BirthdayIdentity,
  BirthdayPerson,
} from "../src/birthdays/providers/schaledb.js";

const now = new Date("2026-11-11T00:00:00Z");
const person: BirthdayPerson = {
  key: "schaledb:90000",
  name: "旧中文名",
  aliases: ["JP90000"],
  month: 11,
  day: 11,
  originalEntryId: null,
  entryIds: [90000],
  notificationEligible: true,
};
const job = {
  id: "fixture-job",
  leaseId: "fixture-lease",
  status: "running",
} as BackgroundJob;

function fixture(enabled = true) {
  type Catalog = {
    id: string;
    contentHash: string;
    people: BirthdayPerson[];
    sourceCounts: { jp: number; cn: number };
    createdAt: Date;
  };
  const catalog: Catalog = {
    id: "previous-catalog",
    contentHash: "0".repeat(64),
    people: structuredClone([person]),
    sourceCounts: { jp: 1, cn: 1 },
    createdAt: now,
  };
  const state = {
    id: "schaledb",
    catalogId: catalog.id,
    catalog: catalog as Catalog | null,
    jobId: job.id as string | null,
    lastCheckedAt: now as Date | null,
    lastAttemptAt: null as Date | null,
    nextCheckAt: new Date(0),
    lastErrorCode: null as string | null,
    sourceCounts: { jp: 1, cn: 1 },
  };
  const settings = { displayEnabled: true, remindersEnabled: false };
  const identities: BirthdayIdentity[] = [
    {
      entryId: 90000,
      personKey: person.key,
      originalEntryId: null,
      status: "confirmed",
    },
  ];
  const catalogs = new Map([[catalog.contentHash, catalog]]);
  const overrides: { personKey: string; name: string; aliases: string[] }[] =
    [];
  const counters = {
    transactions: 0,
    leases: 0,
    locks: 0,
    enqueued: 0,
    reads: 0,
  };
  let loseLeaseAt = Infinity;
  let beforePublish: (() => void) | undefined;
  const db = {
    async $transaction<T>(action: (tx: unknown) => Promise<T>): Promise<T> {
      counters.transactions++;
      return action(db);
    },
    async $queryRaw() {
      return [];
    },
    birthdaySettings: {
      async findUnique() {
        counters.reads++;
        return settings;
      },
    },
    birthdaySyncState: {
      async findUnique() {
        counters.reads++;
        return { ...state };
      },
      async findUniqueOrThrow() {
        counters.reads++;
        return { ...state };
      },
      async upsert() {
        return state;
      },
      async update({ data }: { data: Partial<typeof state> }) {
        Object.assign(state, data);
        if (data.catalogId)
          state.catalog = [...catalogs.values()].find(
            (c) => c.id === data.catalogId,
          )!;
        return state;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { jobId: string };
        data: Partial<typeof state>;
      }) {
        if (where.jobId !== state.jobId) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
    backgroundJob: {
      async findUnique() {
        return { ...job, status: "running" };
      },
    },
    birthdayIdentity: {
      async findMany() {
        return structuredClone(identities);
      },
      async createMany({ data }: { data: BirthdayIdentity[] }) {
        identities.push(...structuredClone(data));
      },
      async update({
        where,
        data,
      }: {
        where: { entryId: number };
        data: BirthdayIdentity;
      }) {
        Object.assign(
          identities.find((i) => i.entryId === where.entryId)!,
          data,
        );
      },
    },
    birthdayNameOverride: {
      async findMany() {
        return overrides;
      },
    },
    birthdayExternalEntry: {
      async findMany() {
        return [];
      },
    },
    birthdayCatalog: {
      async upsert({ create }: { create: Omit<Catalog, "id" | "createdAt"> }) {
        if (!catalogs.has(create.contentHash))
          catalogs.set(create.contentHash, {
            ...structuredClone(create),
            id: `catalog-${catalogs.size}`,
            createdAt: new Date(),
          });
        return catalogs.get(create.contentHash)!;
      },
    },
  };
  const jobs = {
    register() {},
    async lockScope() {
      counters.locks++;
    },
    async enqueue() {
      counters.enqueued++;
      return { id: "new-job" };
    },
    async assertLease() {
      counters.leases++;
      if (counters.leases >= loseLeaseAt) throw new Error("lease_lost");
      if (counters.leases === 2) beforePublish?.();
    },
  };
  const service = new BirthdaysService(
    db as unknown as PrismaService,
    jobs as unknown as JobsService,
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL:
        "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_test",
      BIRTHDAYS_ENABLED: String(enabled),
    }),
  );
  return {
    service,
    db,
    state,
    settings,
    identities,
    catalogs,
    overrides,
    counters,
    loseLeaseAt(value: number) {
      loseLeaseAt = value;
    },
    beforePublish(action: () => void) {
      beforePublish = action;
    },
  };
}

function syntheticFetch(secondBirthday = "11/11"): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/data/config.min.json")
      return Response.json({ Regions: [{ Name: "Jp" }] });
    if (path === "/data/jp/students.min.json")
      return Response.json(
        Object.fromEntries(
          [90000, 90001].map((id) => [
            id,
            {
              Id: id,
              Name: `JP${id}`,
              FamilyName: "姓",
              PersonalName: `JP${id}`,
              IsReleased: [true],
              FavorAlts: [90000],
              BirthDay: id === 90000 ? "11/11" : secondBirthday,
            },
          ]),
        ),
      );
    if (path === "/data/cn/students.min.json")
      return Response.json({
        90000: {
          Id: 90000,
          Name: "甲",
          FamilyName: "中文",
          PersonalName: "甲",
        },
        90001: {
          Id: 90001,
          Name: "乙",
          FamilyName: "中文",
          PersonalName: "乙",
        },
      });
    throw new Error("unexpected synthetic request");
  };
}

test("disabled birthday feature performs no database, queue or network work", async (t) => {
  const f = fixture(false);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  assert.deepEqual(await f.service.schedule(), { queued: false });
  assert.equal((await f.service.calendar(now)).enabled, false);
  assert.equal((await f.service.catalogStatus()).available, false);
  await f.service.synchronize(job, new AbortController().signal);
  await assert.rejects(f.service.schedule("admin"));
  assert.deepEqual(f.counters, {
    transactions: 0,
    leases: 0,
    locks: 0,
    enqueued: 0,
    reads: 0,
  });
});

test("an existing queued/running synchronization job is reused without enqueueing", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.schedule(undefined, now), { queued: false });
  assert.equal(f.counters.enqueued, 0);
  assert.equal(f.state.jobId, job.id);
  assert.equal(f.counters.locks, 1);
});

test("automatic synchronization honors disabled settings and future due time", async () => {
  const disabled = fixture();
  disabled.settings.displayEnabled = false;
  assert.deepEqual(await disabled.service.schedule(undefined, now), {
    queued: false,
  });
  assert.equal(disabled.counters.enqueued, 0);
  const future = fixture();
  future.state.jobId = null;
  future.state.nextCheckAt = new Date(now.getTime() + 1);
  assert.deepEqual(await future.service.schedule(undefined, now), {
    queued: false,
  });
  assert.equal(future.counters.enqueued, 0);
  const due = fixture();
  due.state.jobId = null;
  assert.deepEqual(await due.service.schedule(undefined, now), {
    queued: true,
  });
  assert.equal(due.state.jobId, "new-job");
  assert.equal(due.state.nextCheckAt.getTime(), now.getTime() + 300_000);
});

test("display disabling hides a stored catalog without requiring its contents to parse", async () => {
  const f = fixture();
  f.settings.displayEnabled = false;
  f.state.catalog!.people = [{} as BirthdayPerson];
  assert.equal((await f.service.calendar(now)).enabled, false);
});

test("turning both settings off after enqueue avoids network while explicit manual refresh remains allowed", async (t) => {
  const f = fixture();
  f.settings.displayEnabled = false;
  const request = t.mock.method(globalThis, "fetch", syntheticFetch());
  await f.service.synchronize(job, new AbortController().signal);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(f.counters.leases, 0);
  await f.service.synchronize(
    { ...job, payload: { manual: true } },
    new AbortController().signal,
  );
  assert.equal(request.mock.callCount(), 3);
  assert.notEqual(f.state.catalogId, "previous-catalog");
});

test("stale job and initial lease loss cannot reach the source or replace the catalog", async (t) => {
  const request = t.mock.method(globalThis, "fetch", syntheticFetch());
  const stale = fixture();
  stale.state.jobId = "replacement";
  await stale.service.synchronize(job, new AbortController().signal);
  assert.equal(stale.counters.leases, 0);
  const lost = fixture();
  lost.loseLeaseAt(1);
  await assert.rejects(
    lost.service.synchronize(job, new AbortController().signal),
    /lease_lost/,
  );
  assert.equal(request.mock.callCount(), 0);
  assert.equal(lost.state.catalogId, "previous-catalog");
});

test("source failure retains the last successful immutable catalog and records only a bounded error", async (t) => {
  const f = fixture();
  const before = structuredClone(f.state.catalog);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("sensitive upstream URL and body");
  });
  const log = t.mock.method(console, "error", () => {});
  const beforeFailure = Date.now();
  await assert.rejects(
    f.service.synchronize(job, new AbortController().signal),
    /^Error: birthday_source_failed$/,
  );
  assert.deepEqual(f.state.catalog, before);
  assert.equal(f.state.lastCheckedAt, now);
  assert.equal(f.state.lastErrorCode, "birthday_source_failed");
  assert.ok(f.state.nextCheckAt.getTime() >= beforeFailure + 300_000);
  assert.ok(f.state.nextCheckAt.getTime() <= Date.now() + 300_000);
  assert.equal(f.catalogs.size, 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /sensitive upstream/);
});

test("successful synchronization preserves old catalogs, persists pending identities and reuses unchanged content", async (t) => {
  const f = fixture();
  const previous = structuredClone(f.state.catalog);
  t.mock.method(globalThis, "fetch", syntheticFetch("11/12"));
  await f.service.synchronize(job, new AbortController().signal);
  assert.notEqual(f.state.catalogId, "previous-catalog");
  assert.deepEqual(f.catalogs.get("0".repeat(64)), previous);
  assert.equal(f.state.catalog!.people[0].key, person.key);
  assert.equal(f.state.catalog!.people[0].name, "中文甲");
  assert.equal(
    f.identities.find((i) => i.entryId === 90001)?.status,
    "pending",
  );
  const acceptedId = f.state.catalogId;
  await f.service.synchronize(job, new AbortController().signal);
  assert.equal(f.state.catalogId, acceptedId);
  assert.equal(f.catalogs.size, 2);
  assert.equal(
    f.identities.find((i) => i.entryId === 90001)?.status,
    "pending",
  );
});

test("lease loss at publication fences catalog and identity writes", async (t) => {
  const f = fixture();
  f.loseLeaseAt(2);
  t.mock.method(globalThis, "fetch", syntheticFetch());
  await assert.rejects(
    f.service.synchronize(job, new AbortController().signal),
    /lease_lost/,
  );
  assert.equal(f.state.catalogId, "previous-catalog");
  assert.equal(f.catalogs.size, 1);
  assert.equal(f.identities.length, 1);
});

test("unchanged Chinese overrides produce one stable catalog across repeated synchronization", async (t) => {
  const f = fixture();
  f.overrides.push({
    personKey: person.key,
    name: "人工审定名",
    aliases: ["团队别名"],
  });
  t.mock.method(globalThis, "fetch", syntheticFetch());
  await f.service.synchronize(job, new AbortController().signal);
  const catalogId = f.state.catalogId;
  await f.service.synchronize(job, new AbortController().signal);
  assert.equal(f.state.catalogId, catalogId);
  assert.equal(f.state.catalog!.people[0].name, "人工审定名");
  assert.ok(!f.state.catalog!.people[0].aliases.includes("人工审定名"));
});

test("replaced source job is fenced after fetching and cannot record errors against the replacement", async (t) => {
  const f = fixture();
  f.beforePublish(() => {
    f.state.jobId = "replacement";
  });
  t.mock.method(globalThis, "fetch", syntheticFetch());
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    f.service.synchronize(job, new AbortController().signal),
    /birthday_sync_failed/,
  );
  assert.equal(f.state.catalogId, "previous-catalog");
  assert.equal(f.state.lastErrorCode, null);
  assert.equal(f.identities.length, 1);
});

test("daily scheduling uses the next strict Shanghai 06:00 boundary", () => {
  assert.equal(
    nextBirthdaySync(new Date("2026-11-10T21:59:59Z")).toISOString(),
    "2026-11-10T22:00:00.000Z",
  );
  assert.equal(
    nextBirthdaySync(new Date("2026-11-10T22:00:00Z")).toISOString(),
    "2026-11-11T22:00:00.000Z",
  );
});

test("an unknown persisted identity status retains the valid catalog and cannot request source data", async (t) => {
  const f = fixture();
  f.identities[0].status = "unexpected" as BirthdayIdentity["status"];
  const before = structuredClone(f.state.catalog);
  const fetch = t.mock.method(globalThis, "fetch", syntheticFetch());
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    f.service.synchronize(job, new AbortController().signal),
    /birthday_invalid_persisted_identity/,
  );
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(f.state.catalog, before);
  assert.equal(f.state.lastErrorCode, "birthday_invalid_persisted_identity");
});

test("persisted catalogs reject impossible dates, duplicate person keys and foreign original avatars", () => {
  assert.throws(
    () => readBirthdayPeople([{ ...person, month: 2, day: 30 }]),
    /invalid_catalog/,
  );
  assert.throws(() => readBirthdayPeople([person, person]), /invalid_catalog/);
  assert.throws(
    () => readBirthdayPeople([{ ...person, originalEntryId: 99999 }]),
    /invalid_catalog/,
  );
  for (const unsafe of ["\n", "\u202e", "\u2028", "\u200f"]) {
    assert.throws(
      () => readBirthdayPeople([{ ...person, name: `甲${unsafe}乙` }]),
      /invalid_catalog/,
    );
    assert.throws(
      () => readBirthdayPeople([{ ...person, aliases: [`甲${unsafe}乙`] }]),
      /invalid_catalog/,
    );
  }
  assert.deepEqual(
    readBirthdayPeople([{ ...person, month: 2, day: 29 }])[0].day,
    29,
  );
});
