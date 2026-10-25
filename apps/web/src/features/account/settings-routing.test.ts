import { expect, test } from "vitest";
import type { Location } from "react-router";
import { nextSettingsBackground, settingsLinkState } from "./settings-routing";
const origin: Location = {
  pathname: "/works",
  search: "?phase=typeset",
  hash: "",
  state: null,
  key: "work-page",
};
const settings: Location = {
  ...origin,
  pathname: "/settings",
  search: "?tab=profile",
  key: "modal",
  state: settingsLinkState(origin),
};
test("a settings modal retains the live origin across internal navigation", () => {
  expect(nextSettingsBackground(origin, settings, null)).toBe(origin);
  expect(
    nextSettingsBackground(
      settings,
      { ...settings, pathname: "/settings/password" },
      origin,
    ),
  ).toBe(origin);
  expect(nextSettingsBackground(settings, origin, origin)).toBeNull();
});
test("direct/refresh/external/stale backgrounds cannot invent a return destination", () => {
  expect(
    nextSettingsBackground(origin, { ...settings, state: null }, null),
  ).toBeNull();
  expect(nextSettingsBackground(settings, settings, null)).toBeNull();
  expect(
    nextSettingsBackground(
      origin,
      {
        ...settings,
        state: {
          settingsBackground: {
            ...origin,
            pathname: "https://other.invalid",
            key: "work-page",
          },
        },
      },
      null,
    ),
  ).toBeNull();
  expect(
    nextSettingsBackground(
      origin,
      {
        ...settings,
        state: settingsLinkState({ ...origin, key: "previous-session" }),
      },
      null,
    ),
  ).toBeNull();
});
