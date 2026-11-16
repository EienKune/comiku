import type { Plugin } from "vite";
import { installedThemePacks } from "@comiku/theme-catalog";

/** Only registered modules enter the build; no glob or runtime plugin download. */
export function themePacksPlugin(): Plugin {
  const runtime = "virtual:comiku-theme-packs";
  const previews = "virtual:comiku-theme-previews";
  return {
    name: "comiku-theme-packs",
    resolveId(id) {
      if (id === runtime || id === previews) return `\0${id}`;
    },
    load(id) {
      if (id === `\0${runtime}`) {
        return (
          installedThemePacks
            .map(
              (pack, index) =>
                `import { themePack as p${index} } from "/src/themes/packs/${pack.id}/index.ts";`,
            )
            .join("\n") +
          `\nexport const themePacks = [${installedThemePacks.map((_, index) => `p${index}`).join(",")}];`
        );
      }
      if (id === `\0${previews}`)
        return installedThemePacks
          .filter((pack) => pack.preview)
          .map((pack) => `import "/src/themes/packs/${pack.id}/preview.css";`)
          .join("\n");
    },
  };
}
