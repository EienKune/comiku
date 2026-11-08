import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { CandidateAction } from "../../src/candidates/candidates.dto.js";
import type { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

type Fixture = Awaited<ReturnType<typeof candidateReviewFixture>>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** Pause real transactions at read/write boundaries; production needs no test hooks. */
function pausedImport(f: Fixture, phase: "read" | "write") {
  const reached = gate(),
    resume = gate();
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            let paused = false;
            const delegate = phase === "read" ? tx.candidatePost : tx.work;
            const method = phase === "read" ? "findUnique" : "create";
            const wrapped = new Proxy(delegate, {
              get(model, field) {
                if (field !== method) return Reflect.get(model, field);
                return async (...args: unknown[]) => {
                  if (phase === "write" && !paused) {
                    paused = true;
                    reached.release();
                    await resume.promise;
                  }
                  const value = await Reflect.apply(
                    Reflect.get(model, field),
                    model,
                    args,
                  );
                  if (phase === "read" && !paused) {
                    paused = true;
                    reached.release();
                    await resume.promise;
                  }
                  return value;
                };
              },
            });
            return run(
              new Proxy(tx, {
                get(client, field) {
                  if (field === (phase === "read" ? "candidatePost" : "work"))
                    return wrapped;
                  return Reflect.get(client, field);
                },
              }),
            );
          },
          { timeout: 15_000 },
        );
    },
  }) as PrismaService;
  return {
    service: new CandidatesService(db, {} as never),
    reached: reached.promise,
    resume: resume.release,
  };
}

async function close(f: Fixture) {
  const works = { importedById: f.actor.id };
  await f.db.candidateActionLog.deleteMany({ where: { actorId: f.actor.id } });
  await f.db.workEvent.deleteMany({ where: { work: works } });
  await f.db.work.deleteMany({ where: works });
  await f.close();
}

for (const platform of ["manual", "synthetic-review"]) {
  for (const state of ["pending", "expired", "revoked", "archived"] as const) {
    test(`${platform} import rejects an author changed to ${state} after the first read`, async () => {
      const f = await candidateReviewFixture();
      const paused = pausedImport(f, "read");
      let importing: ReturnType<CandidatesService["batch"]> | undefined;
      try {
        const post = await f.post({ platform });
        importing = paused.service.batch(f.actor.id, {
          action: CandidateAction.import,
          items: [{ id: post.id, expectedRevision: post.revision }],
        });
        await paused.reached;
        await f.db.author.update({
          where: { id: f.author.id },
          data:
            state === "archived"
              ? { deletedAt: new Date() }
              : { authorizationStatus: state },
        });
        paused.resume();
        const result = (await importing).results[0];
        assert.equal(result.outcome, "conflict");
        assert.match(result.message!, state === "archived" ? /归档/ : /授权/);
        const current = await f.db.candidatePost.findUniqueOrThrow({
          where: { id: post.id },
        });
        assert.equal(current.status, "pending");
        assert.equal(current.revision, post.revision);
        assert.equal(
          await f.db.work.count({ where: { sourceCandidatePostId: post.id } }),
          0,
        );
        assert.equal(
          await f.db.candidateActionLog.count({
            where: { candidatePostId: post.id },
          }),
          0,
        );
      } finally {
        paused.resume();
        await importing;
        await close(f);
      }
    });
  }
}

for (const mutation of ["revoked", "archived"] as const) {
  test(`author ${mutation} waits for a valid in-flight import; replay returns the existing work`, async () => {
    const f = await candidateReviewFixture();
    const paused = pausedImport(f, "write");
    let importing: ReturnType<CandidatesService["batch"]> | undefined;
    let changing: Promise<unknown> | undefined;
    try {
      const post = await f.post();
      const input = {
        action: CandidateAction.import,
        items: [{ id: post.id, expectedRevision: post.revision }],
      };
      importing = paused.service.batch(f.actor.id, input);
      await paused.reached;
      const started = gate();
      let pid = 0;
      changing = f.db.$transaction(
        async (tx) => {
          [{ pid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          started.release();
          await tx.author.update({
            where: { id: f.author.id },
            data:
              mutation === "archived"
                ? { deletedAt: new Date() }
                : { authorizationStatus: mutation },
          });
        },
        { timeout: 15_000 },
      );
      await started.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await f.db.$queryRaw<
          { blocked: boolean }[]
        >`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
        if (row.blocked) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      assert.ok(
        blocked,
        "author mutation must wait on the import's author lock",
      );
      paused.resume();
      const imported = (await importing).results[0];
      assert.equal(imported.outcome, "succeeded");
      await changing;
      const replay = (await f.service.batch(f.actor.id, input)).results[0];
      assert.equal(replay.outcome, "unchanged");
      assert.equal(replay.workId, imported.workId);
      assert.equal(
        await f.db.work.count({ where: { sourceCandidatePostId: post.id } }),
        1,
      );
    } finally {
      paused.resume();
      await importing;
      await changing;
      await close(f);
    }
  });
}

test("a concurrent author reassignment conflicts and a mixed batch preserves valid imports", async () => {
  const f = await candidateReviewFixture();
  const paused = pausedImport(f, "read");
  const other = await f.db.author.create({
    data: {
      displayName: "Synthetic revoked author",
      authorizationStatus: "revoked",
    },
  });
  let importing: ReturnType<CandidatesService["batch"]> | undefined;
  let postId: string | undefined;
  try {
    const post = await f.post();
    postId = post.id;
    importing = paused.service.batch(f.actor.id, {
      action: CandidateAction.import,
      items: [{ id: post.id, expectedRevision: post.revision }],
    });
    await paused.reached;
    await f.db.candidatePost.update({
      where: { id: post.id },
      data: { authorId: other.id, revision: { increment: 1 } },
    });
    paused.resume();
    assert.equal((await importing).results[0].outcome, "conflict");
    const valid = await f.post();
    const bad = await f.db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    const results = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [bad, valid].map(({ id, revision }) => ({
          id,
          expectedRevision: revision,
        })),
      })
    ).results;
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["conflict", "succeeded"],
    );
  } finally {
    paused.resume();
    await importing;
    if (postId)
      await f.db.candidatePost.update({
        where: { id: postId },
        data: { authorId: f.author.id },
      });
    await f.db.author.delete({ where: { id: other.id } });
    await close(f);
  }
});
