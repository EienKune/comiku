import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BirthdaySupplement,
  KIVO_SYNC_KIND,
} from "../src/birthdays/adapters/ba/birthday-supplement.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { BackgroundJob } from "../src/generated/prisma/client.js";
import { kivoProfileHash } from "../src/birthdays/adapters/ba/providers/kivo.js";

const HOUR = 3_600_000;
const profile = (id: number) => ({
  id,
  family_name_jp: "試験",
  given_name_jp: "生徒",
  family_name_cn: "合成",
  given_name_cn: "人物",
  birthday: "11-11",
  is_install: false,
  avatar: null,
  skin_list: [{ id, skin: "" }],
  character_datas: [],
});
const indexEntry = (id: number) => ({ ...profile(id), skin: "" });
const response = (data: unknown) =>
  Response.json({ success: true, code: 2000, data });
function fixture(enabled = true) {
  const now = new Date();
  const state = {
    id: "kivo",
    jobId: "fixture-job" as string | null,
    lastCheckedAt: now as Date | null,
    lastAttemptAt: null as Date | null,
    nextCheckAt: new Date(0),
    lastErrorCode: null as string | null,
    sourceCounts: { index: 2 } as Record<string, unknown>,
  };
  type Entry = {
    entryId: number;
    source: string;
    listedAt: Date;
    nextCheckAt: Date;
    profile: unknown;
    profileHash: string | null;
    lastCheckedAt: Date | null;
    personKey: string;
    status: string;
    blockedKeys: string[];
    gameEntryIds: number[];
    lastErrorCode: string | null;
  };
  const entries = new Map<number, Entry>();
  const add = (id: number, due = new Date(0)) =>
    entries.set(id, {
      source: "kivo",
      entryId: id,
      listedAt: now,
      nextCheckAt: due,
      profile: { old: true },
      profileHash: "0".repeat(64),
      lastCheckedAt: new Date(now.getTime() - 25 * HOUR),
      personKey: `kivo:${id}`,
      status: "confirmed",
      blockedKeys: ["held"],
      gameEntryIds: [90000 + id],
      lastErrorCode: null,
    });
  const settings = { displayEnabled: true, remindersEnabled: false };
  const counters = { reads: 0, transactions: 0, publishes: 0, leases: 0 };
  const order: string[] = [];
  let activeStatus = "succeeded";
  let leaseLost = false;
  let beforePublish: (() => void) | undefined;
  const enqueued: { payload: { phase: string }; executionScope: string }[] = [];
  const db = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      counters.transactions++;
      const before = structuredClone({ state, entries });
      try {
        return await fn(db);
      } catch (error) {
        Object.assign(state, before.state);
        entries.clear();
        for (const [id, entry] of before.entries) entries.set(id, entry);
        throw error;
      }
    },
    async $queryRaw() {
      order.push("state-lock");
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
        return structuredClone(state);
      },
      async findUniqueOrThrow() {
        return structuredClone(state);
      },
      async upsert() {
        return state;
      },
      async update({ data }: { data: Partial<typeof state> }) {
        Object.assign(state, data);
        return structuredClone(state);
      },
    },
    birthdayExternalEntry: {
      async findFirst() {
        return (
          [...entries.values()].sort(
            (a, b) =>
              a.nextCheckAt.getTime() - b.nextCheckAt.getTime() ||
              a.entryId - b.entryId,
          )[0] ?? null
        );
      },
      async findMany({
        where,
        take,
      }: {
        where: { nextCheckAt?: { lte: Date } };
        take?: number;
      }) {
        return [...entries.values()]
          .filter(
            (entry) =>
              !where.nextCheckAt || entry.nextCheckAt <= where.nextCheckAt.lte,
          )
          .sort(
            (a, b) =>
              a.nextCheckAt.getTime() - b.nextCheckAt.getTime() ||
              a.entryId - b.entryId,
          )
          .slice(0, take)
          .map((entry) => structuredClone(entry));
      },
      async createMany({
        data,
      }: {
        data: { entryId: number; listedAt: Date; nextCheckAt: Date }[];
      }) {
        for (const entry of data) {
          add(entry.entryId, entry.nextCheckAt);
          Object.assign(entries.get(entry.entryId)!, entry, {
            profile: null,
            profileHash: null,
            lastCheckedAt: null,
          });
        }
      },
      async updateMany({
        where,
        data,
      }: {
        where: { entryId: { in: number[] } };
        data: Partial<Entry>;
      }) {
        for (const id of where.entryId.in)
          Object.assign(entries.get(id)!, data);
      },
      async update({
        where,
        data,
      }: {
        where: { source_entryId: { entryId: number } };
        data: Partial<Entry>;
      }) {
        order.push("entry-write");
        Object.assign(entries.get(where.source_entryId.entryId)!, data);
      },
    },
    backgroundJob: {
      async findUnique() {
        return { status: activeStatus };
      },
    },
  };
  const jobs = {
    register(kind: string) {
      assert.equal(kind, KIVO_SYNC_KIND);
    },
    async lockScope(_tx: unknown, lane: string, scope: string) {
      assert.equal(lane, "network");
      assert.equal(scope, "birthdays");
    },
    async enqueue(input: (typeof enqueued)[number]) {
      enqueued.push(input);
      return { id: "new-job" };
    },
    async assertLease() {
      counters.leases++;
      order.push("lease");
      if (leaseLost) throw new Error("lease_lost");
    },
  };
  const supplement = new BirthdaySupplement(
    db as unknown as PrismaService,
    jobs as unknown as JobsService,
    enabled,
    async () => {
      counters.publishes++;
      order.push("publish");
      beforePublish?.();
    },
    async () => {
      order.push("combined-lock");
    },
  );
  const job = (phase: "index" | "profiles") =>
    ({ id: "fixture-job", payload: { phase } }) as unknown as BackgroundJob;
  return {
    supplement,
    state,
    entries,
    add,
    now,
    settings,
    counters,
    order,
    enqueued,
    job,
    setActive(value: string) {
      activeStatus = value;
    },
    loseLease() {
      leaseLost = true;
    },
    beforePublish(fn: () => void) {
      beforePublish = fn;
    },
  };
}

