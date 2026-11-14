import { createContext, useContext, useState } from "react";
import { applyTheme } from "../../styles/theme";
import { defaultSite, type SiteSettings } from "./site-config";
import {
  loadThemeSelection,
  persistThemeSelection,
  resolveTheme,
  siteTheme,
  type ThemeSelection,
} from "./theme-selection";
export interface SiteContextValue {
  settings: SiteSettings;
  selection: ThemeSelection;
  selectTheme(next: ThemeSelection): void;
}
export const SiteContext = createContext<SiteContextValue | null>(null);
export const SitePreviewContext = createContext<{
  acquire(): () => void;
} | null>(null);
export function useSite(): SiteContextValue {
  const context = useContext(SiteContext);
  const [selection, setSelection] = useState(loadThemeSelection);
  return (
    context ?? {
      settings: defaultSite,
      selection,
      selectTheme(next) {
        persistThemeSelection(next);
        applyTheme(resolveTheme(next, siteTheme(defaultSite.themePresetId)), {
          persist: false,
        });
        setSelection(next);
      },
    }
  );
}
