export interface ThemePreset {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly style: string;
}
export interface ThemePackMetadata {
  readonly id: string;
  readonly preview: boolean;
  readonly presets: readonly ThemePreset[];
}
export interface ThemeCatalog {
  readonly packIds: readonly string[];
  readonly presets: readonly ThemePreset[];
  readonly presetIds: readonly string[];
  readonly styleIds: readonly string[];
  readonly resolvePresetId: (id: string) => string;
}
export const defaultThemePack: ThemePackMetadata;
export const installedThemePacks: readonly ThemePackMetadata[];
export function createThemeCatalog(
  packs: readonly ThemePackMetadata[],
): ThemeCatalog;
export const themeCatalog: ThemeCatalog;
