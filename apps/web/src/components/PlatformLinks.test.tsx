import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PlatformLinks } from "./PlatformLinks";
afterEach(cleanup);
test("derives platform links from identities and leaves absent accounts disabled", () => {
  const { rerender } = render(
    <PlatformLinks
      accounts={[
        { platform: "x", handle: "@artist_name", externalUserId: "999" },
        { platform: "pixiv", handle: "nickname", externalUserId: "123" },
      ]}
    />,
  );
  const x = screen.getByRole("link", { name: "打开 X @artist_name" });
  expect(x.getAttribute("href")).toBe("https://x.com/artist_name");
  expect(x.getAttribute("target")).toBe("_blank");
  expect(
    screen.getByRole("link", { name: "打开 Pixiv 123" }).getAttribute("href"),
  ).toBe("https://www.pixiv.net/users/123");
  rerender(<PlatformLinks accounts={[]} />);
  expect(
    (screen.getByRole("button", { name: "未关联 X" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  rerender(
    <PlatformLinks
      accounts={[{ platform: "pixiv", handle: "name", externalUserId: "123" }]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "未关联 X" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("link", { name: "打开 Pixiv 123" }).getAttribute("href"),
  ).toBe("https://www.pixiv.net/users/123");
  rerender(
    <PlatformLinks
      accounts={[{ platform: "x", handle: null, externalUserId: "999" }]}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "X 已关联，缺少生成链接的账号信息" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
