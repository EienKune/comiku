/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourcePlatformStates } from "../src/source-ingestion/source-platform-state.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";

function fixture() {
  let initialized = true;
  const cooldown = new Date(Date.now() + 600_000);
  const state: any = {
    platform: "x",
    credentialGeneration: "generation",
    maintenanceEpoch: 2,
    maintenancePaused: false,
    status: "auth_paused",
    cooldownUntil: cooldown,
    errorCode: "auth_failed",
    revision: 0,
  };
  let unsettled = 0,
    unresolved = 0,
    writes = 0;
  const jobWrites: any[] = [],
    taskWrites: any[] = [],
    scopes: string[] = [];
  const tx: any = {
    $queryRaw: async () => [{ id: "maintenance-job" }],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    backgroundJob: {
      count: async () => 0,
      updateMany: async (input: any) => {
        writes++;
        jobWrites.push(input);
        return { count: 1 };
      },
    },
    sourceAccountScanState: { count: async () => 0 },
    sourceAdapterState: { count: async () => 0 },
    sourcePlatformExecution: { count: async () => unsettled },
    sourceCredentialChangeOperation: {
      count: async ({ where }: any) =>
        where.id?.not === "same-operation" ? 0 : unresolved,
    },
    sourceFetchAccountTask: {
      updateMany: async (input: any) => {
        writes++;
        taskWrites.push(input);
        return { count: 1 };
      },
    },
    sourcePlatformState: {
      findUnique: async () => (initialized ? { ...state } : null),
      createMany: async ({ data }: any) => {
        if (initialized) return { count: 0 };
        Object.assign(state, data);
        initialized = true;
        writes++;
        return { count: 1 };
      },
      count: async () => 1,
      update: async ({ data }: any) => apply(data),
      updateMany: async ({ where, data }: any) => {
        if (
          where.credentialGeneration &&
          where.credentialGeneration !== state.credentialGeneration
        )
          return { count: 0 };
        apply(data);
        return { count: 1 };
      },
    },
  };
  function apply(data: any) {
    writes++;
    for (const [k, v] of Object.entries(data))
      state[k] =
        typeof v === "object" && v !== null && "increment" in v
          ? state[k] + (v as any).increment
          : v;
    return { ...state };
  }
  const db = { ...tx, $transaction: async (run: any) => run(tx) };
  const states = new SourcePlatformStates(
    db as never,
    {
      ownerId: "owner",
      lockScope: async (_tx: any, _lane: any, scope: string) =>
        scopes.push(scope),
    } as never,
    {} as never,
  );
  states.fingerprint = async () => state.credentialGeneration;
  return {
    states,
    tx,
    cooldown,
    state: () => state,
    writes: () => writes,
    jobWrites,
    taskWrites,
    scopes,
    setUninitialized: () => {
      initialized = false;
    },
    initialized: () => initialized,
    setUnsettled: (n: number) => {
      unsettled = n;
    },
    setUnresolved: (n: number) => {
      unresolved = n;
    },
  };
}
const expected = { expectedEpoch: 2, expectedGeneration: "generation" };

test("pause preserves credential health and cooldown while fencing stale epoch and generation", async () => {
  const f = fixture();
  const paused = await f.states.pauseMaintenance("x", "actor", expected);
  assert.equal(paused.maintenanceEpoch, 3);
  assert.equal(paused.maintenancePaused, true);
  assert.equal(f.state().status, "auth_paused");
  assert.equal(f.state().cooldownUntil, f.cooldown);
  await assert.rejects(
    f.states.pauseMaintenance("x", "actor", expected),
    /changed/,
  );
  await assert.rejects(
    f.states.pauseMaintenance("x", "actor", {
      expectedEpoch: 3,
      expectedGeneration: "old",
    }),
    /changed/,
  );
  assert.deepEqual(f.scopes.slice(0, 2), ["source:x", "global"]);
});
test("read-only status and expired-owner evidence cannot release maintenance", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  f.setUnsettled(1);
  const before = f.writes();
  const status = await f.states.maintenanceStatus("x");
  assert.equal(status.unsettledExecutions, 1);
  assert.equal(f.writes(), before);
  await assert.rejects(
    f.states.resumeMaintenance("x", "actor", { ...expected, expectedEpoch: 3 }),
    /not confirmed/,
  );
  assert.equal(f.state().maintenancePaused, true);
  assert.equal(f.jobWrites.length, 0);
});
test("resume wakes only the locked maintenance wait set and retains attempt/account/cooldown facts", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  await f.states.resumeMaintenance("x", "actor", {
    ...expected,
    expectedEpoch: 3,
  });
  assert.equal(f.state().status, "auth_paused");
  assert.equal(f.state().cooldownUntil, f.cooldown);
  assert.equal(f.jobWrites.length, 1);
  assert.deepEqual(f.jobWrites[0].where.id, { in: ["maintenance-job"] });
  assert.equal(f.jobWrites[0].where.lastError, "platform_maintenance");
  assert.deepEqual(Object.keys(f.jobWrites[0].data), ["availableAt"]);
  assert.deepEqual(f.taskWrites[0].where.jobId, { in: ["maintenance-job"] });
});
test("credential continuation excludes its own operation while resume blocks every unresolved operation", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  f.setUnresolved(1);
  await f.states.assertMaintenance(
    f.tx,
    "x",
    { ...expected, expectedEpoch: 3 },
    "actor",
    "same-operation",
  );
  await assert.rejects(
    f.states.resumeMaintenance("x", "actor", { ...expected, expectedEpoch: 3 }),
    /unresolved/,
  );
});
test("new generation activation preserves cooldown and stale outcomes cannot overwrite it", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  await f.states.activateMaintenance(
    f.tx,
    "x",
    "actor",
    { ...expected, expectedEpoch: 3 },
    "new-generation",
    "same-operation",
  );
  assert.equal(f.state().maintenancePaused, true);
  assert.equal(f.state().status, "unverified");
  assert.equal(f.state().errorCode, null);
  assert.equal(f.state().cooldownUntil, f.cooldown);
  await f.states.outcome(
    f.tx,
    "x",
    "generation",
    new SourceResponseError("authentication", {
      scope: "credential",
      reason: "auth_failed",
    }),
  );
  assert.equal(f.state().status, "unverified");
});
test("maintenance denies new admission but cannot cancel an admitted execution's next request", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  f.state().status = "unverified";
  f.state().cooldownUntil = null;
  assert.equal(
    f.states.denial(f.state(), "generation")?.reason,
    "platform_maintenance",
  );
  await f.states.beforeNetwork("x", "generation");
  f.setUnsettled(100);
  f.state().maintenancePaused = false;
  assert.equal(
    f.states.denial(f.state(), "generation"),
    null,
    "unknown owners do not block ordinary recovery",
  );
});

