import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { PlatformLinks } from "./PlatformLinks";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("recomputes the available account budget on resize and preserves a truncated long identity", () => {
  let width = 320;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const measured = this.hasAttribute("data-account-measure");
      const measuredWidth = measured
        ? this.querySelector("[data-measure-label]")
            ?.getAttribute("data-measure-label")
            ?.includes("long")
          ? 160
          : 62
        : this.hasAttribute("data-more-measure")
          ? 36
          : this.classList.contains("platform-account-rail")
            ? width
            : 0;
      return {
        width: measuredWidth,
        height: 32,
        left: 0,
        right: measuredWidth,
        top: 0,
        bottom: 32,
        x: 0,
        y: 0,
        toJSON() {},
      };
    },
  );
  const accounts = ["a_very_long_account_identity", "two", "three"].map(
    (handle, i) => ({
      platform: "x",
      handle,
      externalUserId: String(i),
      fetchEnabled: i === 0,
    }),
  );
  render(<PlatformLinks variant="accounts" accounts={accounts} />);
  expect(screen.getAllByRole("link")).toHaveLength(3);
  width = 190;
  fireEvent(window, new Event("resize"));
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(
    screen.getByRole("link", {
      name: /打开 X @a_very_long_account_identity.*采集已开启/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "查看全部 X 账号（3）" }).textContent,
  ).toBe("+2");
  width = 320;
  fireEvent(window, new Event("resize"));
  expect(screen.getAllByRole("link")).toHaveLength(3);
});
test("same-platform accounts retain independent links and states, with keyboard-accessible overflow", () => {
  render(
    <PlatformLinks
      variant="accounts"
      accounts={Array.from({ length: 10 }, (_, i) => ({
        platform: "x",
        handle: `artist_${i}`,
        externalUserId: `${i}`,
        fetchEnabled: i % 2 === 0,
      }))}
    />,
  );
  expect(
    screen.getByRole("link", { name: /打开 X @artist_0.*采集已开启/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /打开 X @artist_1.*采集已关闭/ }),
  ).toBeTruthy();
  const more = screen.getByRole("button", { name: /查看全部 X 账号/ });
  fireEvent.click(more);
  const dialog = screen.getByRole("dialog", { name: "X 账号" });
  expect(within(dialog).getAllByRole("link")).toHaveLength(10);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(more);
});
test("icon presentation expands multiple accounts instead of choosing the first", () => {
  render(
    <PlatformLinks
      accounts={[
        { platform: "x", handle: "one", externalUserId: "1" },
        { platform: "x", handle: "two", externalUserId: "2" },
      ]}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看全部 X 账号（2）" }));
  expect(
    screen.getByRole("link", { name: /打开 X @two/ }).getAttribute("href"),
  ).toBe("https://x.com/two");
});
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
