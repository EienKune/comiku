import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { AuthorsService } from "../../src/authors/authors.service.js";
import { authorQuery } from "../../src/authors/author-query.js";
import {
  AuthorAccountFilter,
  type AuthorQueryDto,
} from "../../src/authors/authors.dto.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("database author keysets preserve rank, ties and filters with bounded summary reads", async (t) => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const prefix = `paging_${randomUUID().replaceAll("-", "")}`;
  const term = `needle${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const ids = Array.from({ length: 256 }, () => randomUUID());
  const numeric = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
  const tagId = randomUUID();
  const reads: {
    take: number | undefined;
    ids: number;
    includesAdapters: boolean;
    includesPrivateFields: boolean;
  }[] = [];
  const rawPageSizes: number[] = [];
  const transaction = db.$transaction.bind(db);
  const measured = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return (
        action: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        transaction(
          async (tx) =>
            action(
              new Proxy(tx, {
                get(client, property, clientReceiver) {
                  if (property === "$queryRaw")
                    return async (query: Prisma.Sql) => {
                      const rows = await client.$queryRaw<unknown[]>(query);
                      if (query.text.includes("WITH filtered"))
                        rawPageSizes.push(rows.length);
                      return rows;
                    };
                  if (property === "author")
                    return new Proxy(client.author, {
                      get(model, operation, modelReceiver) {
                        if (operation !== "findMany")
                          return Reflect.get(model, operation, modelReceiver);
                        return async (args: Prisma.AuthorFindManyArgs) => {
                          const selected = args.where?.id as { in?: string[] };
                          reads.push({
                            take: args.take,
                            ids: selected.in?.length ?? 0,
                            includesAdapters: JSON.stringify(
                              args.select ?? args.include,
                            ).includes("adapterStates"),
                            includesPrivateFields:
                              /notes|metadataJson|discoveryCheckpointJson/.test(
                                JSON.stringify(args.select ?? args.include),
                              ),
                          });
                          return model.findMany(args);
                        };
                      },
                    });
                  return Reflect.get(client, property, clientReceiver);
                },
              }),
            ),
          options,
        );
    },
  });
  const authors = new AuthorsService(
    measured,
    new ContentSourceRegistry(),
    null as never,
    null as never,
    null as never,
  );
  const names = ids.map(
    (_, i) => `${term} ${String(Math.floor(i / 3)).padStart(3, "0")}`,
  );
  try {
    await db.tag.create({
      data: { id: tagId, name: prefix, normalizedName: prefix },
    });
    await db.author.createMany({
      data: ids.map((id, i) => ({
        id,
        displayName: names[i],
        authorizationStatus:
          i === 254 ? ("pending" as const) : ("authorized" as const),
        deletedAt: i === 255 ? new Date() : null,
      })),
    });
    await db.authorTag.createMany({
      data: ids.map((authorId) => ({ authorId, tagId })),
    });
    const accounts = ids.flatMap((authorId, i) => [
      {
        id: randomUUID(),
        authorId,
        platform: "x",
        externalUserId: `${numeric}${i}`,
        handle:
          i === 0
            ? term
            : i === 1
              ? `${term}more`
              : i === 2
                ? `pre${term}post`
                : `unrelated${i}`,
        metadataJson: { synthetic: "m".repeat(8192) },
      },
      {
        id: randomUUID(),
        authorId,
        platform: "pixiv",
        externalUserId: `${numeric}${i}`,
        handle: null,
        metadataJson: { synthetic: "m".repeat(8192) },
      },
    ]);
    await db.authorExternalAccount.createMany({ data: accounts });
    await db.sourceAdapterState.createMany({
      data: accounts.map((account) => ({
        externalAccountId: account.id,
        adapterKey: "synthetic_paging",
        discoveryCheckpointJson: { synthetic: "c".repeat(8192) },
      })),
    });
    // Fixture bulk inserts must have current statistics before comparing plans.
    await db.$executeRaw`ANALYZE authors, author_external_accounts, author_tags, tags`;
    const options = {
      tag: prefix,
      authorizationStatus: "authorized" as const,
      search: `@${term}`,
      platform: "x",
      limit: 50,
    };
    const start = performance.now();
    const actual: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    do {
      const page = await authors.list({ ...options, cursor });
      assert.equal(page.total, 254);
      assert(page.items.length <= 50);
      assert(
        page.items.every((author) => author.externalAccounts.length === 2),
      );
      assert(!JSON.stringify(page).includes('"synthetic"'));
      actual.push(...page.items.map((author) => author.id));
      cursor = page.nextCursor ?? undefined;
      firstCursor ??= cursor;
    } while (cursor);
    const expected = ids.slice(0, 254).sort((a, b) => {
      const ai = ids.indexOf(a),
        bi = ids.indexOf(b);
      return (
        Math.min(ai, 3) - Math.min(bi, 3) ||
        Buffer.compare(Buffer.from(names[ai]), Buffer.from(names[bi])) ||
        a.localeCompare(b)
      );
    });
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, 254);
    assert(actual.includes(ids[50]) && actual.includes(ids[100]));
    assert(rawPageSizes.every((size) => size <= 51));
    assert(
      reads.every(
        (read) =>
          read.take === 50 &&
          read.ids <= 50 &&
          !read.includesAdapters &&
          !read.includesPrivateFields,
      ),
    );
    await assert.rejects(
      authors.list({
        ...options,
        cursor: firstCursor,
        authorizationStatus: "pending",
      }),
    );
    await assert.rejects(
      authors.list({ ...options, cursor: firstCursor, search: "other" }),
    );
    await assert.rejects(authors.list({ ...options, cursor: "not-a-cursor" }));
    const pixiv = await authors.list({
      tag: prefix,
      search: `${numeric}100`,
      platform: "pixiv",
    });
    assert.deepEqual(
      pixiv.items.map((author) => author.id),
      [ids[100]],
    );
    const literal = await authors.list({
      tag: prefix,
      search: "%_' OR true --",
    });
    assert.equal(literal.total, 0);
    // A removed anchor does not invalidate a tuple: its remaining tail continues.
    const before = await authors.list({ tag: prefix, limit: 1 });
    const removed = before.items[0].id;
    await db.author.update({
      where: { id: removed },
      data: { deletedAt: new Date() },
    });
    const after = await authors.list({
      tag: prefix,
      limit: 1,
      cursor: before.nextCursor!,
    });
    assert.equal(after.items.length, 1);
    assert.notEqual(after.items[0].id, removed);
    const plan = authorQuery(options);
    type ExplainNode = { "Index Name"?: string; Plans?: ExplainNode[] };
    type ExplainResult = {
      "QUERY PLAN": {
        "Execution Time": number;
        "Planning Time": number;
        Plan: ExplainNode;
      }[];
    };
    const explain = await db.$queryRawUnsafe<ExplainResult[]>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${plan.page.text}`,
      ...plan.page.values,
    );
    const execution = explain[0]["QUERY PLAN"][0];
    const indexes = new Set<string>();
    const inspectPlan = (node: ExplainNode) => {
      if (node["Index Name"]) indexes.add(node["Index Name"]);
      node.Plans?.forEach(inspectPlan);
    };
    inspectPlan(execution.Plan);
    t.diagnostic(
      JSON.stringify({
        syntheticAuthors: 256,
        accounts: 512,
        omittedPayloadBytesPerAccount: 16384,
        listPages: 6,
        elapsedMs: Math.round(performance.now() - start),
        maxPositionsRead: Math.max(...rawPageSizes),
        maxSummaryAuthors: Math.max(...reads.map((read) => read.ids)),
        queryExecutionMs: execution["Execution Time"],
        queryPlanningMs: execution["Planning Time"],
        usedIndex: indexes.size > 0,
        indexes: [...indexes].sort(),
      }),
    );
  } finally {
    await db.sourceAdapterState.deleteMany({
      where: { externalAccount: { authorId: { in: ids } } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: ids } },
    });
    await db.authorTag.deleteMany({ where: { authorId: { in: ids } } });
    await db.author.deleteMany({ where: { id: { in: ids } } });
    await db.tag.deleteMany({ where: { id: tagId } });
    await db.$disconnect();
  }
});

