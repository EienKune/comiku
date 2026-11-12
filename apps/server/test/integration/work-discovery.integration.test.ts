import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { HttpException } from "@nestjs/common";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { FINGERPRINT_RECIPE } from "../../src/image-similarity/fingerprint.js";
import {
  similarityCoverageQuery,
  similarityMatchesQuery,
} from "../../src/image-similarity/image-similarity-query.js";
import { ImageSimilarityService } from "../../src/image-similarity/image-similarity.service.js";
import type {
  ImageSimilarityCoverageDto,
  ImageSimilarityMatchDto,
} from "../../src/image-similarity/image-similarity.dto.js";
import {
  WorkAlbumQueryDto,
  WorkPhase,
  WorkView,
} from "../../src/works/works.dto.js";
import { WorksService } from "../../src/works/works.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import type { Actor } from "../../src/common/access.js";

loadRootEnvironment();
const checksum = () => createHash("sha256").update(randomUUID()).digest("hex");
const albumQuery = (input: Partial<WorkAlbumQueryDto> = {}) =>
  Object.assign(new WorkAlbumQueryDto(), input);

/** Database metadata only: no original image read, model, real source, worker or storage adapter. */
async function fixture() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Use an isolated TEST_DATABASE_URL ending in _test");
  const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
  const db = new PrismaService(environment);
  await db.$connect();
  const authors: string[] = [],
    users: string[] = [],
    files: string[] = [];
  const works = new WorksService(db, {} as never, {} as never);
  const similarity = new ImageSimilarityService(
    db,
    {
      readStream() {
        throw Error("GET must not read originals");
      },
    } as never,
    {
      enqueue() {
        throw Error("GET must not enqueue a job");
      },
    } as never,
    environment,
  );
  async function actor() {
    const user = await db.user.create({
      data: {
        username: `discovery_${randomUUID()}`,
        displayName: "Synthetic discovery source",
        passwordHash: "disabled",
        mustChangePassword: false,
        roles: { create: { role: "source" } },
      },
    });
    users.push(user.id);
    return user;
  }
  async function author() {
    const row = await db.author.create({
      data: {
        displayName: `Synthetic discovery ${randomUUID()}`,
        authorizationStatus: "authorized",
      },
    });
    authors.push(row.id);
    return row;
  }
  async function file(
    actorId: string,
    sha = checksum(),
    data: Partial<Prisma.FileObjectUncheckedCreateInput> = {},
  ) {
    const row = await db.fileObject.create({
      data: {
        objectKey: `synthetic-discovery/${randomUUID()}`,
        bucketScope: "source",
        kind: "source",
        contentType: "image/png",
        size: 10n,
        checksum: sha,
        createdById: actorId,
        ...data,
      },
    });
    files.push(row.id);
    return row;
  }
  async function post(authorId: string, fileIds: string[] = []) {
    return db.candidatePost.create({
      data: {
        authorId,
        platform: "discovery-fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: { synthetic: true },
        media: {
          create: fileIds.map((fileObjectId, orderIndex) => ({
            fileObjectId,
            orderIndex,
            externalMediaId: randomUUID(),
            mediaType: "image",
          })),
        },
      },
      include: { media: { orderBy: { orderIndex: "asc" } } },
    });
  }
  async function work(
    authorId: string,
    actorId: string,
    fileIds: string[],
    data: Partial<Prisma.WorkUncheckedCreateInput> = {},
    candidateId?: string,
    mediaIds?: string[],
  ) {
    const source = candidateId ?? (await post(authorId)).id;
    const row = await db.work.create({
      data: {
        authorId,
        importedById: actorId,
        sourceCandidatePostId: source,
        title: "Synthetic adopted work",
        ...data,
      },
    });
    await db.workImage.createMany({
      data: fileIds.map((originalFileObjectId, orderIndex) => ({
        workId: row.id,
        originalFileObjectId,
        orderIndex,
        ...(mediaIds ? { sourceCandidateMediaId: mediaIds[orderIndex] } : {}),
      })),
    });
    const images = await db.workImage.findMany({
      where: { workId: row.id },
      orderBy: { orderIndex: "asc" },
    });
    return { ...row, images };
  }
  async function fingerprint(
    fileObjectId: string,
    sourceSha256: string,
    data: Partial<Prisma.ImageFingerprintUncheckedCreateInput> = {},
  ) {
    return db.imageFingerprint.create({
      data: {
        fileObjectId,
        sourceSha256,
        recipeVersion: FINGERPRINT_RECIPE,
        status: "ready",
        phashHex: "3a5cc333f00ff0a5",
        ...data,
      },
    });
  }
  async function coverage() {
    return (
      await db.$queryRaw<ImageSimilarityCoverageDto[]>(
        similarityCoverageQuery(),
      )
    )[0];
  }
  async function matches(sha: string, phash: string | null) {
    return db.$queryRaw<ImageSimilarityMatchDto[]>(
      similarityMatchesQuery(sha, phash),
    );
  }
  return {
    db,
    environment,
    works,
    similarity,
    actor,
    author,
    file,
    post,
    work,
    fingerprint,
    coverage,
    matches,
    async close() {
      try {
        await db.work.deleteMany({ where: { authorId: { in: authors } } });
        await db.candidatePost.deleteMany({
          where: { authorId: { in: authors } },
        });
        const fingerprints = await db.imageFingerprint.findMany({
          where: { fileObjectId: { in: files } },
          select: { id: true },
        });
        await db.backgroundJob.deleteMany({
          where: {
            kind: "image_fingerprint",
            resourceId: { in: fingerprints.map((row) => row.id) },
          },
        });
        await db.imageFingerprint.deleteMany({
          where: { fileObjectId: { in: files } },
        });
        await db.fileObject.deleteMany({ where: { id: { in: files } } });
        await db.author.deleteMany({ where: { id: { in: authors } } });
        await db.authSession.deleteMany({ where: { userId: { in: users } } });
        await db.userRole.deleteMany({ where: { userId: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
      } finally {
        await db.$disconnect();
      }
    },
  };
}

function coverageDelta(
  after: ImageSimilarityCoverageDto,
  before: ImageSimilarityCoverageDto,
) {
  return {
    total: after.total - before.total,
    ready: after.ready - before.ready,
    pending: after.pending - before.pending,
    failed: after.failed - before.failed,
  };
}

test("global discovery uses adopted WorkImage subset/page order across authors and archived works, even when exact fingerprints fail", async () => {
  const f = await fixture();
  try {
    const baseline = await f.coverage(),
      actor = await f.actor(),
      author = await f.author(),
      foreign = await f.author();
    const sha = checksum();
    const [current, unused, first, selected, other, foreignExact] =
      await Promise.all([
        f.file(actor.id, sha),
        f.file(actor.id, sha),
        f.file(actor.id),
        f.file(actor.id, sha),
        f.file(actor.id),
        f.file(actor.id, sha),
      ]);
    const candidate = await f.post(author.id, [current.id]);
    const source = await f.post(author.id, [unused.id, first.id, selected.id]);
    const adopted = await f.work(
      author.id,
      actor.id,
      [selected.id, first.id],
      {},
      source.id,
      [source.media[2].id, source.media[1].id],
    );
    const archived = await f.work(
      foreign.id,
      actor.id,
      [other.id, foreignExact.id],
      { workflowStatus: "archived" },
    );
    const duplicateReference = await f.work(
      foreign.id,
      actor.id,
      [foreignExact.id],
      { workflowStatus: "published" },
    );
    await f.fingerprint(current.id, sha, {
      status: "failed",
      phashHex: null,
      lastError: "invalid_image",
    });
    await f.fingerprint(unused.id, sha);
    await f.fingerprint(first.id, first.checksum);
    await f.fingerprint(selected.id, sha, {
      status: "failed",
      phashHex: null,
      lastError: "unsupported_format",
    });
    await f.fingerprint(foreignExact.id, sha, {
      status: "failed",
      phashHex: null,
    });
    const rows = await f.matches(sha, null);
    assert.equal(
      rows.length,
      3,
      "candidate-only and unadopted media are not work matches",
    );
    const adoptedMatch = rows.find((row) => row.workId === adopted.id)!;
    assert.equal(adoptedMatch.imageId, adopted.images[0].id);
    assert.equal(
      adoptedMatch.index,
      0,
      "adopted page 0 came from source page 2",
    );
    assert.equal(
      adoptedMatch.imageCount,
      2,
      "metadata counts adopted pages, not all source media",
    );
    const archivedMatch = rows.find((row) => row.workId === archived.id)!;
    assert.equal(archivedMatch.authorId, foreign.id);
    assert.equal(archivedMatch.archived, true);
    assert.equal(archivedMatch.index, 1);
    assert.equal(
      rows.find((row) => row.workId === duplicateReference.id)?.imageCount,
      1,
    );
    assert.ok(
      rows.every((row) => row.matchKind === "exact" && row.distance === 0),
    );
    assert.deepEqual(
      coverageDelta(await f.coverage(), baseline),
      { total: 4, ready: 1, pending: 1, failed: 2 },
      "coverage deduplicates original files, excluding source-only media",
    );
    const jobsBefore = await f.db.backgroundJob.count();
    const result = await f.similarity.search(
      actor.id,
      candidate.id,
      candidate.media[0].id,
    );
    assert.equal(result.state, "failed");
    assert.equal(result.error, "invalid_image");
    assert.deepEqual(
      result.matches,
      rows,
      "decoding failure retains indexed SHA matches",
    );
    assert.equal(
      await f.db.backgroundJob.count(),
      jobsBefore,
      "GET neither schedules nor repairs work",
    );
  } finally {
    await f.close();
  }
});

test("real similarity SQL ranks exact pages before perceptual matches, caps Top12 and preserves actual multi-page ordering", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      author = await f.author(),
      foreign = await f.author();
    const sha = checksum(),
      exact = await f.file(actor.id, sha),
      near = await f.file(actor.id);
    const a = await f.work(
      author.id,
      actor.id,
      Array(8).fill(exact.id) as string[],
    );
    const b = await f.work(
      foreign.id,
      actor.id,
      Array(8).fill(exact.id) as string[],
      { workflowStatus: "archived" },
    );
    await f.work(foreign.id, actor.id, [near.id]);
    await f.fingerprint(exact.id, sha, { status: "failed", phashHex: null });
    await f.fingerprint(near.id, near.checksum);
    const rows = await f.matches(sha, "3a5cc333f00ff0a5");
    const expected = [a, b]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .flatMap((work) => work.images.map((image) => image.id))
      .slice(0, 12);
    assert.equal(rows.length, 12);
    assert.deepEqual(
      rows.map((row) => row.imageId),
      expected,
    );
    assert.ok(
      rows.every(
        (row) =>
          row.matchKind === "exact" &&
          row.distance === 0 &&
          row.imageCount === 8,
      ),
    );
    for (const row of rows)
      assert.equal(
        row.index,
        [a, b]
          .find((work) => work.id === row.workId)!
          .images.findIndex((image) => image.id === row.imageId),
      );
    assert.ok(
      rows.some((row) => row.archived),
      "archived exact pages compete in global TopK",
    );
  } finally {
    await f.close();
  }
});

