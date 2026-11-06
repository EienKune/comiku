import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { authorQuery, authorCursor } from "../src/authors/author-query.js";
import { AuthorQueryDto } from "../src/authors/authors.dto.js";

const id = "00000000-0000-4000-8000-000000000001";
test("account filter query validation accepts only the four explicit states", () => {
  for (const property of ["xState", "pixivState"]) {
    for (const value of [
      undefined,
      "linked",
      "enabled",
      "disabled",
      "unlinked",
    ]) {
      const dto = plainToInstance(AuthorQueryDto, { [property]: value });
      assert.deepEqual(validateSync(dto), []);
    }
    for (const value of [
      "all",
      "",
      "ENABLED",
      true,
      ["enabled"],
      "enabled OR true",
    ]) {
      const dto = plainToInstance(AuthorQueryDto, { [property]: value });
      assert(validateSync(dto).some((error) => error.property === property));
    }
  }
});

test("author cursors bind each platform account state independently", () => {
  const query = Object.assign(new AuthorQueryDto(), {
    xState: "enabled",
    pixivState: "disabled",
  });
  const cursor = authorCursor(authorQuery(query).scope, {
    id,
    name: "作者",
    rank: 3,
  });
  assert.doesNotThrow(() => authorQuery({ ...query, cursor, limit: 1 }));
  for (const changed of [
    { xState: undefined },
    { xState: "disabled" },
    { pixivState: undefined },
    { pixivState: "enabled" },
  ]) {
    assert.throws(() =>
      authorQuery(
        Object.assign(new AuthorQueryDto(), query, changed, { cursor }),
      ),
    );
  }
});

test("both account filters are applied inside active platform predicates for page and count", () => {
  for (const query of [
    { xState: "enabled", pixivState: "disabled" },
    { xState: "disabled", pixivState: "enabled" },
  ]) {
    const plan = authorQuery(Object.assign(new AuthorQueryDto(), query));
    for (const sql of [plan.page, plan.count]) {
      assert.equal((sql.text.match(/e\.fetch_enabled = /g) ?? []).length, 2);
      assert.equal((sql.text.match(/e\.deleted_at IS NULL/g) ?? []).length, 2);
      assert.deepEqual(sql.values.slice(0, 4), [
        "x",
        query.xState === "enabled",
        "pixiv",
        query.pixivState === "enabled",
      ]);
    }
  }
  const linked = authorQuery(
    Object.assign(new AuthorQueryDto(), {
      xState: "linked",
      pixivState: "unlinked",
    }),
  );
  assert.match(
    linked.count.text,
    /AND EXISTS \(SELECT 1 FROM author_external_accounts/,
  );
  assert.match(
    linked.count.text,
    /AND NOT EXISTS \(SELECT 1 FROM author_external_accounts/,
  );
  assert(!linked.count.text.includes("fetch_enabled"));
});

test("author keyset binds normalized filters and validates hostile cursors", () => {
  const first = authorQuery({ search: " @Artist ", platform: "X", limit: 2 });
  const cursor = authorCursor(first.scope, { id, name: "作者", rank: 1 });
  const next = authorQuery({
    search: "artist",
    platform: "x",
    limit: 20,
    cursor,
  });
  assert.equal(next.scope, first.scope);
  assert.match(next.page.text, /ORDER BY rank, name COLLATE "C", id/);
  assert.match(next.page.text, /LIMIT \$/);
  assert.equal(next.page.values.at(-1), 21);
  assert.throws(() => authorQuery({ search: "other", cursor }));
  for (const value of [
    "!",
    "e30",
    "a".repeat(1001),
    Buffer.from(
      JSON.stringify({ v: 1, scope: first.scope, id, name: null, rank: 0 }),
    ).toString("base64url"),
  ]) {
    assert.throws(() =>
      authorQuery({ search: "artist", platform: "x", cursor: value }),
    );
  }
});
test("author search escapes LIKE metacharacters and includes Pixiv stable ID", () => {
  const query = authorQuery({
    search: "a%_\\' OR true --",
    authorizationStatus: "authorized",
    tag: " Tag ",
  });
  assert.match(query.page.text, /external_user_id/);
  assert.match(query.page.text, /author_tags/);
  assert.equal(query.page.text.includes("OR true --"), false);
  assert(
    query.page.values.some((value) => value === "%a\\%\\_\\\\' or true --%"),
  );
  assert.equal(authorQuery({ limit: 100 }).page.values.at(-1), 101);
  for (const limit of [0, 101, NaN, 1.5])
    assert.throws(() => authorQuery({ limit }));
});

test("cursor supports PostgreSQL character limits for astral names and rejects malformed Unicode", () => {
  const scope = authorQuery({}).scope;
  const name = "😀".repeat(100);
  assert.doesNotThrow(() =>
    authorQuery({ cursor: authorCursor(scope, { id, name, rank: 3 }) }),
  );
  assert.throws(() =>
    authorQuery({
      cursor: authorCursor(scope, { id, name: "\ud800", rank: 3 }),
    }),
  );
  assert.throws(() =>
    authorQuery({
      cursor: authorCursor(scope, { id, name: name + "a", rank: 3 }),
    }),
  );
});
