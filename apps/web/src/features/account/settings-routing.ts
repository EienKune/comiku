import { createContext, useContext } from "react";
import type { Location } from "react-router";

export const isPersonalSettings = (path: string) =>
  path === "/settings" || path === "/settings/password";
const validBackgroundPath = (path: string) =>
  path === "/" ||
  /^\/(?:works|authors|candidates|members|reviews|audit)(?:\/[^/?#]+)?(?:\/editor)?$/.test(
    path,
  ) ||
  path === "/settings/users" ||
  path === "/settings/system";

export function settingsLinkState(location: Location) {
  return {
    settingsBackground: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      key: location.key,
    },
  };
}
// A history-state address is only accepted when it is the page mounted in this session.
// Refreshing a settings URL intentionally starts without a live background.
export function nextSettingsBackground(
  previous: Location,
  current: Location,
  background: Location | null,
): Location | null {
  if (!isPersonalSettings(current.pathname)) return null;
  if (isPersonalSettings(previous.pathname)) return background;
  const candidate = (
    current.state as { settingsBackground?: Partial<Location> } | null
  )?.settingsBackground;
  return candidate &&
    validBackgroundPath(previous.pathname) &&
    candidate.pathname === previous.pathname &&
    candidate.search === previous.search &&
    candidate.hash === previous.hash &&
    candidate.key === previous.key
    ? previous
    : null;
}
export const SettingsRoutingContext = createContext<{
  background: Location | null;
  close: () => void;
}>({ background: null, close: () => undefined });
export const useSettingsNavigation = () => useContext(SettingsRoutingContext);