test("database author account filters combine active X and Pixiv states without leaking management data", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const authors = new AuthorsService(
    db,
    new ContentSourceRegistry(),
    null as never,
    null as never,
    null as never,
  );
  const prefix = `account_states_${randomUUID().replaceAll("-", "")}`;
  const numeric = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
  const ids: string[] = Array.from({ length: 12 }, () => randomUUID());
  const tagId = randomUUID();
  // Independently hand-checked fixtures: true=on, false=off, null=unlinked.
  const states: [boolean | null, boolean | null][] = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
    [true, null],
    [null, true],
    [null, null],
    [false, null],
    [null, false],
    [null, null],
    [true, true],
    [true, true],
  ];
  const accounts = states.flatMap((state, index) =>
    state.flatMap((enabled, platformIndex) =>
      enabled === null
        ? []
        : [
            {
              id: randomUUID(),
              authorId: ids[index],
              platform: platformIndex === 0 ? "x" : "pixiv",
              externalUserId: `${numeric}${index}`,
              fetchEnabled: enabled,
              notes: "private account note",
              metadataJson: { private: "account metadata" },
              deletedAt: null as Date | null,
            },
          ],
    ),
  );
  // A deleted account must establish neither linked nor enabled/disabled.
  for (const [index, platform, enabled] of [
    [9, "x", true],
    [9, "pixiv", false],
    [7, "pixiv", true],
  ] as const)
    accounts.push({
      id: randomUUID(),
      authorId: ids[index],
      platform,
      externalUserId: `${numeric}${index}`,
      fetchEnabled: enabled,
      notes: "deleted private note",
      metadataJson: { private: "deleted metadata" },
      deletedAt: new Date(),
    });
  try {
    await db.tag.create({
      data: { id: tagId, name: prefix, normalizedName: prefix },
    });
    await db.author.createMany({
      data: ids.map((id, index) => ({
        id,
        displayName: `${prefix} ${String(index).padStart(2, "0")}`,
        notes: "private author note",
        authorizationStatus: index === 10 ? "pending" : "authorized",
        deletedAt: index === 11 ? new Date() : null,
      })),
    });
    await db.authorTag.createMany({
      data: ids.map((authorId) => ({ authorId, tagId })),
    });
    await db.authorExternalAccount.createMany({ data: accounts });
    await db.sourceAdapterState.createMany({
      data: accounts.map((account) => ({
        externalAccountId: account.id,
        adapterKey: "synthetic_account_filters",
        discoveryCheckpointJson: { private: "adapter checkpoint" },
      })),
    });
    const cases: { filters: AuthorQueryDto; expected: number[] }[] = [
      { filters: {}, expected: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
      {
        filters: { xState: AuthorAccountFilter.linked },
        expected: [0, 1, 2, 3, 4, 7],
      },
      { filters: { xState: AuthorAccountFilter.enabled }, expected: [0, 1, 4] },
      {
        filters: { xState: AuthorAccountFilter.disabled },
        expected: [2, 3, 7],
      },
      {
        filters: { xState: AuthorAccountFilter.unlinked },
        expected: [5, 6, 8, 9],
      },
      {
        filters: { pixivState: AuthorAccountFilter.linked },
        expected: [0, 1, 2, 3, 5, 8],
      },
      {
        filters: { pixivState: AuthorAccountFilter.enabled },
        expected: [0, 2, 5],
      },
      {
        filters: { pixivState: AuthorAccountFilter.disabled },
        expected: [1, 3, 8],
      },
      {
        filters: { pixivState: AuthorAccountFilter.unlinked },
        expected: [4, 6, 7, 9],
      },
      {
        filters: {
          xState: AuthorAccountFilter.enabled,
          pixivState: AuthorAccountFilter.disabled,
        },
        expected: [1],
      },
      {
        filters: {
          xState: AuthorAccountFilter.disabled,
          pixivState: AuthorAccountFilter.enabled,
        },
        expected: [2],
      },
      {
        filters: {
          xState: AuthorAccountFilter.enabled,
          pixivState: AuthorAccountFilter.unlinked,
        },
        expected: [4],
      },
      {
        filters: {
          xState: AuthorAccountFilter.unlinked,
          pixivState: AuthorAccountFilter.disabled,
        },
        expected: [8],
      },
      {
        filters: {
          xState: AuthorAccountFilter.unlinked,
          pixivState: AuthorAccountFilter.unlinked,
        },
        expected: [6, 9],
      },
      {
        filters: {
          xState: AuthorAccountFilter.disabled,
          pixivState: AuthorAccountFilter.linked,
        },
        expected: [2, 3],
      },
      {
        filters: { xState: AuthorAccountFilter.unlinked, platform: "x" },
        expected: [],
      },
    ];
    for (const { filters, expected } of cases) {
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await authors.list({
          tag: prefix,
          authorizationStatus: "authorized",
          limit: 2,
          ...filters,
          cursor,
        });
        assert.equal(page.total, expected.length, JSON.stringify(filters));
        assert(page.items.length <= 2);
        assert(!JSON.stringify(page).includes("private"));
        for (const author of page.items) {
          const state = states[ids.indexOf(author.id)];
          assert.equal(
            author.externalAccounts.length,
            state.filter((value) => value !== null).length,
          );
          for (const account of author.externalAccounts) {
            assert.deepEqual(Object.keys(account).sort(), [
              "avatarAvailable",
              "displayNameSnapshot",
              "externalUserId",
              "fetchEnabled",
              "handle",
              "id",
              "platform",
              "profileUrl",
            ]);
            assert.equal(
              account.fetchEnabled,
              state[account.platform === "x" ? 0 : 1],
            );
          }
        }
        found.push(...page.items.map((author) => author.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(
        found,
        expected.map((index) => ids[index]),
        JSON.stringify(filters),
      );
      assert.equal(new Set(found).size, found.length);
    }
    const options = {
      tag: prefix,
      xState: AuthorAccountFilter.linked,
      pixivState: AuthorAccountFilter.linked,
      limit: 1,
    };
    const first = await authors.list(options);
    assert(first.nextCursor);
    for (const changed of [
      { xState: undefined },
      { xState: AuthorAccountFilter.enabled },
      { pixivState: undefined },
      { pixivState: AuthorAccountFilter.disabled },
    ])
      await assert.rejects(
        authors.list({ ...options, ...changed, cursor: first.nextCursor }),
      );
    const empty = await authors.list({
      tag: prefix,
      xState: AuthorAccountFilter.unlinked,
      pixivState: AuthorAccountFilter.enabled,
      search: "no such author",
    });
    assert.deepEqual(empty, { items: [], total: 0, nextCursor: null });
  } finally {
    await db.sourceAdapterState.deleteMany({
      where: { externalAccount: { authorId: { in: ids } } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: ids } },
    });
    await db.authorTag.deleteMany({ where: { authorId: { in: ids } } });
    await db.author.deleteMany({ where: { id: { in: ids } } });
    await db.tag.deleteMany({ where: { id: tagId } });
    await db.$disconnect();
  }
});
