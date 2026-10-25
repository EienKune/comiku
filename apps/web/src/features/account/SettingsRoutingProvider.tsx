import { useLayoutEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  isPersonalSettings,
  nextSettingsBackground,
  SettingsRoutingContext,
} from "./settings-routing";

export function SettingsRoutingProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [routing, setRouting] = useState({
    location,
    background: null as ReturnType<typeof nextSettingsBackground>,
    trigger: null as HTMLElement | null,
    returnFocus: null as HTMLElement | null,
    scroll: null as { x: number; y: number } | null,
    returnScroll: null as { x: number; y: number } | null,
  });
  if (routing.location !== location) {
    const opening =
      !isPersonalSettings(routing.location.pathname) &&
      isPersonalSettings(location.pathname);
    const closing =
      isPersonalSettings(routing.location.pathname) &&
      !isPersonalSettings(location.pathname);
    setRouting({
      location,
      background: nextSettingsBackground(
        routing.location,
        location,
        routing.background,
      ),
      trigger: opening
        ? document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
        : closing
          ? null
          : routing.trigger,
      returnFocus: closing ? routing.trigger : null,
      scroll: opening
        ? { x: window.scrollX, y: window.scrollY }
        : closing
          ? null
          : routing.scroll,
      returnScroll: closing && routing.background ? routing.scroll : null,
    });
  }
  useLayoutEffect(() => {
    if (routing.returnFocus?.isConnected)
      routing.returnFocus.focus({ preventScroll: true });
    if (routing.returnScroll)
      window.scrollTo(routing.returnScroll.x, routing.returnScroll.y);
  }, [routing.returnFocus, routing.returnScroll]);
  return (
    <SettingsRoutingContext.Provider
      value={{
        background: routing.background,
        close: () => {
          const background = routing.background;
          navigate(
            background
              ? background.pathname + background.search + background.hash
              : "/",
            {
              replace: true,
              state: background?.state ?? null,
              preventScrollReset: true,
            },
          );
        },
      }}
    >
      {children}
    </SettingsRoutingContext.Provider>
  );
}