test("real Hamming threshold and coverage fence recipe/checksum/format/lifecycle identities and report partial results", async () => {
  const f = await fixture();
  try {
    const before = await f.coverage(),
      actor = await f.actor(),
      author = await f.author();
    const phash = "3a5cc333f00ff0a5",
      value = BigInt(`0x${phash}`);
    const current = await f.file(actor.id),
      candidate = await f.post(author.id, [current.id]);
    await f.fingerprint(current.id, current.checksum, { phashHex: phash });
    const adopted = await Promise.all(
      Array.from({ length: 13 }, () => f.file(actor.id)),
    );
    const work = await f.work(
      author.id,
      actor.id,
      adopted.map((file) => file.id),
    );
    const distances = [0, 1, 10, 11];
    for (let index = 0; index < distances.length; index++)
      await f.fingerprint(adopted[index].id, adopted[index].checksum, {
        phashHex: (value ^ ((1n << BigInt(distances[index])) - 1n))
          .toString(16)
          .padStart(16, "0"),
      });
    await f.fingerprint(adopted[4].id, adopted[4].checksum, {
      status: "failed",
      phashHex: null,
    });
    // Missing row [5], stale content [6], old recipe [7], valid queued row [8].
    await f.fingerprint(adopted[6].id, checksum());
    await f.fingerprint(adopted[7].id, adopted[7].checksum, {
      recipeVersion: `${FINGERPRINT_RECIPE}-retired`,
    });
    await assert.rejects(
      f.fingerprint(adopted[8].id, adopted[8].checksum, { phashHex: null }),
      /image_fingerprint_ready_hash_check|constraint/i,
    );
    await assert.rejects(
      f.fingerprint(adopted[8].id, adopted[8].checksum, {
        phashHex: "GGGGGGGGGGGGGGGG",
      }),
      /image_fingerprint_ready_hash_check|constraint/i,
    );
    await f.fingerprint(adopted[8].id, adopted[8].checksum, {
      status: "queued",
      phashHex: null,
    });
    await f.fingerprint(adopted[9].id, adopted[9].checksum);
    await f.fingerprint(adopted[10].id, adopted[10].checksum);
    await f.fingerprint(adopted[11].id, adopted[11].checksum, {
      status: "queued",
      phashHex: null,
    });
    await f.fingerprint(adopted[12].id, adopted[12].checksum, {
      status: "running",
      phashHex: null,
    });
    await f.db.fileObject.update({
      where: { id: adopted[9].id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    await f.db.fileObject.update({
      where: { id: adopted[10].id },
      data: { deletedAt: new Date() },
    });
    await f.work(author.id, actor.id, [adopted[0].id], {
      workflowStatus: "archived",
    });
    const coverage = await f.coverage();
    assert.deepEqual(coverageDelta(coverage, before), {
      total: 13,
      ready: 4,
      pending: 6,
      failed: 3,
    });
    const raw = await f.matches(current.checksum, phash);
    const own = raw.filter((row) => row.workId === work.id);
    assert.deepEqual(
      own.map((row) => [row.index, row.distance, row.matchKind]),
      [
        [0, 0, "perceptual"],
        [1, 1, "perceptual"],
        [2, 10, "perceptual"],
      ],
    );
    assert.ok(raw.every((row) => row.distance <= 10));
    const result = await f.similarity.search(
      actor.id,
      candidate.id,
      candidate.media[0].id,
    );
    assert.equal(result.state, "partial");
    assert.deepEqual(result.coverage, coverage);
    assert.deepEqual(result.matches, raw);
  } finally {
    await f.close();
  }
});

test("album streams every adopted page with a bounded seek across a large work, equal import times and archive scope", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      author = await f.author(),
      foreign = await f.author(),
      file = await f.file(actor.id);
    const sameTime = new Date("2026-10-01T10:00:00.000Z");
    const large = await f.work(
      author.id,
      actor.id,
      Array(137).fill(file.id) as string[],
      { importedAt: sameTime },
    );
    const sibling = await f.work(
      author.id,
      actor.id,
      Array(4).fill(file.id) as string[],
      { importedAt: sameTime },
    );
    const newer = await f.work(
      author.id,
      actor.id,
      Array(3).fill(file.id) as string[],
      { importedAt: new Date("2026-10-02T10:00:00.000Z") },
    );
    const older = await f.work(
      author.id,
      actor.id,
      Array(2).fill(file.id) as string[],
      { importedAt: new Date("2026-09-30T10:00:00.000Z") },
    );
    const archived = await f.work(
      author.id,
      actor.id,
      Array(5).fill(file.id) as string[],
      {
        workflowStatus: "archived",
        importedAt: new Date("2026-10-03T10:00:00.000Z"),
      },
    );
    await f.work(foreign.id, actor.id, [file.id], { importedAt: sameTime });
    const expected = [
      newer,
      ...[large, sibling].sort((left, right) => (left.id > right.id ? -1 : 1)),
      older,
    ].flatMap((work) => work.images.map((image) => image.id));
    const seen: string[] = [];
    let cursor: string | undefined,
      pageCount = 0;
    do {
      const page = await f.works.album(
        actor.id,
        albumQuery({ authorId: author.id, limit: 60, cursor }),
      );
      assert.equal(page.total, 146);
      assert.equal(page.workTotal, 4);
      assert.ok(page.items.length <= 60);
      assert.ok(page.items.length > 0);
      for (const image of page.items) {
        const owner = [large, sibling, newer, older].find(
          (work) => work.id === image.workId,
        )!;
        assert.equal(image.imageCount, owner.images.length);
        assert.equal(image.importedAt, owner.importedAt.toISOString());
        assert.equal(
          image.orderIndex,
          owner.images.findIndex((item) => item.id === image.id),
        );
      }
      seen.push(...page.items.map((image) => image.id));
      cursor = page.nextCursor ?? undefined;
      assert.ok(
        ++pageCount <= 3,
        "seek must finish without repeating the first large-work page",
      );
    } while (cursor);
    assert.equal(pageCount, 3);
    assert.equal(new Set(seen).size, 146);
    assert.deepEqual(seen, expected);
    const history = await f.works.album(
      actor.id,
      albumQuery({
        authorId: author.id,
        workflowStatus: "archived",
        limit: 60,
      }),
    );
    assert.equal(history.total, 5);
    assert.equal(history.workTotal, 1);
    assert.deepEqual(
      history.items.map((image) => image.id),
      archived.images.map((image) => image.id),
    );
  } finally {
    await f.close();
  }
});

test("album binds cursors to actor and every work filter, applies metadata/mine scopes and rejects non-view modes", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      other = await f.actor(),
      author = await f.author(),
      file = await f.file(actor.id);
    const kept = await f.work(
      author.id,
      actor.id,
      [file.id, file.id, file.id],
      {
        title: "Discovery needle",
        workflowStatus: "translating",
        sourceLanguage: "ja",
      },
    );
    await f.db.workStageParticipant.create({
      data: {
        workId: kept.id,
        userId: actor.id,
        stage: "translate",
        participationMode: "owner",
      },
    });
    await f.work(author.id, actor.id, [file.id, file.id], {
      title: "Other selection",
      workflowStatus: "pending_typeset",
      sourceLanguage: "ko",
      reviewStatus: "blocked",
    });
    const input = albumQuery({ authorId: author.id, limit: 1 });
    const page = await f.works.album(actor.id, input);
    assert.equal(page.total, 5);
    assert.equal(page.workTotal, 2);
    assert.ok(page.nextCursor);
    const changes: Partial<WorkAlbumQueryDto>[] = [
      { authorId: randomUUID() },
      { search: "needle" },
      { sourceLanguage: "ja" },
      { phase: WorkPhase.translation },
      { workflowStatus: "translating" },
      { reviewStatus: "normal" },
      { mine: true },
      { unassignedStage: "translate" },
    ];
    for (const changed of changes)
      await assert.rejects(
        f.works.album(
          actor.id,
          albumQuery({ ...input, ...changed, cursor: page.nextCursor! }),
        ),
        /相册游标无效/,
      );
    await assert.rejects(
      f.works.album(
        other.id,
        albumQuery({ ...input, cursor: page.nextCursor! }),
      ),
      /相册游标无效/,
    );
    await assert.rejects(
      f.works.album(actor.id, albumQuery({ ...input, cursor: "not-a-cursor" })),
      /相册游标无效/,
    );
    await assert.rejects(
      f.works.album(actor.id, albumQuery({ view: WorkView.todo })),
      /仅用于作品查看/,
    );
    await assert.rejects(
      f.works.album(actor.id, albumQuery({ claimStage: "translate" })),
      /仅用于作品查看/,
    );
    const filtered = await f.works.album(
      actor.id,
      albumQuery({
        authorId: author.id,
        search: "needle",
        sourceLanguage: "ja",
        phase: WorkPhase.translation,
        reviewStatus: "normal",
        mine: true,
        limit: 60,
      }),
    );
    assert.equal(filtered.total, 3);
    assert.ok(filtered.items.every((image) => image.workId === kept.id));
    const mine = await f.works.album(
      actor.id,
      albumQuery({ authorId: author.id, mine: true, limit: 60 }),
    );
    assert.equal(mine.total, 3);
    await f.db.user.update({
      where: { id: actor.id },
      data: { isActive: false },
    });
    await assert.rejects(
      f.works.album(actor.id, albumQuery({ authorId: author.id })),
      /不能查看作品/,
    );
  } finally {
    await f.close();
  }
});

