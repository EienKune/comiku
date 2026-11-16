import {
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { applyTheme } from "../../styles/theme";
import { SiteContext, SitePreviewContext } from "./site-context";
import {
  defaultSite,
  fetchSite,
  readCachedSite,
  siteCacheKey,
  siteIconUrl,
  siteQueryKey,
} from "./site-config";
import {
  loadThemeSelection,
  persistThemeSelection,
  resolveTheme,
  siteTheme,
  themeSelectionKey,
  type ThemeSelection,
} from "./theme-selection";

export function SiteProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState(loadThemeSelection);
  const settings =
    useQuery({
      queryKey: siteQueryKey,
      queryFn: ({ signal }) => fetchSite(signal),
      initialData: readCachedSite,
      initialDataUpdatedAt: 0,
      staleTime: 60_000,
      retry: false,
    }).data ?? defaultSite;
  function selectTheme(next: ThemeSelection) {
    persistThemeSelection(next);
    setSelection(next);
  }
  const currentTheme = useRef(
    resolveTheme(selection, siteTheme(settings.themePresetId)),
  );
  const previewCount = useRef(0);
  const preview = useMemo(
    () => ({
      acquire() {
        previewCount.current += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          previewCount.current -= 1;
          if (!previewCount.current)
            applyTheme(currentTheme.current, { persist: false });
        };
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    currentTheme.current = resolveTheme(
      selection,
      siteTheme(settings.themePresetId),
    );
    if (!previewCount.current)
      applyTheme(currentTheme.current, { persist: false });
  }, [selection, settings.themePresetId]);
  useEffect(() => {
    document.title = settings.name;
    try {
      localStorage.setItem(siteCacheKey, JSON.stringify(settings));
    } catch {
      /* Browsing remains usable. */
    }
    const previous = document.getElementById("site-favicon");
    if (settings.iconVersion) {
      const link = (previous ??
        document.createElement("link")) as HTMLLinkElement;
      link.id = "site-favicon";
      link.rel = "icon";
      link.type = "image/png";
      link.href = siteIconUrl(settings.iconVersion, 32);
      if (!previous) document.head.append(link);
    } else previous?.remove();
  }, [settings]);
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === themeSelectionKey || event.key === null)
        setSelection(loadThemeSelection());
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  return (
    <SiteContext.Provider value={{ settings, selection, selectTheme }}>
      <SitePreviewContext.Provider value={preview}>
        {children}
      </SitePreviewContext.Provider>
    </SiteContext.Provider>
  );
}
