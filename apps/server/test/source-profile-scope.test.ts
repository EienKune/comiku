import assert from "node:assert/strict";
import test from "node:test";
import { SourcePlatformStates } from "../src/source-ingestion/source-platform-state.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";
function fixture(platform = "x") {
  const scopes: string[] = [];
  let job: Record<string, unknown> | undefined;
  let inside = false,
    reserved = false,
    busy = false,
    lostLease = false,
    generation = "fixture";
  let state = {
    platform,
    credentialGeneration: "fixture",
    status: "unverified",
    cooldownUntil: null as Date | null,
  };
  const tx = {
    $queryRaw: async () => [],
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "source" }],
      }),
    },
    backgroundJob: {
      count: async () => (busy ? 1 : 0),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        job = data;
        reserved = true;
      },
      updateMany: async () => ({ count: lostLease ? 0 : 1 }),
    },
    sourceAccountScanState: { count: async () => 0 },
    sourceAdapterState: { count: async () => 0 },
    sourcePlatformState: {
      findUnique: async () => state,
      updateMany: async ({ data }: { data: Partial<typeof state> }) => {
        state = { ...state, ...data };
        return { count: 1 };
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      inside = true;
      try {
        return await fn(tx);
      } finally {
        inside = false;
      }
    },
  };
  const args = [
    db,
    {
      lockScope: async (_tx: unknown, _lane: string, scope: string) => {
        scopes.push(scope);
      },
    },
    {},
  ] as unknown as ConstructorParameters<typeof SourcePlatformStates>;
  const states = new SourcePlatformStates(...args);
  states.fingerprint = async () => generation;
  return {
    states,
    scopes,
    job: () => job,
    state: () => state,
    inside: () => inside,
    reserved: () => reserved,
    setBusy: () => {
      busy = true;
    },
    loseLease: () => {
      lostLease = true;
    },
    rotate: () => {
      generation = "changed";
    },
  };
}
test("profile lookup reserves platform network capacity outside the transaction", async () => {
  const f = fixture();
  assert.equal(
    await f.states.profileNetwork("actor", async () => {
      assert.equal(f.inside(), false);
      assert.equal(f.reserved(), true);
      return "resolved";
    }),
    "resolved",
  );
  assert.equal(f.state().status, "healthy");
  const busy = fixture();
  busy.setBusy();
  let contacted = false;
  await assert.rejects(
    busy.states.profileNetwork("actor", async () => {
      contacted = true;
    }),
    /等待/,
  );
  assert.equal(contacted, false);
});
test("profile credential failures pause the platform while source failures preserve its gate", async () => {
  for (const scope of ["credential", "source"] as const) {
    const f = fixture();
    const failure = new SourceResponseError("authentication", {
      scope,
      reason: scope === "credential" ? "auth_failed" : "source_forbidden",
    });
    await assert.rejects(
      f.states.profileNetwork("actor", async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(
      f.state().status,
      scope === "credential" ? "auth_paused" : "unverified",
    );
    if (scope === "credential")
      await assert.rejects(
        f.states.profileNetwork("actor", async () => {}),
        /暂停/,
      );
  }
});
test("profile lease loss and credential generation changes do not certify a healthy platform", async () => {
  const lost = fixture();
  await assert.rejects(
    lost.states.profileNetwork("actor", async () => {
      lost.loseLease();
      return "resolved";
    }),
    /过期/,
  );
  assert.equal(lost.state().status, "unverified");
  const changed = fixture();
  let contacted = false,
    reads = 0;
  changed.states.fingerprint = async () =>
    ++reads === 1 ? "fixture" : "changed";
  await assert.rejects(
    changed.states.profileNetwork("actor", async () => {
      contacted = true;
    }),
  );
  assert.equal(contacted, false);
  assert.equal(changed.state().status, "unverified");
});

test("Pixiv profile reserves only its platform and records its platform payload", async () => {
  const f = fixture("pixiv");
  await f.states.profileNetwork("actor", async () => "ok", "pixiv");
  assert.equal(f.job()?.executionScope, "source:pixiv");
  assert.equal((f.job()?.payload as { platform: string }).platform, "pixiv");
  assert.deepEqual(f.scopes, ["source:pixiv", "global", "source:pixiv"]);
  assert.equal(f.state().status, "healthy");
});
test("Pixiv busy and auth pause prevent network before callback", async () => {
  const busy = fixture("pixiv");
  busy.setBusy();
  let called = false;
  await assert.rejects(
    busy.states.profileNetwork(
      "actor",
      async () => {
        called = true;
      },
      "pixiv",
    ),
    /等待/,
  );
  assert.equal(called, false);
  const paused = fixture("pixiv");
  await assert.rejects(
    paused.states.profileNetwork(
      "actor",
      async () => {
        throw new SourceResponseError("authentication", {
          scope: "credential",
          reason: "auth_failed",
        });
      },
      "pixiv",
    ),
  );
  assert.equal(paused.state().status, "auth_paused");
  await assert.rejects(
    paused.states.profileNetwork(
      "actor",
      async () => {
        called = true;
      },
      "pixiv",
    ),
    /暂停/,
  );
  assert.equal(called, false);
});
