import { expect, test } from "vitest";
import { parseSourceSelection, sourceQuery } from "./source-filter-state";

const accountId = "11111111-1111-4111-8111-111111111111";
test("source selection maps one explicit scope without adding defaults", () => {
  expect(sourceQuery("all")).toEqual({});
  expect(sourceQuery(`account:${accountId}`)).toEqual({
    sourceAccountId: accountId,
  });
});
test("malformed or unrelated URL scopes safely return to all sources", () => {
  for (const value of [
    null,
    "",
    "x",
    "platform:manual",
    "account:broken",
    "account:1111",
    "all&sourceUnbound=true",
    "platform:x",
    "platform:pixiv",
    "manual",
    "unbound",
  ])
    expect(parseSourceSelection(value)).toBe("all");
  expect(parseSourceSelection(`account:${accountId}`)).toBe(
    `account:${accountId}`,
  );
});
