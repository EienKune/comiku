import type { ThemePack } from "../../registry";

import { minimalDarkTokens, tealDarkTokens } from "./tokens";
import "./runtime.css";

export const themePack: ThemePack = {
  id: "default",
  definitions: [
    { style: "soft" },
    { style: "minimal" },
    { style: "minimal-dark", tokens: minimalDarkTokens },
    { style: "teal-dark", tokens: tealDarkTokens },
  ],
};
