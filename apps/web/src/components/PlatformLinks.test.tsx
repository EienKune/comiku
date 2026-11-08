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

test("account rows keep disabled collection links usable and explain authorization separately", () => {
  render(
    <PlatformLinks
      variant="accounts"
      collectionBlockedReason="作者授权已过期，当前不会采集"
      accounts={[
        {
          platform: "x",
          handle: "artist",
          externalUserId: "999",
          fetchEnabled: true,
        },
        {
          platform: "pixiv",
          handle: null,
          externalUserId: "123",
          fetchEnabled: false,
        },
      ]}
    />,
  );
  expect(
    screen
      .getByRole("link", { name: /打开 X @artist.*采集已开启.*当前不会采集/ })
      .getAttribute("href"),
  ).toBe("https://x.com/artist");
  expect(
    screen
      .getByRole("link", { name: /打开 Pixiv 123.*采集已关闭/ })
      .getAttribute("href"),
  ).toBe("https://www.pixiv.net/users/123");
  expect(screen.getByText("123")).toBeTruthy();
  expect(screen.queryByText("Pixiv")).toBeNull();
});

test("account rows distinguish missing accounts from linked identities without a URL", () => {
  render(
    <PlatformLinks
      variant="accounts"
      accounts={[
        {
          platform: "x",
          handle: null,
          externalUserId: "999",
          fetchEnabled: false,
        },
      ]}
    />,
  );
  expect(
    screen.getByRole("button", {
      name: /X 已关联，缺少生成链接的账号信息.*采集已关闭/,
    }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "未关联 Pixiv" })).toBeTruthy();
  expect(screen.getByText("999")).toBeTruthy();
});
