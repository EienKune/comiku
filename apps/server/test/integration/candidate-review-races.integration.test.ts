import assert from "node:assert/strict";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import { normalizeCandidateFilter } from "../../src/candidates/candidate-query.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { setTimeout as delay } from "node:timers/promises";

/** Pause after an actual unlocked read, without adding a production test seam. */
function pauseFirstSessionRead(tx: Prisma.TransactionClient) {
  let reached!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  const delegate = new Proxy(tx.candidateReviewSession, {
    get(target, key) {
      if (key === "findUnique")
        return async (...args: unknown[]) => {
          const row = await Reflect.apply(target.findUnique, target, args);
          if (first) {
            first = false;
            reached();
            await gate;
          }
          return row;
        };
      return Reflect.get(target, key);
    },
  });
  return {
    ready,
    resume,
    tx: new Proxy(tx, {
      get(target, key) {
        return key === "candidateReviewSession"
          ? delegate
          : Reflect.get(target, key);
      },
    }),
  };
}

for (const invalidation of ["replacement", "LRU"] as const) {
  test(`a delayed touch cannot revive a session after ${invalidation}`, async () => {
    const f = await candidateReviewFixture();
    let resume = () => {};
    try {
      await f.post();
      const old = await f.create();
      await f.create();
      await f.create();
      await f.db.candidateReviewSession.update({
        where: { id: old.sessionId },
        data: { lastUsedAt: new Date(Date.now() - 6 * 60_000) },
      });
      let reached!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const read = f.db
        .$transaction(async (tx) => {
          const paused = pauseFirstSessionRead(tx);
          resume = paused.resume;
          void paused.ready.then(reached);
          return f.sessions.read(
            paused.tx,
            old.sessionId,
            f.actor.id,
            normalizeCandidateFilter(f.filter),
            f.model.modelKey,
          );
        })
        .then(
          () => ({ accepted: true }),
          (error: unknown) => ({ accepted: false, error }),
        );
      await ready;
      // Ensure the invalidation timestamp is strictly after the reader's captured time.
      await f.db.$queryRaw`SELECT 1 FROM pg_sleep(0.02)`;
      await f.create(
        invalidation === "replacement" ? old.sessionId : undefined,
      );
      resume();
      const result = await read;
      assert.equal(
        result.accepted,
        false,
        "An invalidated snapshot must not be returned or renewed",
      );
      assert.equal(
        await f.db.candidateReviewSession.count({
          where: { actorId: f.actor.id, expiresAt: { gt: new Date() } },
        }),
        3,
      );
      assert.ok(
        (
          await f.db.candidateReviewSession.findUniqueOrThrow({
            where: { id: old.sessionId },
          })
        ).expiresAt <= new Date(),
      );
    } finally {
      resume();
      await f.close();
    }
  });
}

