import { expect, test } from "vitest";
import { sourceAccountLabel } from "./source-account-label";
test("actual platform identity is shown for Pixiv and an X account without a handle", () => {
  expect(
    sourceAccountLabel("pixiv", { handle: null, externalUserId: "123" }),
  ).toBe("123");
  expect(
    sourceAccountLabel("x", { handle: "alternate", externalUserId: "456" }),
  ).toBe("@alternate");
  expect(sourceAccountLabel("x", { handle: null, externalUserId: "456" })).toBe(
    "456",
  );
  expect(sourceAccountLabel("x", null)).toBe("来源账号未知");
  expect(sourceAccountLabel("manual", null)).toBe("手动上传");
});