test("saving unchanged credential material cannot erase this generation's authentication failure", async () => {
  const f = fixture();
  await f.states.pauseMaintenance("x", "actor", expected);
  await f.states.activateMaintenance(
    f.tx,
    "x",
    "actor",
    { ...expected, expectedEpoch: 3 },
    "generation",
    "same-operation",
  );
  assert.equal(f.state().status, "auth_paused");
  assert.equal(f.state().errorCode, "auth_failed");
});

test("operator settlement requires explicit stopped-process declaration, paused generation and no live leases", async () => {
  const f = fixture(),
    owner = "00000000-0000-4000-8000-000000000001",
    generation = "a".repeat(64);
  f.state().credentialGeneration = generation;
  const queries: string[] = [];
  const values: unknown[][] = [];
  f.tx.$executeRaw = async (
    query: TemplateStringsArray,
    ...bound: unknown[]
  ) => {
    queries.push(query.join("?"));
    values.push(bound);
    return 2;
  };
  await assert.rejects(
    f.states.confirmStoppedOwner("x", owner, generation, false),
    /stopped/,
  );
  await assert.rejects(
    f.states.confirmStoppedOwner("x", owner, generation, true),
    /maintenance/,
  );
  f.state().maintenancePaused = true;
  await assert.rejects(
    f.states.confirmStoppedOwner("x", owner, "b".repeat(64), true),
    /changed/,
  );
  f.tx.backgroundJob.count = async () => 1;
  await assert.rejects(
    f.states.confirmStoppedOwner("x", owner, generation, true),
    /lease/,
  );
  f.tx.backgroundJob.count = async () => 0;
  const result = await f.states.confirmStoppedOwner(
    "x",
    owner,
    generation,
    true,
  );
  assert.equal(result.settledCount, 2);
  assert.equal(result.code, "operator_confirmed_stopped");
  assert.equal(f.jobWrites.length, 0);
  assert.equal(f.taskWrites.length, 0);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /operator_confirmed_stopped/);
  assert.match(queries[0], /owner_id/);
  assert.ok(values[0].includes(owner));
  assert.ok(values[0].includes(generation));
  assert.doesNotMatch(
    queries[0],
    /UPDATE\s+(?:background_jobs|source_fetch_account_tasks)|SET\s+business_outcome/i,
  );
});

for (const actual of ["drifted-generation", null])
  test(`resume rejects ${actual === null ? "unavailable" : "changed"} local credential material without waking work`, async () => {
    const f = fixture();
    await f.states.pauseMaintenance("x", "actor", expected);
    const before = structuredClone(f.state()),
      writes = f.writes();
    f.states.fingerprint = async () => actual;
    await assert.rejects(
      f.states.resumeMaintenance("x", "actor", {
        ...expected,
        expectedEpoch: 3,
      }),
      /configuration changed or unavailable/,
    );
    assert.deepEqual(f.state(), before);
    assert.equal(f.writes(), writes);
    assert.equal(f.jobWrites.length, 0);
    assert.equal(f.taskWrites.length, 0);
  });

test("first-use status reads a local generation without writes and pause initializes only an empty matching platform", async () => {
  const f = fixture();
  f.setUninitialized();
  const status = await f.states.maintenanceStatus("x");
  assert.equal(status.credentialGeneration, "generation");
  assert.equal(status.maintenanceEpoch, 0);
  assert.equal(f.writes(), 0);
  assert.equal(f.initialized(), false);
  const paused = await f.states.pauseMaintenance("x", "actor", {
    ...expected,
    expectedEpoch: 0,
  });
  assert.equal(paused.maintenancePaused, true);
  assert.equal(paused.maintenanceEpoch, 1);
  assert.equal(f.state().credentialGeneration, "generation");
});
for (const obstacle of ["drift", "unreadable", "execution", "lease"] as const)
  test(`first-use pause refuses ${obstacle} without initializing platform state`, async () => {
    const f = fixture();
    f.setUninitialized();
    if (obstacle === "drift") f.states.fingerprint = async () => "changed";
    if (obstacle === "unreadable") f.states.fingerprint = async () => null;
    if (obstacle === "execution") f.setUnsettled(1);
    if (obstacle === "lease") f.tx.sourceAccountScanState.count = async () => 1;
    await assert.rejects(
      f.states.pauseMaintenance("x", "actor", {
        ...expected,
        expectedEpoch: 0,
      }),
    );
    assert.equal(f.initialized(), false);
    assert.equal(f.writes(), 0);
  });