test("fingerprint preparation rechecks the current session before enqueue while GET stays read-only under existing read permissions", async () => {
  const f = await fixture();
  try {
    const source = await f.actor(),
      other = await f.actor(),
      author = await f.author(),
      file = await f.file(source.id);
    const candidate = await f.post(author.id, [file.id]);
    const now = new Date();
    const session = await f.db.authSession.create({
      data: {
        userId: source.id,
        tokenHash: checksum(),
        expiresAt: new Date(now.getTime() + 3_600_000),
        revokedAt: now,
      },
    });
    const foreignSession = await f.db.authSession.create({
      data: {
        userId: other.id,
        tokenHash: checksum(),
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
    });
    const actor: Actor = { userId: source.id, sessionId: session.id };
    const service = new ImageSimilarityService(
      f.db,
      {
        readStream() {
          throw Error("Preparation only enqueues; it must not read originals");
        },
      } as never,
      new JobsService(f.db),
      f.environment,
    );
    const before = await f.db.backgroundJob.count();
    const prepare = (identity?: Actor) =>
      service.search(
        source.id,
        candidate.id,
        candidate.media[0].id,
        true,
        identity,
      );
    const isAuthorizationFailure = (error: unknown) =>
      error instanceof HttpException && [401, 403].includes(error.getStatus());
    async function unchangedRead() {
      const result = await service.search(
        source.id,
        candidate.id,
        candidate.media[0].id,
      );
      assert.equal(result.state, "preparing");
      assert.equal(await f.db.backgroundJob.count(), before);
      assert.equal(
        await f.db.imageFingerprint.count({ where: { fileObjectId: file.id } }),
        0,
      );
    }
    await assert.rejects(
      prepare(actor),
      isAuthorizationFailure,
      "revoked session cannot register a fingerprint",
    );
    await unchangedRead();
    await f.db.authSession.update({
      where: { id: session.id },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 1_000) },
    });
    await assert.rejects(
      prepare(actor),
      isAuthorizationFailure,
      "absolute expiry fences POST",
    );
    await unchangedRead();
    await f.db.authSession.update({
      where: { id: session.id },
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(
          Date.now() - (f.environment.authSessionIdleSeconds + 60) * 1_000,
        ),
      },
    });
    await assert.rejects(
      prepare(actor),
      isAuthorizationFailure,
      "idle expiry fences POST",
    );
    await unchangedRead();
    await assert.rejects(
      prepare({ userId: other.id, sessionId: foreignSession.id }),
      isAuthorizationFailure,
      "actor ID cannot substitute another member",
    );
    await assert.rejects(
      prepare({ userId: source.id, sessionId: foreignSession.id }),
      isAuthorizationFailure,
      "a session must belong to the current actor",
    );
    await assert.rejects(
      prepare(),
      isAuthorizationFailure,
      "missing actor cannot schedule from an ID alone",
    );
    await unchangedRead();
    await f.db.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
    await f.db.userRole.deleteMany({ where: { userId: source.id } });
    await f.db.userRole.create({
      data: { userId: source.id, role: "translator" },
    });
    await assert.rejects(
      prepare(actor),
      isAuthorizationFailure,
      "valid session still needs current candidate read permission",
    );
    await assert.rejects(
      service.search(source.id, candidate.id, candidate.media[0].id),
      isAuthorizationFailure,
      "GET retains its current role check",
    );
    assert.equal(await f.db.backgroundJob.count(), before);
    assert.equal(
      await f.db.imageFingerprint.count({ where: { fileObjectId: file.id } }),
      0,
    );
    await f.db.userRole.deleteMany({ where: { userId: source.id } });
    await f.db.userRole.create({ data: { userId: source.id, role: "source" } });
    const accepted = await prepare(actor);
    assert.equal(accepted.state, "preparing");
    const row = await f.db.imageFingerprint.findUniqueOrThrow({
      where: {
        fileObjectId_recipeVersion: {
          fileObjectId: file.id,
          recipeVersion: FINGERPRINT_RECIPE,
        },
      },
    });
    assert.equal(row.status, "queued");
    assert.ok(row.jobId);
    const job = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: row.jobId! },
    });
    assert.equal(job.resourceId, row.id);
    assert.equal(job.kind, "image_fingerprint");
    assert.equal(job.status, "queued");
    assert.equal(await f.db.backgroundJob.count(), before + 1);
    await service.search(source.id, candidate.id, candidate.media[0].id);
    assert.equal(
      await f.db.backgroundJob.count(),
      before + 1,
      "GET does not schedule another job after preparation either",
    );
  } finally {
    await f.close();
  }
});
