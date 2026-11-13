import type { components } from "@comiku/api-client";
import { Button } from "../../components/ui";

export function BirthdaySettingsConflict({
  conflict,
  comparison,
  onCompare,
  onAdopt,
}: {
  conflict: boolean;
  comparison: components["schemas"]["BirthdaySettingsDto"] | null;
  onCompare: () => void;
  onAdopt: () => void;
}) {
  if (!conflict) return null;
  return (
    <div className="birthday-settings-conflict">
      <p>设置已由其他管理员更新，草稿仍保留。</p>
      <Button type="button" variant="secondary" onClick={onCompare}>
        核对当前设置
      </Button>
      {comparison && (
        <>
          <p>
            当前版本：工作台{comparison.displayEnabled ? "开启" : "关闭"}，提醒
            {comparison.remindersEnabled ? "开启" : "关闭"}，
            {comparison.sendTime}，提前 {comparison.offsetDays.join("、")} 天。
          </p>
          <Button type="button" variant="secondary" onClick={onAdopt}>
            保留草稿并采用当前版本
          </Button>
        </>
      )}
    </div>
  );
}
