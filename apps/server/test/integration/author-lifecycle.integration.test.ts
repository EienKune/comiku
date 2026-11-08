import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuthorsService } from "../../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
for (const operation of ["create", "restore"] as const)
  test(`author archive serializes with account ${operation}`, async () => {
    const f = await candidateReviewFixture();
    const service = new AuthorsService(
      f.db,
      new ContentSourceRegistry(),
      {} as never,
      {} as never,
      {} as never,
    );
    try {
      const account =
        operation === "restore"
          ? await f.db.authorExternalAccount.create({
              data: {
                authorId: f.author.id,
                platform: "pixiv",
                externalUserId: "12" + Date.now(),
                deletedAt: new Date(),
                fetchEnabled: false,
              },
            })
          : null;
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>((r) => (entered = r)),
        finish = new Promise<void>((r) => (release = r));
      const archive = f.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM authors WHERE id=${f.author.id}::uuid FOR UPDATE`;
        await tx.author.update({
          where: { id: f.author.id },
          data: { deletedAt: new Date(), revision: { increment: 1 } },
        });
        await tx.authorExternalAccount.updateMany({
          where: { authorId: f.author.id },
          data: { deletedAt: new Date(), fetchEnabled: false },
        });
        entered();
        await finish;
      });
      await locked;
      const mutation =
        operation === "create"
          ? service.createAccount(f.author.id, {
              platform: "pixiv",
              externalUserId: "13" + Date.now(),
              fetchEnabled: false,
              firstSyncMode: "none",
            })
          : service.restoreAccount(f.author.id, account!.id, 0);
      const settled = mutation.then(
        () => true,
        () => false,
      );
      await new Promise((r) => setTimeout(r, 100));
      release();
      await archive;
      assert.equal(
        await settled,
        false,
        "account mutation must recheck the parent after its lock",
      );
      assert.equal(
        await f.db.authorExternalAccount.count({
          where: { authorId: f.author.id, deletedAt: null },
        }),
        0,
      );
    } finally {
      await f.db.authorExternalAccount.deleteMany({
        where: { authorId: f.author.id },
      });
      await f.close();
    }
  });
test("a binding that commits before archive is archived with the author", async () => {
  const f = await candidateReviewFixture();
  const service = new AuthorsService(
    f.db,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );
  try {
    await service.createAccount(f.author.id, {
      platform: "pixiv",
      externalUserId: randomUUID()
        .replaceAll("-", "")
        .split("")
        .map((c) => c.charCodeAt(0) % 10)
        .join("")
        .replace(/^0/, "1"),
      fetchEnabled: false,
      firstSyncMode: "none",
    });
    await service.archive(f.author.id, 0);
    assert.equal(
      await f.db.authorExternalAccount.count({
        where: { authorId: f.author.id, deletedAt: null },
      }),
      0,
    );
  } finally {
    await f.db.authorExternalAccount.deleteMany({
      where: { authorId: f.author.id },
    });
    await f.close();
  }
});