test("natural expiry cleanup cannot leave a delayed renewed session with missing members", async () => {
  const f = await candidateReviewFixture();
  let resume = () => {};
  try {
    await f.db
      .$executeRaw`INSERT INTO candidate_posts(id, author_id, platform, external_post_id, posted_at, raw_json, updated_at) SELECT gen_random_uuid(), ${f.author.id}::uuid, 'review-race', gen_random_uuid()::text, now(), '{}'::jsonb, now() FROM generate_series(1, 2001)`;
    const old = await f.create();
    const expiresAt = new Date(Date.now() + 1000);
    await f.db.candidateReviewSession.update({
      where: { id: old.sessionId },
      data: { lastUsedAt: new Date(Date.now() - 6 * 60_000), expiresAt },
    });
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const read = f.db
      .$transaction(async (tx) => {
        const paused = pauseFirstSessionRead(tx);
        resume = paused.resume;
        void paused.ready.then(reached);
        return f.sessions.read(
          paused.tx,
          old.sessionId,
          f.actor.id,
          normalizeCandidateFilter(f.filter),
          f.model.modelKey,
        );
      })
      .then(
        () => ({ accepted: true }),
        (error: unknown) => ({ accepted: false, error }),
      );
    await ready;
    await f.db
      .$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${expiresAt}::timestamptz - clock_timestamp()))) + 0.02)`;
    const cleaned = await f.sessions.cleanup();
    assert.equal(cleaned.entries, 2000);
    assert.equal(
      await f.db.candidateReviewSessionEntry.count({
        where: { sessionId: old.sessionId },
      }),
      1,
    );
    resume();
    assert.equal(
      (await read).accepted,
      false,
      "A cleaned expired snapshot must not reopen with only one member",
    );
    assert.ok(
      (
        await f.db.candidateReviewSession.findUniqueOrThrow({
          where: { id: old.sessionId },
        })
      ).expiresAt <= new Date(),
    );
  } finally {
    resume();
    await f.close();
  }
});

test("four non-due readers share one snapshot while their page queries remain held", async () => {
  const f = await candidateReviewFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.post();
    const session = await f.create();
    let signalAll!: (count: number) => void;
    const allArrived = new Promise<number>((resolve) => {
      signalAll = resolve;
    });
    const arrived = new Set<string>();
    const groups = ["priority", "uncertain", "low_priority"] as const;
    const reads = groups.map((triageGroup) => {
      const db = new Proxy(f.db, {
        get(target, key) {
          if (key !== "$transaction") return Reflect.get(target, key);
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: unknown,
          ) =>
            target.$transaction(async (tx) => {
              const proxy = new Proxy(tx, {
                get(transaction, method) {
                  if (method !== "$queryRaw")
                    return Reflect.get(transaction, method);
                  return async (...args: unknown[]) => {
                    const result = await Reflect.apply(
                      transaction.$queryRaw,
                      transaction,
                      args,
                    );
                    const strings = args[0] as readonly string[];
                    if (
                      Array.isArray(strings) &&
                      strings.join("?").includes("SELECT c.id, e.ordinal")
                    ) {
                      arrived.add(triageGroup);
                      if (arrived.size === 3) signalAll(arrived.size);
                      await gate;
                    }
                    return result;
                  };
                },
              });
              return callback(proxy);
            }, options as never);
        },
      });
      return new CandidatesService(db, {} as never, undefined, f.analysis).list(
        { ...f.filter, reviewSessionId: session.sessionId, triageGroup },
        f.actor.id,
      );
    });
    const settled = Promise.allSettled(reads);
    const concurrent = await Promise.race([
      allArrived,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(arrived.size), 2000);
      }),
    ]);
    release();
    const results = await settled;
    assert.equal(
      concurrent,
      3,
      "All four ordinary readers must reach their page barrier without waiting for another reader to commit",
    );
    assert.ok(results.every((result) => result.status === "fulfilled"));
  } finally {
    release();
    if (timer) clearTimeout(timer);
    await f.close();
  }
});

test("a due renewal blocked by an unchanged shared row cannot cross idle expiry", async () => {
  const f = await candidateReviewFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running: Promise<unknown>[] = [];
  try {
    await f.post();
    const session = await f.create();
    const [{ deadline }] = await f.db.$queryRaw<
      { deadline: Date }[]
    >`SELECT clock_timestamp() + interval '2 seconds' AS deadline`;
    await f.db.candidateReviewSession.update({
      where: { id: session.sessionId },
      data: {
        expiresAt: deadline,
        lastUsedAt: new Date(+deadline - 8 * 60_000),
      },
    });
    let locked!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = f.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidate_review_sessions WHERE id = ${session.sessionId}::uuid FOR SHARE`;
      locked();
      await gate;
    });
    running.push(holder);
    await holderReady;
    let identify!: (pid: number) => void;
    const identified = new Promise<number>((resolve) => {
      identify = resolve;
    });
    const reader = f.db
      .$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        identify(pid);
        return f.sessions.read(
          tx,
          session.sessionId,
          f.actor.id,
          normalizeCandidateFilter(f.filter),
          f.model.modelKey,
        );
      })
      .then(
        () => ({ accepted: true }),
        (error: unknown) => ({ accepted: false, error }),
      );
    running.push(reader);
    const pid = await identified;
    let blocked = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [state] = await f.db.$queryRaw<
        { blocked: boolean; beforeDeadline: boolean }[]
      >`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked, clock_timestamp() < ${deadline}::timestamptz AS "beforeDeadline"`;
      if (state.blocked) {
        assert.equal(
          state.beforeDeadline,
          true,
          "The renewal must start its lock wait before idle expiry",
        );
        blocked = true;
        break;
      }
      await delay(20);
    }
    assert.equal(
      blocked,
      true,
      "Observe the real PostgreSQL lock wait before releasing the holder",
    );
    await f.db
      .$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${deadline}::timestamptz - clock_timestamp()))) + 0.02)`;
    release();
    await Promise.allSettled(running);
    assert.equal(
      (await reader).accepted,
      false,
      "A timestamp captured before lock wait must not revive the unchanged expired row",
    );
    assert.equal(
      +(
        await f.db.candidateReviewSession.findUniqueOrThrow({
          where: { id: session.sessionId },
        })
      ).expiresAt,
      +deadline,
    );
  } finally {
    release();
    await Promise.allSettled(running);
    await f.close();
  }
});
