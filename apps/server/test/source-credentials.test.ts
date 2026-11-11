import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceCredentialsService } from "../src/source-ingestion/source-credentials.service.js";
import { CredentialFileError } from "../src/source-ingestion/adapters/gallery-dl/controlled-gallery-credentials.js";
import { ACCESS } from "../src/common/access.js";
import { SourceCredentialsController } from "../src/source-ingestion/source-credentials.controller.js";
import type {
  SourceCredentialChangeOperation,
  Prisma,
} from "../src/generated/prisma/client.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";
import type { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import { parseEnvironment } from "../src/config/environment.js";

const old = "a".repeat(64),
  fresh = "b".repeat(64),
  actor = "00000000-0000-4000-8000-000000000001";
const intent = {
  requestId: "00000000-0000-4000-8000-000000000002",
  expectedEpoch: 1,
  expectedGeneration: old,
  authToken: "synthetic-a",
  ct0: "synthetic-b",
};
function fixture() {
  let operation: SourceCredentialChangeOperation | null = null,
    material = false,
    promoted = false,
    failPromote = false,
    failPrepare = false,
    loseCommit = false;
  const writes: string[] = [],
    state = {
      platform: "x",
      maintenancePaused: true,
      maintenanceEpoch: 1,
      credentialGeneration: old,
      status: "unverified",
      errorCode: null,
      cooldownUntil: null,
    };
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    sourcePlatformState: { findUnique: async () => state },
    sourceCredentialChangeOperation: {
      findFirst: async ({
        where,
      }: {
        where: { id?: string; platform?: string; phase?: { in: string[] } };
      }) =>
        operation &&
        (!where.id || where.id === operation.id) &&
        (!where.platform || where.platform === operation.platform) &&
        (!where.phase?.in || where.phase.in.includes(operation.phase))
          ? operation
          : null,
      findUnique: async () => operation,
      findUniqueOrThrow: async () => {
        assert.ok(operation);
        return operation;
      },
      create: async ({
        data,
      }: {
        data: Prisma.SourceCredentialChangeOperationUncheckedCreateInput;
      }) => {
        writes.push("create");
        operation = {
          ...data,
          targetGeneration: null,
          failureCode: null,
          verificationOutcome: null,
          verificationCode: null,
          verifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        } as SourceCredentialChangeOperation;
        return operation;
      },
      update: async ({
        data,
      }: {
        data: Partial<SourceCredentialChangeOperation>;
      }) => {
        writes.push("update:" + data.phase);
        operation = {
          ...operation,
          ...data,
        } as SourceCredentialChangeOperation;
        if (loseCommit && data.phase === "activated") {
          loseCommit = false;
          throw new Error("synthetic lost commit reply");
        }
        return operation;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { phase: string | { in: string[] } };
        data: Partial<SourceCredentialChangeOperation>;
      }) => {
        assert.ok(operation);
        if (
          typeof where.phase === "string"
            ? where.phase === operation.phase
            : where.phase.in.includes(operation.phase)
        ) {
          writes.push("updateMany");
          operation = {
            ...operation,
            ...data,
          } as SourceCredentialChangeOperation;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  const check = async (
    _tx: unknown,
    _platform: string,
    expected: { expectedEpoch: number; expectedGeneration: string },
  ) => {
    assert.equal(state.maintenancePaused, true);
    if (
      state.credentialGeneration !== expected.expectedGeneration ||
      state.maintenanceEpoch !== expected.expectedEpoch
    )
      throw new Error("stale state");
    return state;
  };
  const platforms = {
    actor: async () => {},
    lockMaintenance: async () => {},
    assertMaintenance: check,
    drained: async () => true,
    fingerprint: async () => (promoted ? fresh : old),
    maintenanceStatus: async () => ({
      ...state,
      unsettledExecutions: 0,
      observedAt: new Date().toISOString(),
    }),
    activateMaintenance: async (
      tx: unknown,
      p: string,
      _a: string,
      e: { expectedEpoch: number; expectedGeneration: string },
      g: string,
    ) => {
      await check(tx, p, e);
      state.credentialGeneration = g;
    },
  };
  const files = {
    inspect: async () => ({ baselineDigest: old }),
    recover: async () => {
      if (!material) throw new CredentialFileError("material_missing");
      return { state: promoted ? "promoted" : "baseline" };
    },
    prepare: async () => {
      if (failPrepare) throw new CredentialFileError("io_failure");
      material = true;
      return {
        materialRef: "private",
        baselineDigest: old,
        targetDigest: fresh,
        inputDigest: "synthetic",
      };
    },
    promote: async () => {
      if (failPromote) throw new CredentialFileError("io_failure");
      promoted = true;
    },
  };
  const service = new SourceCredentialsService(
    db as unknown as PrismaService,
    { platforms } as unknown as SourceFetchService,
    {} as ContentSourceRegistry,
    parseEnvironment({
      DATABASE_URL: "postgresql://test:secret@localhost/test",
    }),
  );
  Object.defineProperty(service, "store", { value: files });
  return {
    service,
    state,
    writes,
    files,
    setPhase: (phase: string) => {
      assert.ok(operation);
      operation.phase = phase;
    },
    op: () => operation,
    promoted: () => promoted,
    failPromote: () => {
      failPromote = true;
    },
    failPrepare: () => {
      failPrepare = true;
    },
    loseCommit: () => {
      loseCommit = true;
    },
  };
}

test("credential update retains maintenance, supports idempotent committed replay and rejects changed intent", async () => {
  const f = fixture();
  const result = await f.service.save("x", actor, intent);
  assert.equal(result.phase, "activated");
  assert.equal(f.promoted(), true);
  assert.equal(f.state.maintenancePaused, true);
  const writes = f.writes.length;
  assert.equal((await f.service.save("x", actor, intent)).id, result.id);
  assert.equal(f.writes.length, writes);
  await assert.rejects(
    f.service.save("x", actor, { ...intent, ct0: "different" }),
    /同一更新请求/,
  );
  assert.equal("inputHash" in result, false);
});
test("failed file update stays unresolved and GET receipt never replays filesystem or database writes", async () => {
  const f = fixture();
  f.failPromote();
  await assert.rejects(f.service.save("x", actor, intent), /尚未确认/);
  assert.equal(f.op()!.phase, "blocked");
  assert.equal(f.state.credentialGeneration, old);
  assert.equal(f.state.maintenancePaused, true);
  const writes = f.writes.length;
  const receipt = await f.service.receipt("x", actor, f.op()!.id);
  assert.equal(receipt.phase, "blocked");
  assert.equal(f.writes.length, writes);
  assert.equal(f.promoted(), false);
});
test("a lost activation reply returns the existing receipt without regressing activated state", async () => {
  const f = fixture();
  f.loseCommit();
  const result = await f.service.save("x", actor, intent);
  assert.equal(result.phase, "activated");
  assert.equal(f.op()!.phase, "activated");
  assert.equal(f.state.credentialGeneration, fresh);
});
test("reconcile is bounded to the specified platform and does not accept a different maintenance epoch", async () => {
  const f = fixture();
  f.failPromote();
  await assert.rejects(f.service.save("x", actor, intent));
  await assert.rejects(
    f.service.reconcile("pixiv", actor, f.op()!.id, intent),
    /不存在/,
  );
  await assert.rejects(
    f.service.reconcile("x", actor, f.op()!.id, {
      ...intent,
      expectedEpoch: 2,
    }),
    /不一致/,
  );
});
test("all credential routes require technical administration", () => {
  for (const name of [
    "status",
    "pause",
    "resume",
    "save",
    "receipt",
    "reconcile",
    "abort",
    "verify",
  ] as const)
    assert.deepEqual(
      Reflect.getMetadata(ACCESS, SourceCredentialsController.prototype[name]),
      { permission: "system:manage" },
    );
});

test("oversized credentials fail before registering an unresolved operation", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.save("x", actor, { ...intent, authToken: "a".repeat(8193) }),
  );
  assert.equal(f.op(), null);
  assert.equal(f.writes.length, 0);
});
test("a failed preparation without material can be explicitly retired while maintenance remains paused", async () => {
  const f = fixture();
  f.failPrepare();
  await assert.rejects(f.service.save("x", actor, intent));
  assert.equal(f.op()!.phase, "preparing");
  assert.equal(f.state.maintenancePaused, true);
  const aborted = await f.service.abortUnprepared(
    "x",
    actor,
    f.op()!.id,
    intent,
  );
  assert.equal(aborted.phase, "aborted");
  assert.equal(f.state.maintenancePaused, true);
  assert.equal(f.promoted(), false);
});

test("a late missing-material result cannot regress a concurrent prepared operation", async () => {
  const f = fixture();
  f.failPrepare();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  f.files.recover = async () => {
    reads++;
    if (reads === 2) {
      entered();
      await gate;
    }
    throw new CredentialFileError("material_missing");
  };
  const save = f.service.save("x", actor, intent);
  await waiting;
  // Another replay has published material and committed its prepared phase.
  f.setPhase("prepared");
  release();
  await assert.rejects(save);
  assert.equal(f.op()!.phase, "prepared");
  assert.equal(f.promoted(), false);
});
