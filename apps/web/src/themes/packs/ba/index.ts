import type { ThemePack } from "../../registry";
import { baThemeStyles, themeProfileTokens } from "./tokens";
import "./runtime.css";

export const themePack: ThemePack = {
  id: "ba",
  definitions: baThemeStyles.map((style) => {
    const tokens = themeProfileTokens[style];
    return {
      style,
      tokens,
      actionColors: {
        background: tokens["--ba-action-bg"],
        foreground: tokens["--ba-action-text"],
        hoverBackground: tokens["--ba-action-hover"],
        hoverForeground: tokens["--ba-action-text-hover"],
      },
    };
  }),
};
