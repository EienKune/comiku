import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteProvider } from "./SiteProvider";
import { SiteBrand } from "./SiteBrand";
import { useSite } from "./site-context";
import { client, queryClient, clearAccountCache } from "../account/api";
import { themeStorageKey } from "../../styles/theme";
import { defaultSite, siteCacheKey, siteQueryKey } from "./site-config";
import { siteTheme, themeSelectionKey } from "./theme-selection";
import { previewThemeStorageKey } from "./theme-selection";
import { ThemePreview } from "../../playground/ThemePreview";

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  localStorage.clear();
  document.getElementById("site-favicon")?.remove();
  document.documentElement.removeAttribute("style");
});

test("authentication cache clearing preserves the active public site observer only", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: defaultSite,
    response: new Response(),
  } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <SiteProvider>
        <Preferences />
      </SiteProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(queryClient.getQueryData(siteQueryKey)).toEqual(defaultSite),
  );
  const observed = queryClient.getQueryCache().find({ queryKey: siteQueryKey });
  queryClient.setQueryData(["me"], { id: "private-account" });
  queryClient.setQueryData(["site-settings"], { private: true });
  clearAccountCache();
  expect(queryClient.getQueryData(["me"])).toBeUndefined();
  expect(queryClient.getQueryData(["site-settings"])).toBeUndefined();
  expect(queryClient.getQueryCache().find({ queryKey: siteQueryKey })).toBe(
    observed,
  );
  await act(async () => {
    queryClient.setQueryData(siteQueryKey, {
      ...defaultSite,
      name: "登录后的品牌",
    });
  });
  await screen.findByText("登录后的品牌");
});

test.each(["sky", "schale", "archive", "shittim"])(
  "Playground exits to the latest active %s site theme",
  async (preset) => {
    localStorage.setItem(
      previewThemeStorageKey,
      JSON.stringify({ brand: "#a78bfa", style: "soft" }),
    );
    vi.spyOn(client, "GET").mockImplementation(() => new Promise(() => {}));
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (show: boolean) => (
      <QueryClientProvider client={cache}>
        <SiteProvider>
          {show ? <ThemePreview /> : <div>正常页面</div>}
        </SiteProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    expect(
      document.documentElement.style.getPropertyValue("--color-brand"),
    ).toBe("#a78bfa");
    await act(async () => {
      cache.setQueryData(siteQueryKey, {
        ...defaultSite,
        themePresetId: preset,
        revision: 1,
      });
    });
    expect(
      document.documentElement.style.getPropertyValue("--color-brand"),
    ).toBe("#a78bfa");
    view.rerender(tree(false));
    expect(
      document.documentElement.style.getPropertyValue("--color-brand"),
    ).toBe(siteTheme(preset).brand);
    expect(document.documentElement.dataset.themeStyle).toBe(
      siteTheme(preset).style,
    );
    expect(localStorage.getItem(themeSelectionKey)).toBeNull();
  },
);
function Preferences() {
  const site = useSite();
  return (
    <>
      <SiteBrand />
      <button onClick={() => site.selectTheme({ mode: "site" })}>跟随</button>
    </>
  );
}
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={cache}>
      <SiteProvider>
        <Preferences />
      </SiteProvider>
    </QueryClientProvider>,
  );
  return { cache, ...view };
}
test("root uses site settings without creating a personal preference and updates title/icon", async () => {
  const settings = {
    ...defaultSite,
    name: "团队站点",
    themePresetId: "sky",
    iconVersion: "11111111-1111-4111-8111-111111111111",
    revision: 1,
  };
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue({ data: settings, response: new Response() } as never);
  const { cache, rerender } = mount();
  await screen.findByText("团队站点");
  expect(document.title).toBe("团队站点");
  expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
    "#5599ff",
  );
  expect(localStorage.getItem(themeStorageKey)).toBeNull();
  expect(localStorage.getItem(themeSelectionKey)).toBeNull();
  expect(
    document.getElementById("site-favicon")?.getAttribute("href"),
  ).toContain("/32");
  fireEvent.error(document.querySelector(".site-brand-image")!);
  expect(document.querySelector(".site-brand-image")).toBeNull();
  cache.setQueryData(siteQueryKey, {
    ...settings,
    name: "新名称",
    iconVersion: null,
  });
  await screen.findByText("新名称");
  expect(document.getElementById("site-favicon")).toBeNull();
  rerender(
    <QueryClientProvider client={cache}>
      <SiteProvider>
        <Preferences />
      </SiteProvider>
    </QueryClientProvider>,
  );
  expect(get).toHaveBeenCalledTimes(1);
});
test("legacy personal choice survives site defaults; explicit follow does not erase legacy", async () => {
  const legacy = JSON.stringify({ brand: "#abcdef", style: "minimal" });
  localStorage.setItem(themeStorageKey, legacy);
  vi.spyOn(client, "GET").mockResolvedValue({
    data: { ...defaultSite, themePresetId: "pink" },
    response: new Response(),
  } as never);
  mount();
  await waitFor(() =>
    expect(localStorage.getItem(siteCacheKey)).toContain("pink"),
  );
  expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
    "#abcdef",
  );
  fireEvent.click(screen.getByRole("button", { name: "跟随" }));
  expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
    "#ff6699",
  );
  expect(localStorage.getItem(themeStorageKey)).toBe(legacy);
});
test("configuration errors and blocked browser storage leave the page usable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(client, "GET").mockRejectedValue(new Error("offline"));
  const { cache } = mount();
  expect(screen.getByText("Comiku")).toBeTruthy();
  await waitFor(() =>
    expect(cache.getQueryState(siteQueryKey)?.status).toBe("error"),
  );
  fireEvent.click(screen.getByRole("button", { name: "跟随" }));
  expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
    "#33ccbb",
  );
});
