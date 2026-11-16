import { themeCatalog, type ThemeCatalog } from "@comiku/theme-catalog";
import { themePacks } from "virtual:comiku-theme-packs";

export interface ThemeDefinition {
  readonly style: string;
  readonly tokens?: Readonly<Record<string, string>>;
  readonly actionColors?: {
    background: string;
    foreground: string;
    hoverBackground: string;
    hoverForeground: string;
  };
}
export interface ThemePack {
  readonly id: string;
  readonly definitions: readonly ThemeDefinition[];
}
export function createThemeRegistry(
  catalog: ThemeCatalog,
  packs: readonly ThemePack[],
) {
  if (
    packs.length !== catalog.packIds.length ||
    packs.some((pack) => !catalog.packIds.includes(pack.id)) ||
    new Set(packs.map((pack) => pack.id)).size !== packs.length
  )
    throw new Error("Theme pack metadata and browser modules disagree");
  const definitions = new Map<string, ThemeDefinition>();
  for (const pack of packs)
    for (const definition of pack.definitions) {
      if (definitions.has(definition.style))
        throw new Error("Duplicate theme style");
      definitions.set(definition.style, definition);
    }
  if (
    catalog.styleIds.some((style) => !definitions.has(style)) ||
    [...definitions.keys()].some((style) => !catalog.styleIds.includes(style))
  )
    throw new Error("Theme metadata and browser modules disagree");
  return {
    presets: catalog.presets,
    hasStyle: (style: unknown): style is string =>
      typeof style === "string" && definitions.has(style),
    definition: (style: string) => definitions.get(style),
    tokenKeys: [
      ...new Set(
        [...definitions.values()].flatMap((definition) =>
          Object.keys(definition.tokens ?? {}),
        ),
      ),
    ],
    preset: (id: string) =>
      catalog.presets.find(
        (preset) => preset.id === catalog.resolvePresetId(id),
      )!,
  };
}
export const themeRegistry = createThemeRegistry(themeCatalog, themePacks);