test("disabled or fully hidden supplement performs no acquisition; scheduling reuses active jobs", async () => {
  const disabled = fixture(false);
  assert.deepEqual(await disabled.supplement.schedule(), { queued: false });
  await disabled.supplement.synchronize(
    disabled.job("profiles"),
    new AbortController().signal,
  );
  assert.equal(disabled.counters.reads, 0);
  const f = fixture();
  f.settings.displayEnabled = false;
  assert.deepEqual(await f.supplement.schedule(), { queued: false });
  await f.supplement.synchronize(
    f.job("profiles"),
    new AbortController().signal,
  );
  assert.equal(f.enqueued.length, 0);
  f.settings.displayEnabled = true;
  f.setActive("running");
  f.state.lastCheckedAt = null;
  assert.deepEqual(await f.supplement.schedule(), { queued: false });
  f.setActive("succeeded");
  assert.deepEqual(await f.supplement.schedule(), { queued: true });
  assert.equal(f.enqueued[0]?.payload.phase, "index");
});

test("complete index adds only new IDs without renewing cached birthday facts or publishing", async (t) => {
  const f = fixture();
  f.add(1);
  f.state.lastCheckedAt = null;
  const before = structuredClone(f.entries.get(1)!);
  t.mock.method(globalThis, "fetch", async () =>
    response({ max_page: 1, students: [indexEntry(1), indexEntry(2)] }),
  );
  await f.supplement.synchronize(f.job("index"), new AbortController().signal);
  assert.equal(f.entries.size, 2);
  assert.deepEqual(f.entries.get(1)!.profile, before.profile);
  assert.equal(f.entries.get(1)!.profileHash, before.profileHash);
  assert.equal(
    f.entries.get(1)!.lastCheckedAt?.getTime(),
    before.lastCheckedAt?.getTime(),
  );
  assert.equal(f.entries.get(2)!.profile, null);
  assert.ok(f.state.lastCheckedAt! >= f.now);
  assert.equal(f.counters.publishes, 0);
  assert.ok(f.order.indexOf("lease") < f.order.indexOf("combined-lock"));
  assert.ok(f.order.indexOf("combined-lock") < f.order.indexOf("state-lock"));
  f.state.nextCheckAt = new Date(0);
  f.state.jobId = null;
  assert.deepEqual(await f.supplement.schedule(), { queued: true });
  assert.equal(f.enqueued[0]?.payload.phase, "profiles");
});

test("declining indexes retain last good details and do not starve their independent refresh", async (t) => {
  const f = fixture();
  f.add(1);
  f.state.lastCheckedAt = new Date(f.now.getTime() - 25 * HOUR);
  f.state.sourceCounts = { index: 10 };
  const before = structuredClone([...f.entries.values()]);
  t.mock.method(globalThis, "fetch", async () =>
    response({ max_page: 1, students: [indexEntry(1)] }),
  );
  await f.supplement.synchronize(f.job("index"), new AbortController().signal);
  assert.deepEqual([...f.entries.values()], before);
  assert.equal(f.state.lastErrorCode, "birthday_kivo_index_decline");
  const retryAt = Date.parse(f.state.sourceCounts.indexRetryAt as string);
  assert.ok(retryAt >= f.now.getTime() + 300_000);
  assert.ok(retryAt <= Date.now() + 300_000);
  f.state.jobId = null;
  assert.deepEqual(await f.supplement.schedule(), { queued: true });
  assert.equal(f.enqueued[0]?.payload.phase, "profiles");
});

