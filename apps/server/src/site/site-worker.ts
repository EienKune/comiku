import { setTimeout as delay } from "node:timers/promises";
import type { SiteIconService } from "./site-icon.service.js";

export async function runSiteMaintenance(
  icons: Pick<SiteIconService, "cleanup">,
  signal: AbortSignal,
  wait = (ms: number) => delay(ms, undefined, { signal }),
) {
  while (!signal.aborted) {
    try {
      await icons.cleanup();
    } catch {
      console.error("站点图标维护未完成，将在下一轮恢复。");
    }
    await wait(60_000).catch(() => {});
  }
}
