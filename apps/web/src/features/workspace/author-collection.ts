import { useState } from "react";
import type { components } from "@comiku/api-client";

type Capability = components["schemas"]["SourceCapabilityDto"];
export type FirstSyncMode =
  components["schemas"]["ExternalAccountDto"]["firstSyncMode"];
export type CollectionSettings = {
  fetchEnabled: boolean;
  firstSyncMode: FirstSyncMode;
};

export function useAuthorCollection(
  platform: "x" | "pixiv",
  capabilities: Capability[] | undefined,
  initial?: CollectionSettings,
) {
  const modes = [
    ...new Set(
      (capabilities ?? [])
        .filter((source) => source.platform === platform && source.available)
        .flatMap((source) => source.supportedFirstSyncModes),
    ),
  ];
  const [choice, setChoice] = useState<CollectionSettings | null>(
    initial
      ? {
          fetchEnabled: initial.fetchEnabled,
          firstSyncMode: initial.firstSyncMode,
        }
      : null,
  );
  // Only untouched new accounts follow asynchronously arriving capabilities.
  const value = choice ?? {
    fetchEnabled: modes.length > 0,
    firstSyncMode: modes.includes("last_24_hours")
      ? "last_24_hours"
      : (modes[0] ?? "none"),
  };
  return {
    value,
    modes,
    change: (next: CollectionSettings) => setChoice(next),
    freeze: () => setChoice(value),
    validate: () => {
      const changed =
        (value.fetchEnabled && !initial?.fetchEnabled) ||
        value.firstSyncMode !== (initial?.firstSyncMode ?? "none");
      if (
        changed &&
        (value.fetchEnabled || value.firstSyncMode !== "none") &&
        !modes.includes(value.firstSyncMode)
      )
        throw new Error("当前没有支持所选首次同步范围的可用抓取通道");
    },
  };
}
