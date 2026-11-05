import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { authorQuery, authorCursor } from "../src/authors/author-query.js";

const id = "00000000-0000-4000-8000-000000000001";
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
