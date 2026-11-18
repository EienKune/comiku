import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { createApplication } from "../../src/application.js";
import { importReferenceDictionary } from "../../src/reference-dictionary/import.js";
import { ReferenceDictionaryService } from "../../src/reference-dictionary/reference-dictionary.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL ending in _test required");
const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });

function snapshot(
  key: string,
  original: string,
  importerVersion = "synthetic-v1",
) {
  return {
    formatVersion: 1,
    source: {
      key,
      name: "Synthetic reference",
      version: "1",
      fileSha256: "a".repeat(64),
      importerVersion,
      sourceUrl: "https://example.invalid/reference",
      attribution: "Synthetic attribution",
      license: "MIT",
    },
    entries: [
      {
        sourceRef: "line:1",
        original,
        explanationZh: "合成中文解释\n第二行",
        explanationJa: null,
        translationZh: null,
      },
      {
        sourceRef: "line:2",
        original,
        explanationZh: null,
        explanationJa: "合成の別義",
        translationZh: "合成建议",
      },
      {
        sourceRef: "line:3",
        original: original.replace("カクッ", "かくっ"),
        explanationZh: null,
        explanationJa: null,
        translationZh: null,
      },
      {
        sourceRef: "line:4",
        original: `前${original}後`,
        explanationZh: null,
        explanationJa: null,
        translationZh: null,
      },
    ],
  };
}

test("dictionary PostgreSQL preserves meanings, exact/normalized/literal search and bounded pagination", async () => {
  const db = new PrismaService(environment);
  const key = `synthetic_${randomUUID()}`;
  const marker = randomUUID();
  const original = `カクッ${marker}`;
  try {
    await db.$connect();
    const input = snapshot(key, original);
    input.entries[2]!.explanationZh = "归一词形的中文解释";
    input.entries[3]!.explanationZh = "子串词形的中文解释";
    await importReferenceDictionary(db, input, 0);
    const source = await db.onomatopoeiaSource.findUniqueOrThrow({
      where: { key },
    });
    await db.onomatopoeiaEntry.create({
      data: {
        sourceId: source.id,
        sourceRef: "line:0",
        original,
        searchKey: original.replace("カクッ", "かくっ"),
        explanationJa: "合成の日本語のみの説明",
      },
    });
    const service = new ReferenceDictionaryService(db);
    const page = await service.search(original, 0);
    assert.deepEqual(
      page.entries.map((entry) => entry.sourceRef),
      ["line:1", "line:2", "line:0", "line:3", "line:4"],
    );
    assert.equal(page.entries[0]?.explanationZh, "合成中文解释\n第二行");
    assert.equal(page.entries[1]?.translationZh, "合成建议");
    assert.equal(page.entries[3]?.explanationJa, null);
    assert.deepEqual(page.entries[0]?.source, {
      key,
      name: "Synthetic reference",
      version: "1",
      sourceUrl: "https://example.invalid/reference",
      attribution: "Synthetic attribution",
      license: "MIT",
    });
    await db.onomatopoeiaEntry.createMany({
      data: Array.from({ length: 23 }, (_, index) => ({
        sourceId: source.id,
        sourceRef: `page:${index}`,
        original: `page${marker}:${index}`,
        searchKey: `page${marker}:${index}`,
      })),
    });
    const first = await service.search(`page${marker}`, 0);
    const second = await service.search(`page${marker}`, first.nextOffset);
    assert.equal(first.entries.length, 20);
    assert.equal(first.nextOffset, 20);
    assert.equal(second.entries.length, 3);
    assert.equal(second.nextOffset, null);
    assert.equal(
      new Set([...first.entries, ...second.entries].map((entry) => entry.id))
        .size,
      23,
    );
    await db.onomatopoeiaEntry.createMany({
      data: ["percent%_\\", "percentABC"].map((word, index) => ({
        sourceId: source.id,
        sourceRef: `literal:${index}`,
        original: `${word}${marker}`,
        searchKey: `${word}${marker}`,
      })),
    });
    assert.deepEqual(
      (await service.search(`%_\\${marker}`, 0)).entries.map(
        (entry) => entry.sourceRef,
      ),
      ["literal:0"],
    );
    assert.deepEqual(await service.search("  ", 0), {
      entries: [],
      nextOffset: null,
    });
    assert.equal(
      (await service.search(`page${marker}`, 10000)).nextOffset,
      null,
    );
  } finally {
    await db.onomatopoeiaSource.deleteMany({ where: { key } });
    await db.$disconnect();
  }
});

test("dictionary metadata corrections preserve the imported corpus identity and timestamp", async () => {
  const db = new PrismaService(environment);
  const key = `synthetic_${randomUUID()}`;
  try {
    const initial = snapshot(key, "カクッ");
    await importReferenceDictionary(db, initial, 0);
    const before = await db.onomatopoeiaSource.findUniqueOrThrow({
      where: { key },
      include: { entries: { orderBy: { sourceRef: "asc" } } },
    });
    const corrected = {
      ...initial,
      source: {
        ...initial.source,
        name: "Corrected synthetic reference",
        version: "2",
        sourceUrl: null,
        attribution: "Corrected synthetic attribution",
        license: null,
      },
    };
    assert.equal(
      (await importReferenceDictionary(db, corrected, 1)).revision,
      2,
    );
    assert.equal(
      (await importReferenceDictionary(db, corrected, 2)).status,
      "unchanged",
    );
    await assert.rejects(importReferenceDictionary(db, initial, 1), /revision/);
    const after = await db.onomatopoeiaSource.findUniqueOrThrow({
      where: { key },
      include: { entries: { orderBy: { sourceRef: "asc" } } },
    });
    assert.deepEqual(after, { ...before, ...corrected.source, revision: 2 });
  } finally {
    await db.onomatopoeiaSource.deleteMany({ where: { key } });
    await db.$disconnect();
  }
});

