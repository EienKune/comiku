import assert from "node:assert/strict";
import test from "node:test";
import { SourcePlatformStates } from "../src/source-ingestion/source-platform-state.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";
function fixture(platform = "x") {
  const scopes: string[] = [];
  const renewals: Array<{
    where: { leaseUntil?: { gt: Date } };
    data: { leaseUntil?: Date };
  }> = [];
  let job: Record<string, unknown> | undefined;
  let inside = false,
    reserved = false,
    busy = false,
    postBusy = false,
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
      count: async ({ where }: { where: { kind?: unknown; OR?: unknown } }) =>
        busy || (postBusy && !where.kind && !where.OR) ? 1 : 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        job = data;
        reserved = true;
      },
      updateMany: async (input: {
        where: { leaseUntil?: { gt: Date } };
        data: { leaseUntil?: Date };
      }) => {
        if (input.data.leaseUntil) renewals.push(input);
        if (
          lostLease ||
          (input.where.leaseUntil &&
            job?.leaseUntil instanceof Date &&
            job.leaseUntil <= input.where.leaseUntil.gt)
        )
          return { count: 0 };
        if (input.data.leaseUntil)
          job = { ...job, leaseUntil: input.data.leaseUntil };
        return { count: 1 };
      },
    },
    sourceAccountScanState: { count: async () => (postBusy ? 1 : 0) },
    sourceAdapterState: { count: async () => (postBusy ? 1 : 0) },
    sourcePlatformExecution: {
      create: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
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
    renewals,
    tx,
    job: () => job,
    state: () => state,
    inside: () => inside,
    reserved: () => reserved,
    setBusy: () => {
      busy = true;
    },
    setPostBusy: () => {
      postBusy = true;
    },
    setGate: (status: string, cooldownUntil: Date | null = null) => {
      state = { ...state, status, cooldownUntil };
    },
    loseLease: () => {
      lostLease = true;
    },
    rotate: () => {
      generation = "changed";
    },
  };
}

for (const platform of ["x", "pixiv"] as const)
  test(`${platform} profile can resolve while its post and account leases are active`, async () => {
    const f = fixture(platform);
    f.setPostBusy();
    assert.equal(
      await f.states.profileNetwork("actor", async () => "resolved", platform),
      "resolved",
    );
    assert.equal(f.state().status, "healthy");
  });

test("a successful profile cannot clear a concurrent authentication pause or active cooldown", async () => {
  for (const status of ["auth_paused", "cooling_down"]) {
    const f = fixture();
    const until = new Date(Date.now() + 60_000);
    await f.states.profileNetwork("actor", async () => {
      f.setGate(status, until);
      return "resolved";
    });
    assert.equal(f.state().status, status);
    assert.equal(f.state().cooldownUntil, until);
  }
});

test("authentication and rate failures preserve both the stronger pause and longest cooldown", async () => {
  for (const status of ["auth_paused", "cooling_down"]) {
    const f = fixture();
    const until = new Date(Date.now() + 120_000);
    const failure = new SourceResponseError("authentication", {
      scope: "credential",
      reason: status === "auth_paused" ? "rate_limited" : "auth_failed",
      diagnostic: { http_response_headers: { "retry-after": "5" } },
    });
    await assert.rejects(
      f.states.profileNetwork("actor", async () => {
        f.setGate(status, until);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(f.state().status, "auth_paused");
    assert.equal(f.state().cooldownUntil, until);
  }
});
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
    /资料同步正在运行/,
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
    /资料同步正在运行/,
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

const flushHeartbeat = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
test("a live 63-second profile plus avatar renews its lease and clears the heartbeat on completion", async (t) => {
  const start = new Date("2026-11-11T00:00:00Z"),
    f = fixture();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
  try {
    const result = await f.states.profileNetwork("actor", async () => {
      for (let n = 0; n < 4; n++) {
        t.mock.timers.tick(15_000);
        await flushHeartbeat();
      }
      t.mock.timers.tick(3_000);
      await flushHeartbeat();
      return "verified profile and avatar";
    });
    assert.equal(result, "verified profile and avatar");
    assert.ok(f.renewals.length > 0);
    for (const update of f.renewals)
      assert.ok(update.where.leaseUntil?.gt instanceof Date);
    const before = f.renewals.length;
    t.mock.timers.tick(120_000);
    await flushHeartbeat();
    assert.equal(f.renewals.length, before);
  } finally {
    t.mock.timers.reset();
  }
});
test("a profile heartbeat cannot resurrect an expired lease and cannot renew forever", async (t) => {
  const start = new Date("2026-11-11T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
  try {
    const expired = fixture();
    await assert.rejects(
      expired.states.profileNetwork("actor", async () => {
        t.mock.timers.tick(61_000);
        await flushHeartbeat();
        return "late";
      }),
      /过期/,
    );
    assert.equal(
      (expired.job()?.leaseUntil as Date).getTime(),
      start.getTime() + 60_000,
    );
    const bounded = fixture(),
      admitted = Date.now();
    await assert.rejects(
      bounded.states.profileNetwork("actor", async () => {
        for (let n = 0; n < 9; n++) {
          t.mock.timers.tick(15_000);
          await flushHeartbeat();
        }
        return "stalled";
      }),
      /过期/,
    );
    assert.ok(bounded.renewals.length > 0);
    assert.ok(
      bounded.renewals.every(
        (update) => update.data.leaseUntil!.getTime() <= admitted + 120_000,
      ),
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("a profile heartbeat samples expiry after waiting for its job row lock", async (t) => {
  const start = new Date("2026-11-11T00:00:00Z"),
    f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  f.tx.$queryRaw = async (...args: unknown[]) => {
    const query = (args[0] as TemplateStringsArray).join("?");
    if (query.includes("FROM background_jobs")) {
      entered = true;
      await blocked;
    }
    return [];
  };
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
  try {
    await assert.rejects(
      f.states.profileNetwork("actor", async () => {
        t.mock.timers.tick(15_000);
        await flushHeartbeat();
        assert.equal(entered, true);
        t.mock.timers.tick(46_000);
        release();
        await flushHeartbeat();
        return "late after lock wait";
      }),
      /过期/,
    );
    assert.equal(
      (f.job()?.leaseUntil as Date).getTime(),
      start.getTime() + 60_000,
    );
  } finally {
    release();
    t.mock.timers.reset();
  }
});