test("profile failures preserve old facts while sibling successes publish atomically under the combined lock", async (t) => {
  const f = fixture();
  f.add(1);
  f.add(2);
  const old = structuredClone(f.entries.get(1)!);
  const indexCheckedAt = f.state.lastCheckedAt!.getTime();
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const id = Number(new URL(String(input)).pathname.split("/").at(-1));
    if (id === 1) throw new Error("private upstream secret must not escape");
    return response(profile(id));
  });
  await f.supplement.synchronize(
    f.job("profiles"),
    new AbortController().signal,
  );
  const failed = f.entries.get(1)!,
    success = f.entries.get(2)!;
  assert.deepEqual(failed.profile, old.profile);
  assert.equal(failed.profileHash, old.profileHash);
  assert.equal(failed.lastCheckedAt!.getTime(), old.lastCheckedAt!.getTime());
  assert.equal(failed.lastErrorCode, "birthday_kivo_failed");
  assert.ok(failed.nextCheckAt.getTime() >= f.now.getTime() + 300_000);
  assert.ok(failed.nextCheckAt.getTime() <= Date.now() + 300_000);
  assert.equal(success.profileHash, kivoProfileHash(success.profile as never));
  assert.equal(success.personKey, "kivo:2");
  assert.deepEqual(success.gameEntryIds, [90002]);
  assert.deepEqual(success.blockedKeys, ["held"]);
  assert.ok(success.nextCheckAt.getTime() >= f.now.getTime() + 24 * HOUR);
  assert.equal(f.state.lastCheckedAt!.getTime(), indexCheckedAt);
  assert.equal(f.counters.publishes, 1);
  assert.ok(f.order.indexOf("combined-lock") < f.order.indexOf("entry-write"));
  assert.ok(f.order.lastIndexOf("entry-write") < f.order.indexOf("publish"));
});

test("parent abort and lost ownership cannot save fetched facts or publish; publication failure rolls back the batch", async (t) => {
  const f = fixture();
  f.add(1);
  const before = structuredClone([...f.entries.values()]);
  const controller = new AbortController();
  const fetcher = t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return response(profile(1));
  });
  await assert.rejects(
    f.supplement.synchronize(f.job("profiles"), controller.signal),
  );
  assert.deepEqual([...f.entries.values()], before);
  assert.equal(f.counters.transactions, 0);
  fetcher.mock.mockImplementation(async () => response(profile(1)));
  f.loseLease();
  await assert.rejects(
    f.supplement.synchronize(f.job("profiles"), new AbortController().signal),
    /lease_lost/,
  );
  assert.deepEqual([...f.entries.values()], before);
  const other = fixture();
  other.add(1);
  const otherBefore = structuredClone([...other.entries.values()]);
  other.beforePublish(() => {
    throw new Error("synthetic publish failure");
  });
  await assert.rejects(
    other.supplement.synchronize(
      other.job("profiles"),
      new AbortController().signal,
    ),
    /publish failure/,
  );
  assert.deepEqual([...other.entries.values()], otherBefore);
  const replaced = fixture();
  replaced.add(1);
  const replacedBefore = structuredClone([...replaced.entries.values()]);
  fetcher.mock.mockImplementation(async () => {
    replaced.state.jobId = "replacement-job";
    return response(profile(1));
  });
  await assert.rejects(
    replaced.supplement.synchronize(
      replaced.job("profiles"),
      new AbortController().signal,
    ),
    /birthday_kivo_aborted/,
  );
  assert.deepEqual([...replaced.entries.values()], replacedBefore);
});

test("the internal deadline checkpoints completed profiles while leaving unstarted rows due", async (t) => {
  const f = fixture();
  f.add(1);
  f.add(2);
  f.add(3);
  const budget = new AbortController();
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) =>
    ms === 45_000 ? budget.signal : originalTimeout(ms),
  );
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const id = Number(new URL(String(input)).pathname.split("/").at(-1));
    if (id === 2) {
      await Promise.resolve();
      budget.abort();
      throw new Error("deadline reached");
    }
    return response(profile(id));
  });
  await f.supplement.synchronize(
    f.job("profiles"),
    new AbortController().signal,
  );
  assert.notEqual(f.entries.get(1)!.profileHash, "0".repeat(64));
  assert.equal(f.entries.get(2)!.lastErrorCode, "birthday_kivo_timeout");
  assert.equal(f.entries.get(3)!.nextCheckAt.getTime(), 0);
  assert.equal(f.entries.get(3)!.profileHash, "0".repeat(64));
  assert.equal(f.counters.publishes, 1);
});

test("profile batches select only twenty due rows in deterministic order", async (t) => {
  const f = fixture();
  for (let id = 22; id >= 1; id--) f.add(id);
  const calls: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const id = Number(new URL(String(input)).pathname.split("/").at(-1));
    calls.push(id);
    return response(profile(id));
  });
  await f.supplement.synchronize(
    f.job("profiles"),
    new AbortController().signal,
  );
  assert.deepEqual(
    calls,
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(f.entries.get(21)!.profileHash, "0".repeat(64));
  assert.equal(f.state.nextCheckAt.getTime(), 0);
});
