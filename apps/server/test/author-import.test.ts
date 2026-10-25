import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHOR_IMPORT_TEMPLATE,
  parseAuthorImportCsv,
} from "../src/authors/author-import.js";

test("author CSV template is portable and parser preserves quoted values", () => {
  assert.equal(AUTHOR_IMPORT_TEMPLATE.charCodeAt(0), 0xfeff);
  const csv = Buffer.from(
    `${AUTHOR_IMPORT_TEMPLATE}"作者,一",ja,authorized,原创|短篇,@fixture,42,123,https://www.pixiv.net/users/123\r\n`,
  );
  assert.deepEqual(parseAuthorImportCsv(csv), [
    {
      row: 2,
      displayName: "作者,一",
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tagNames: ["原创", "短篇"],
      xHandle: "@fixture",
      xExternalUserId: "42",
      xDisplayName: null,
      xProfileUrl: null,
      xAvatarFileObjectId: null,
      xProfileSyncAdapter: null,
      xProfileSyncedAt: null,
      pixivUserId: "123",
      pixivProfileUrl: "https://www.pixiv.net/users/123",
    },
  ]);
});

test("author CSV parser rejects stale columns and malformed quotes", () => {
  assert.throws(
    () => parseAuthorImportCsv(Buffer.from("name,language\n作者,ja\n")),
    /模板不一致/,
  );
  assert.throws(
    () => parseAuthorImportCsv(Buffer.from(`${AUTHOR_IMPORT_TEMPLATE}"作者`)),
    /未闭合引号/,
  );
});
