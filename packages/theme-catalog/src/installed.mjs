import { defaultThemePack } from "./default.mjs";
import { baThemePack } from "./ba.mjs";

// This is the build composition shared by API, worker and web.
export const installedThemePacks = [defaultThemePack, baThemePack];
