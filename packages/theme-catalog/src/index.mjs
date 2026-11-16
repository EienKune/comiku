import { installedThemePacks } from "./installed.mjs";
export { installedThemePacks } from "./installed.mjs";
export { defaultThemePack } from "./default.mjs";

export function createThemeCatalog(packs) {
  const ids = new Set();
  const packIds = new Set();
  const presets = [];
  for (const pack of packs) {
    if (!/^[a-z][a-z0-9-]*$/.test(pack.id) || packIds.has(pack.id))
      throw new Error("Invalid or duplicate theme pack");
    packIds.add(pack.id);
    for (const preset of pack.presets) {
      if (
        !/^[a-z][a-z0-9-]*$/.test(preset.id) ||
        ids.has(preset.id) ||
        !/^[a-z][a-z0-9-]*$/.test(preset.style) ||
        !preset.name ||
        !/^#[a-f\d]{6}$/i.test(preset.brand)
      )
        throw new Error("Invalid or duplicate theme preset");
      ids.add(preset.id);
      presets.push(Object.freeze({ ...preset }));
    }
  }
  if (!packIds.has("default") || !ids.has("teal"))
    throw new Error("The default theme pack is required");
  return Object.freeze({
    packIds: Object.freeze([...packIds]),
    presets: Object.freeze(presets),
    presetIds: Object.freeze(presets.map((preset) => preset.id)),
    styleIds: Object.freeze([
      ...new Set(presets.map((preset) => preset.style)),
    ]),
    resolvePresetId: (id) => (ids.has(id) ? id : "teal"),
  });
}

export const themeCatalog = createThemeCatalog(installedThemePacks);