test("dictionary replacement is atomic, parser-aware and fenced for stale/concurrent/new importers", async () => {
  const db = new PrismaService(environment);
  const key = `synthetic_${randomUUID()}`,
    raceKey = `synthetic_${randomUUID()}`;
  try {
    await db.$connect();
    const input = snapshot(key, "カクッ");
    assert.equal((await importReferenceDictionary(db, input, 0)).revision, 1);
    const originalRows = await db.onomatopoeiaEntry.findMany({
      where: { source: { key } },
      orderBy: { sourceRef: "asc" },
    });
    assert.equal(
      (await importReferenceDictionary(db, input, 1)).status,
      "unchanged",
    );
    assert.deepEqual(
      await db.onomatopoeiaEntry.findMany({
        where: { source: { key } },
        orderBy: { sourceRef: "asc" },
      }),
      originalRows,
    );
    const malformed = snapshot(key, "ガクッ");
    malformed.entries[1]!.sourceRef = "line:1";
    await assert.rejects(
      importReferenceDictionary(db, malformed, 1),
      /Duplicate/,
    );
    const failure = new Error("synthetic failure after insertion");
    const failing = {
      $transaction: (
        operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        db.$transaction(async (tx) =>
          operation({
            $queryRaw: tx.$queryRaw.bind(tx),
            onomatopoeiaSource: tx.onomatopoeiaSource,
            onomatopoeiaEntry: {
              deleteMany: tx.onomatopoeiaEntry.deleteMany.bind(
                tx.onomatopoeiaEntry,
              ),
              createMany: async (
                args: Prisma.OnomatopoeiaEntryCreateManyArgs,
              ) => {
                await tx.onomatopoeiaEntry.createMany(args);
                throw failure;
              },
            },
          } as unknown as Prisma.TransactionClient),
        ),
    } as unknown as Pick<PrismaService, "$transaction">;
    await assert.rejects(
      importReferenceDictionary(
        failing,
        snapshot(key, "ガクッ", "synthetic-v2"),
        1,
      ),
      (error) => error === failure,
    );
    assert.equal(
      (await db.onomatopoeiaSource.findUniqueOrThrow({ where: { key } }))
        .revision,
      1,
    );
    assert.deepEqual(
      await db.onomatopoeiaEntry.findMany({
        where: { source: { key } },
        orderBy: { sourceRef: "asc" },
      }),
      originalRows,
    );
    assert.equal(
      (
        await importReferenceDictionary(
          db,
          snapshot(key, "ガクッ", "synthetic-v2"),
          1,
        )
      ).revision,
      2,
    );
    await assert.rejects(importReferenceDictionary(db, input, 1), /revision/);
    const races = await Promise.allSettled([
      importReferenceDictionary(db, snapshot(key, "バタッ", "synthetic-v3"), 2),
      importReferenceDictionary(db, snapshot(key, "ドタッ", "synthetic-v4"), 2),
    ]);
    assert.equal(
      races.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      (await db.onomatopoeiaSource.findUniqueOrThrow({ where: { key } }))
        .revision,
      3,
    );
    const initialRace = await Promise.allSettled([
      importReferenceDictionary(db, snapshot(raceKey, "カクッ"), 0),
      importReferenceDictionary(db, snapshot(raceKey, "カクッ"), 0),
    ]);
    assert.equal(
      initialRace.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      await db.onomatopoeiaEntry.count({ where: { source: { key: raceKey } } }),
      4,
    );
  } finally {
    await db.onomatopoeiaSource.deleteMany({
      where: { key: { in: [key, raceKey] } },
    });
    await db.$disconnect();
  }
});

test("dictionary HTTP requires a qualified session and returns private bounded read-only pages", async () => {
  const app = await createApplication(environment);
  const db = app.get(PrismaService);
  const users: string[] = [];
  async function token(qualified: boolean) {
    const user = await db.user.create({
      data: {
        username: `reference_${randomUUID()}`,
        passwordHash: "disabled",
        displayName: "Synthetic member",
        mustChangePassword: false,
        ...(qualified
          ? { roles: { create: { role: "translator" as const } } }
          : {}),
      },
    });
    users.push(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return token;
  }
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/reference-dictionary`;
    async function request(query: string, session?: string) {
      return fetch(`${base}${query}`, {
        headers: {
          ...(session ? { Cookie: `comiku_session=${session}` } : {}),
        },
      });
    }
    const anonymous = await request("?q=synthetic");
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    const denied = await request("?q=synthetic", await token(false));
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    const session = await token(true);
    const allowed = await request("?q=", session);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await allowed.json(), { entries: [], nextOffset: null });
    for (const query of [
      `?q=${"x".repeat(81)}`,
      "?offset=10001",
      "?offset=-1",
      "?offset=1.2",
      "?q=a&q=b",
    ]) {
      const response = await request(query, session);
      assert.equal(response.status, 400);
      await response.body?.cancel();
    }
  } finally {
    await db.authSession.deleteMany({ where: { userId: { in: users } } });
    await db.userRole.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  }
});
