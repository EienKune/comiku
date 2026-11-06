import { SelectField } from "../../components/ui";
import type { CollectionSettings, FirstSyncMode } from "./author-collection";

const labels: Record<FirstSyncMode, string> = {
  none: "仅后续内容",
  last_24_hours: "最近 24 小时",
  last_7_days: "最近 7 天",
};

export function AuthorCollectionFields({
  value,
  modes,
  onChange,
  disabled = false,
  prefix = "",
}: {
  value: CollectionSettings;
  modes: FirstSyncMode[];
  onChange: (value: CollectionSettings) => void;
  disabled?: boolean;
  prefix?: string;
}) {
  if (!modes.length && !value.fetchEnabled && value.firstSyncMode === "none")
    return null;
  const supported = modes.includes(value.firstSyncMode);
  return (
    <>
      <label className="account-checkbox workspace-author-collection-checkbox">
        <input
          type="checkbox"
          checked={value.fetchEnabled}
          disabled={disabled || (!value.fetchEnabled && !supported)}
          onChange={(event) =>
            onChange({ ...value, fetchEnabled: event.target.checked })
          }
        />
        {prefix}启用自动抓取
      </label>
      <SelectField
        label={`${prefix}首次同步范围`}
        value={value.firstSyncMode}
        disabled={disabled || (!modes.length && value.fetchEnabled)}
        onValueChange={(firstSyncMode) =>
          onChange({ ...value, firstSyncMode: firstSyncMode as FirstSyncMode })
        }
      >
        {!supported &&
          (value.fetchEnabled || value.firstSyncMode !== "none") && (
            <option value={value.firstSyncMode} disabled>
              {labels[value.firstSyncMode]}（当前不可用）
            </option>
          )}
        {(["none", "last_24_hours", "last_7_days"] as const)
          .filter(
            (mode) =>
              modes.includes(mode) || (mode === "none" && !value.fetchEnabled),
          )
          .map((mode) => (
            <option key={mode} value={mode}>
              {labels[mode]}
            </option>
          ))}
      </SelectField>
    </>
  );
}
